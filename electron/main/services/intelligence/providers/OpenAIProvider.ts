import OpenAI from 'openai'
import { OllamaModelManager } from '../OllamaModelManager'
import { getConfig } from '@electron/utils/config'
import { BaseLLMProvider, type LLMMessage, type GenerationConfig } from './BaseLLMProvider'
import type { StreamChunk } from './GeminiProvider'
import { createLogger } from '@electron/utils/logger'

const log = createLogger('OpenAIProvider')

/**
 * OpenAIProvider — OpenAI-compatible API integration.
 *
 * Works with any server exposing the OpenAI chat completions API:
 * LMStudio, Ollama, vLLM, text-generation-webui, or OpenAI itself.
 *
 * Uses the official `openai` npm package. The `baseURL` can be
 * customized to point to any compatible endpoint.
 */
export class OpenAIProvider extends BaseLLMProvider {
  readonly name = 'openai'

  private client: OpenAI
  private model: string
  private activeController: AbortController | null = null

  /** Abort any in-flight completion request */
  abort(): void {
    if (this.activeController) {
      log.info(`[Ollama/OpenAI] Aborting active generation for model: ${this.model}`)
      this.activeController.abort()
      this.activeController = null
    }
  }

  constructor(apiKey: string, model: string, baseURL?: string) {
    super()
    let endpoint = (baseURL || 'http://127.0.0.1:11434/v1').trim().replace(/\/+$/, '').replace('://localhost', '://127.0.0.1')
    if (!endpoint.endsWith('/v1') && !endpoint.includes('/v1/')) {
      endpoint += '/v1'
    }
    this.client = new OpenAI({
      apiKey: apiKey || 'ollama',
      baseURL: endpoint,
      dangerouslyAllowBrowser: false,
    })
    this.model = model
    log.info(`Initialized with model: ${model}, baseURL: ${endpoint}`)
  }

  /** Convert our LLMMessage[] to OpenAI ChatCompletionMessageParam[], optionally prepending a system message */
  private toMessages(messages: LLMMessage[], systemInstruction?: string): OpenAI.Chat.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = []
    const isOllama = this.client.baseURL.includes('11434') || this.client.baseURL.includes('ollama')

    let effectiveSystem = systemInstruction || ''
    if (isOllama) {
      const ollamaDirectives = 'Respond directly and concisely. Do NOT output <think> tags or verbose chain-of-thought.'
      effectiveSystem = effectiveSystem ? `${effectiveSystem}\n\n${ollamaDirectives}` : ollamaDirectives
    }

    // Use native system role for system prompt (proper OpenAI approach)
    if (effectiveSystem) {
      result.push({ role: 'system', content: effectiveSystem })
    }

    for (const m of messages) {
      result.push({
        role: m.role === 'model' ? ('assistant' as const) : ('user' as const),
        content: m.text,
      })
    }

    return result
  }

  /** Map GenerationConfig to OpenAI params (topK not supported) */
  private toOpenAIParams(config?: GenerationConfig) {
    const isOllama = this.client.baseURL.includes('11434') || this.client.baseURL.includes('ollama')
    const params: Record<string, any> = {}
    if (config) {
      if (config.temperature !== undefined) params.temperature = config.temperature
      if (config.topP !== undefined) params.top_p = config.topP
      if (config.maxOutputTokens !== undefined) params.max_tokens = config.maxOutputTokens
    }
    if (isOllama) {
      if (params.temperature === undefined) {
        params.temperature = 0.1
      }
      const ctxSize = (getConfig().llm as any).ollamaContextSize ?? 8192
      params.num_ctx = ctxSize
      params.options = { ...(params.options || {}), num_ctx: ctxSize }
    }
    return params
  }

  async chat(messages: LLMMessage[], config?: GenerationConfig, systemInstruction?: string, _cachedContent?: string): Promise<string> {
    const isOllama = this.client.baseURL.includes('11434') || this.client.baseURL.includes('ollama')
    const lastUserMsg = messages[messages.length - 1]?.text || ''
    log.debug(`chat() with ${messages.length} message(s)`)
    const t0 = Date.now()

    if (isOllama) {
      log.info(`[${this.model}] Prompt: "${lastUserMsg.slice(0, 60).replace(/\n/g, ' ')}..."`)
      // Route through centralized queue to guarantee concurrency = 1
      return OllamaModelManager.getInstance().enqueue(`chat:${lastUserMsg.slice(0, 40)}`, async (signal) => {
        this.activeController = new AbortController()
        // Propagate manager cancellation signal to internal controller
        signal.addEventListener('abort', () => this.activeController?.abort(), { once: true })
        try {
          const response = await this.client.chat.completions.create({
            model: this.model,
            messages: this.toMessages(messages, systemInstruction),
            ...this.toOpenAIParams(config),
          }, { signal: this.activeController.signal })

          let text = response.choices[0]?.message?.content ?? ''
          text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

          const usage = response.usage
          const durationMs = Date.now() - t0
          OllamaModelManager.getInstance().recordInferenceMetrics(usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0, durationMs)
          log.info(`[${this.model}] Response (${Math.round(durationMs / 100) / 10}s): "${text.slice(0, 80).replace(/\n/g, ' ')}..."`)
          return text
        } catch (err: any) {
          if (err?.name === 'AbortError' || signal.aborted) throw err
          // Detect OOM / VRAM errors and surface helpful message
          const msg = err?.message || ''
          if (/out of memory|cuda|VRAM|memory/i.test(msg)) {
            log.error(`[Ollama] Out of VRAM loading ${this.model}: ${msg}`)
            throw new Error(`Ollama ran out of GPU memory loading "${this.model}". Try unloading the model in Settings, or switch to a smaller quantized model (e.g. qwen2.5vl:3b Q4_K_M).`)
          }
          throw err
        } finally {
          this.activeController = null
        }
      })
    }

    this.activeController = new AbortController()
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: this.toMessages(messages, systemInstruction),
        ...this.toOpenAIParams(config),
      }, { signal: this.activeController.signal })

      let text = response.choices[0]?.message?.content ?? ''
      text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      return text
    } finally {
      this.activeController = null
    }
  }

  async *stream(messages: LLMMessage[], config?: GenerationConfig, systemInstruction?: string, _cachedContent?: string): AsyncGenerator<string> {
    log.debug(`stream() with ${messages.length} message(s)`)
    this.activeController = new AbortController()

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: this.toMessages(messages, systemInstruction),
        stream: true,
        ...this.toOpenAIParams(config),
      }, { signal: this.activeController.signal })

      for await (const chunk of response) {
        if (this.activeController?.signal.aborted) break
        const text = chunk.choices[0]?.delta?.content
        if (text) yield text
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || this.activeController?.signal.aborted) {
        log.info(`[OpenAI/Ollama] Stream aborted for model: ${this.model}`)
        return
      }
      throw err
    } finally {
      this.activeController = null
    }
  }

  /**
   * Streaming with typed chunks.
   *
   * OpenAI-compatible APIs don't have a separate "thinking" mode,
   * so all chunks are emitted as `{ type: 'text' }`.
   */
  async *streamWithThoughts(messages: LLMMessage[], config?: GenerationConfig, systemInstruction?: string): AsyncGenerator<StreamChunk> {
    for await (const text of this.stream(messages, config, systemInstruction)) {
      yield { type: 'text', content: text }
    }
  }

  /**
   * Vision: image (PNG buffer) + text prompt.
   *
   * Uses the standard OpenAI vision API format with base64 image_url.
   * Works with models that support vision (e.g. llava, bakllava on LMStudio).
   */
  async vision(image: Buffer, prompt: string, config?: GenerationConfig): Promise<string> {
    const isOllama = this.client.baseURL.includes('11434') || this.client.baseURL.includes('ollama')
    log.debug(`vision() image=${image.length} bytes, prompt="${prompt.slice(0, 60)}..."`)

    const doVision = async (signal?: AbortSignal) => {
      this.activeController = new AbortController()
      if (signal) {
        signal.addEventListener('abort', () => this.activeController?.abort(), { once: true })
      }
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${image.toString('base64')}`,
                },
              },
              { type: 'text', text: prompt },
            ],
          }],
          ...this.toOpenAIParams(config),
        }, { signal: this.activeController.signal })

        const text = response.choices[0]?.message?.content ?? ''
        log.debug(`vision() response length: ${text.length}`)
        return text
      } finally {
        this.activeController = null
      }
    }

    if (isOllama) {
      return OllamaModelManager.getInstance().enqueue('vision:screenshot', (signal) => doVision(signal))
    }
    return doVision()
  }

  /**
   * Chat with vision: full conversation + screenshot on the last user message.
   *
   * Attaches the image as a base64 image_url content part to the last user message.
   */
  async chatWithVision(messages: LLMMessage[], image: Buffer, config?: GenerationConfig, systemInstruction?: string, _cachedContent?: string): Promise<string> {
    log.debug(`chatWithVision() ${messages.length} message(s), image=${image.length} bytes`)

    const sysMessages: OpenAI.Chat.ChatCompletionMessageParam[] = systemInstruction
      ? [{ role: 'system', content: systemInstruction }]
      : []

    const converted: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m, index) => {
      const isLastUser = m.role === 'user' && index === messages.length - 1

      if (isLastUser) {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'image_url' as const,
              image_url: {
                url: `data:image/jpeg;base64,${image.toString('base64')}`,
              },
            },
            { type: 'text' as const, text: m.text },
          ],
        }
      }

      return {
        role: m.role === 'model' ? ('assistant' as const) : ('user' as const),
        content: m.text,
      }
    })

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [...sysMessages, ...converted],
      ...this.toOpenAIParams(config),
    })

    const text = response.choices[0]?.message?.content ?? ''
    log.debug(`chatWithVision() response length: ${text.length}`)
    return text
  }

  /**
   * Structured output via OpenAI-compatible `response_format`.
   *
   * Uses `response_format: { type: 'json_schema' }` to constrain
   * the LLM output to a specific JSON schema.
   *
   * @param messages — conversation history
   * @param jsonSchema — JSON Schema object (from `z.toJSONSchema()`)
   * @param config — optional generation parameters
   * @param systemInstruction — optional system prompt
   * @returns Raw JSON string
   */
  async chatStructured(messages: LLMMessage[], jsonSchema: Record<string, unknown>, config?: GenerationConfig, systemInstruction?: string, _cachedContent?: string): Promise<string> {
    log.debug(`chatStructured() with ${messages.length} message(s)`)

    const isOllama = this.client.baseURL.includes('11434') || this.client.baseURL.includes('ollama')
    const lastUserMsg = messages[messages.length - 1]?.text || ''
    if (isOllama) {
      log.debug(`[${this.model}] Structured prompt: "${lastUserMsg.slice(0, 60).replace(/\n/g, ' ')}..."`)
      // Route through centralized queue for concurrency = 1
      return OllamaModelManager.getInstance().enqueue(`structured:${lastUserMsg.slice(0, 40)}`, async (signal) => {
        return this._chatStructuredCore(messages, jsonSchema, config, systemInstruction, signal)
      })
    }

    return this._chatStructuredCore(messages, jsonSchema, config, systemInstruction)
  }

  private async _chatStructuredCore(messages: LLMMessage[], jsonSchema: Record<string, unknown>, config?: GenerationConfig, systemInstruction?: string, managerSignal?: AbortSignal): Promise<string> {
    const isOllama = this.client.baseURL.includes('11434') || this.client.baseURL.includes('ollama')
    const lastUserMsg = messages[messages.length - 1]?.text || ''
    const t0 = Date.now()
    this.activeController = new AbortController()
    if (managerSignal) {
      managerSignal.addEventListener('abort', () => this.activeController?.abort(), { once: true })
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: this.toMessages(messages, systemInstruction),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'structured_output',
            strict: true,
            schema: jsonSchema,
          },
        } as OpenAI.Chat.ChatCompletionCreateParams['response_format'],
        ...this.toOpenAIParams(config),
      }, { signal: this.activeController.signal })

      let text = response.choices[0]?.message?.content ?? ''
      text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      if (isOllama) {
        log.debug(`[${this.model}] Structured response (${Date.now() - t0}ms): "${text.slice(0, 70).replace(/\n/g, ' ')}..."`)
      }
      return text
    } catch (err: unknown) {
      if ((err as any)?.name === 'AbortError') throw err
      log.warn(`chatStructured() json_schema failed (${(err as Error)?.message || err}), falling back to json_object format`)
      const fallbackInstruction = `${systemInstruction || ''}\n\nIMPORTANT: Output valid JSON only, strictly matching this schema: ${JSON.stringify(jsonSchema)}`
      const fallback = await this.client.chat.completions.create({
        model: this.model,
        messages: this.toMessages(messages, fallbackInstruction),
        response_format: { type: 'json_object' } as any,
        ...this.toOpenAIParams(config),
      }, { signal: this.activeController?.signal })
      let fallbackText = fallback.choices[0]?.message?.content ?? ''
      fallbackText = fallbackText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      if (isOllama) {
        log.debug(`[${this.model}] Structured fallback (${Date.now() - t0}ms): "${fallbackText.slice(0, 70).replace(/\n/g, ' ')}..."`)
      }
      return fallbackText
    } finally {
      this.activeController = null
    }
  }

  /**
   * Chat with vision + structured output.
   *
   * Attaches the image to the last user message and constrains
   * the response to the provided JSON schema.
   */
  async chatWithVisionStructured(messages: LLMMessage[], image: Buffer, jsonSchema: Record<string, unknown>, config?: GenerationConfig, systemInstruction?: string, _cachedContent?: string): Promise<string> {
    log.debug(`chatWithVisionStructured() ${messages.length} message(s), image=${image.length} bytes`)
    const isOllama = this.client.baseURL.includes('11434') || this.client.baseURL.includes('ollama')

    const executeCall = async (signal?: AbortSignal) => {
      this.activeController = new AbortController()
      if (signal) {
        signal.addEventListener('abort', () => this.activeController?.abort(), { once: true })
      }

      const sysMessages: OpenAI.Chat.ChatCompletionMessageParam[] = systemInstruction
        ? [{ role: 'system', content: systemInstruction }]
        : []

      // In local Ollama vision, keep only last 2 messages to stay well within token limits
      const effectiveMsgs = isOllama && messages.length > 2 ? messages.slice(-2) : messages

      const converted: OpenAI.Chat.ChatCompletionMessageParam[] = effectiveMsgs.map((m, index) => {
        const isLastUser = m.role === 'user' && index === effectiveMsgs.length - 1

        if (isLastUser) {
          return {
            role: 'user' as const,
            content: [
              {
                type: 'image_url' as const,
                image_url: {
                  url: `data:image/jpeg;base64,${image.toString('base64')}`,
                },
              },
              { type: 'text' as const, text: m.text },
            ],
          }
        }

        return {
          role: m.role === 'model' ? ('assistant' as const) : ('user' as const),
          content: m.text,
        }
      })

      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [...sysMessages, ...converted],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'structured_output',
              strict: true,
              schema: jsonSchema,
            },
          } as OpenAI.Chat.ChatCompletionCreateParams['response_format'],
          ...this.toOpenAIParams(config),
        }, { signal: this.activeController.signal })

        let text = response.choices[0]?.message?.content ?? ''
        text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
        log.debug(`chatWithVisionStructured() response length: ${text.length}`)
        return text
      } catch (err: unknown) {
        if ((err as any)?.name === 'AbortError') throw err
        log.warn(`chatWithVisionStructured() json_schema failed (${(err as Error)?.message || err}), falling back to json_object format`)
        const fallbackSys: OpenAI.Chat.ChatCompletionMessageParam[] = [
          {
            role: 'system',
            content: `${systemInstruction || ''}\n\nIMPORTANT: Output valid JSON only, strictly matching this schema: ${JSON.stringify(jsonSchema)}`,
          },
        ]
        const fallback = await this.client.chat.completions.create({
          model: this.model,
          messages: [...fallbackSys, ...converted],
          response_format: { type: 'json_object' } as any,
          ...this.toOpenAIParams(config),
        }, { signal: this.activeController?.signal })
        let fallbackText = fallback.choices[0]?.message?.content ?? ''
        fallbackText = fallbackText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
        log.debug(`chatWithVisionStructured() fallback response length: ${fallbackText.length}`)
        return fallbackText
      } finally {
        this.activeController = null
      }
    }

    if (isOllama) {
      return OllamaModelManager.getInstance().enqueue('vision:structured', (signal) => executeCall(signal))
    }
    return executeCall()
  }
}
