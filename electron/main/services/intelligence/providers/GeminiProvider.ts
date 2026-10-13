/**
 * GeminiProvider — Gemini API integration via @google/genai SDK.
 *
 * Supports:
 * - Single-shot `chat()` and streaming `stream()`
 * - `streamWithThoughts()` for models with thinking support (gemini-2.5-flash)
 * - `vision()` and `chatWithVision()` for multimodal (screenshot) analysis
 * - Native `systemInstruction` parameter (avoids wasting tokens on fake user/model pairs)
 *
 * Error handling is centralized via {@link handleError} — all API calls
 * are wrapped uniformly to avoid code duplication.
 */

import { GoogleGenAI, Environment } from '@google/genai'
import { BaseLLMProvider, type LLMMessage, type GenerationConfig } from './BaseLLMProvider'
import { formatLLMError } from '@electron/utils/llmErrors'
import { createLogger } from '@electron/utils/logger'

const log = createLogger('GeminiProvider')

/** A typed chunk from the LLM stream — either a thought or text */
export interface StreamChunk {
  type: 'thought' | 'text'
  content: string
}

/**
 * Centralized error handler for all Gemini API calls.
 *
 * Converts raw SDK errors into clean, user-facing messages
 * via {@link formatLLMError} and logs them with context.
 *
 * @param method — name of the calling method (for log context)
 * @param err — raw error from the SDK
 * @throws Always — re-throws with a clean message
 */
function handleError(method: string, err: unknown): never {
  const msg = formatLLMError(err)
  log.error(`${method} error: ${msg}`)
  throw new Error(msg)
}

export class GeminiProvider extends BaseLLMProvider {
  readonly name = 'gemini'

  private client: GoogleGenAI
  private model: string

  constructor(apiKey: string, model: string = '') {
    super()
    this.client = new GoogleGenAI({ apiKey })

    const m = (model || '').toLowerCase().trim()
    const isNonGemini = m.includes('qwen') || m.includes('llama') || m.includes('mistral') || m.includes('deepseek') || m.includes('phi') || (m.includes(':') && !m.startsWith('gemini'))
    
    let sanitized = model
    if (!model || isNonGemini) {
      sanitized = 'gemini-3.6-flash'
      log.warn(`[Gemini] Invalid or non-Gemini model name "${model}" — defaulting to "${sanitized}"`)
    } else if (m === 'gemini-3.5-flash-lite' || m === 'gemini-3-flash-lite' || m === 'gemini-2.5-flash' || m === 'gemini-3.8-flash') {
      sanitized = 'gemini-3.6-flash'
      log.warn(`[Gemini] Model "${model}" experiencing high demand or deprecated — defaulting to "${sanitized}"`)
    }

    this.model = sanitized
    log.info(`Initialized with model: ${sanitized}`)
  }

  // ═══════════════════════════════════════════════════════════════
  //  Internal helpers
  // ═══════════════════════════════════════════════════════════════

  /** Convert LLMMessage[] → Gemini Content format */
  private toContents(messages: LLMMessage[]) {
    return messages.map((m) => ({
      role: m.role === 'model' ? ('model' as const) : ('user' as const),
      parts: [{ text: m.text }],
    }))
  }

  /** Map provider-agnostic GenerationConfig → Gemini config shape */
  private toGeminiConfig(config?: GenerationConfig) {
    if (!config) return undefined
    return {
      temperature: config.temperature,
      topP: config.topP,
      topK: config.topK,
      maxOutputTokens: config.maxOutputTokens,
    }
  }

  /**
   * Helper to execute Gemini API calls with automatic fallbacks:
   * 1. If `cachedContent` is rejected (e.g. 429 quota on free tier, 400 invalid, 404 expired), retry uncached using systemInstruction.
   * 2. If model returns 503 (high demand), 404 (not found), or 429, fallback to gemini-3.6-flash.
   */
  private async executeWithFallback<T>(
    methodName: string,
    cachedContent: string | undefined,
    systemInstruction: string | undefined,
    fn: (model: string, configExtra: { cachedContent?: string; systemInstruction?: string }) => Promise<T>
  ): Promise<T> {
    let modelToUse = this.model
    const useCache = Boolean(cachedContent)

    try {
      const configExtra = useCache ? { cachedContent } : { systemInstruction }
      return await fn(modelToUse, configExtra)
    } catch (primaryErr: any) {
      log.warn(`[Gemini] ${methodName} primary attempt failed (model=${modelToUse}, cached=${useCache}): ${primaryErr?.message || primaryErr}`)

      // Fallback 1: Retry without cachedContent if cachedContent was present
      let secondErr = primaryErr
      if (useCache) {
        log.warn(`[Gemini] Retrying ${methodName} without cachedContent...`)
        try {
          return await fn(modelToUse, { systemInstruction })
        } catch (err2: any) {
          secondErr = err2
        }
      }

      // Fallback 2: Fallback model to gemini-3.6-flash if current model is unavailable / high demand / not found
      const errStr = String(secondErr?.message || secondErr)
      const isUnavailable =
        secondErr?.status === 503 ||
        secondErr?.status === 404 ||
        secondErr?.status === 429 ||
        errStr.includes('503') ||
        errStr.includes('404') ||
        errStr.includes('429') ||
        errStr.includes('UNAVAILABLE') ||
        errStr.includes('NOT_FOUND') ||
        errStr.includes('high demand') ||
        errStr.includes('quota') ||
        errStr.includes('RESOURCE_EXHAUSTED')

      if (isUnavailable && modelToUse !== 'gemini-3.6-flash') {
        log.warn(`[Gemini] Model "${modelToUse}" unavailable/busy (${secondErr?.status || 'error'}) — automatically falling back to gemini-3.6-flash`)
        this.model = 'gemini-3.6-flash'
        modelToUse = 'gemini-3.6-flash'
        try {
          return await fn(modelToUse, { systemInstruction })
        } catch (err3: any) {
          handleError(`${methodName} fallback`, err3)
        }
      }

      handleError(methodName, secondErr)
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════

  /**
   * One-shot completion: send messages, get full reply string.
   *
   * @param messages — conversation history
   * @param config — optional generation parameters
   * @param systemInstruction — optional system prompt (native API, saves tokens)
   */
  async chat(messages: LLMMessage[], config?: GenerationConfig, systemInstruction?: string, cachedContent?: string): Promise<string> {
    log.debug(`chat() with ${messages.length} message(s)${cachedContent ? ' (cached)' : ''}`)
    return this.executeWithFallback('chat()', cachedContent, systemInstruction, async (model, configExtra) => {
      const response = await this.client.models.generateContent({
        model,
        contents: this.toContents(messages),
        config: {
          ...this.toGeminiConfig(config),
          ...configExtra,
        },
      })

      const text = response.text ?? ''
      log.debug(`chat() response length: ${text.length}`)
      return text
    })
  }

  /**
   * Streaming completion: yields text chunks as they arrive.
   *
   * @param messages — conversation history
   * @param config — optional generation parameters
   * @param systemInstruction — optional system prompt (native API, saves tokens)
   */
  async *stream(messages: LLMMessage[], config?: GenerationConfig, systemInstruction?: string, cachedContent?: string): AsyncGenerator<string> {
    log.debug(`stream() with ${messages.length} message(s)${cachedContent ? ' (cached)' : ''}`)

    let modelToUse = this.model
    let response: any

    try {
      response = await this.client.models.generateContentStream({
        model: modelToUse,
        contents: this.toContents(messages),
        config: {
          ...this.toGeminiConfig(config),
          ...(cachedContent ? { cachedContent } : { systemInstruction }),
        },
      })
    } catch (primaryErr: any) {
      let activeErr = primaryErr
      log.warn(`[Gemini] stream() primary attempt failed: ${primaryErr?.message || primaryErr}`)
      if (cachedContent) {
        try {
          response = await this.client.models.generateContentStream({
            model: modelToUse,
            contents: this.toContents(messages),
            config: {
              ...this.toGeminiConfig(config),
              systemInstruction,
            },
          })
        } catch (err2) {
          activeErr = err2
        }
      }

      if (!response && modelToUse !== 'gemini-3.6-flash') {
        log.warn(`[Gemini] Falling back stream() to gemini-3.6-flash`)
        this.model = 'gemini-3.6-flash'
        response = await this.client.models.generateContentStream({
          model: 'gemini-3.6-flash',
          contents: this.toContents(messages),
          config: {
            ...this.toGeminiConfig(config),
            systemInstruction,
          },
        }).catch((err) => handleError('stream() fallback', err))
      } else if (!response) {
        handleError('stream()', activeErr)
      }
    }

    try {
      for await (const chunk of response) {
        const text = chunk.text
        if (text) yield text
      }
    } catch (err) {
      handleError('stream() chunk', err)
    }
  }

  /**
   * Streaming with real thinking support.
   *
   * Yields typed chunks: `thought` for the model's reasoning,
   * `text` for the final response. Enables the UI to show
   * real-time AI thoughts before the answer appears.
   *
   * Requires a thinking-capable model (e.g. gemini-2.5-flash).
   *
   * @param messages — conversation history
   * @param config — optional generation parameters
   * @param systemInstruction — optional system prompt (native API, saves tokens)
   */
  async *streamWithThoughts(messages: LLMMessage[], config?: GenerationConfig, systemInstruction?: string, cachedContent?: string): AsyncGenerator<StreamChunk> {
    log.debug(`streamWithThoughts() with ${messages.length} message(s)${cachedContent ? ' (cached)' : ''}`)

    const geminiConfig = this.toGeminiConfig(config) ?? {}
    let modelToUse = this.model
    let response: any

    try {
      response = await this.client.models.generateContentStream({
        model: modelToUse,
        contents: this.toContents(messages),
        config: {
          ...geminiConfig,
          thinkingConfig: { includeThoughts: true },
          ...(cachedContent ? { cachedContent } : { systemInstruction }),
        },
      })
    } catch (primaryErr: any) {
      let activeErr = primaryErr
      log.warn(`[Gemini] streamWithThoughts() primary attempt failed (model=${modelToUse}): ${primaryErr?.message || primaryErr}`)
      if (cachedContent) {
        log.warn(`[Gemini] Retrying streamWithThoughts() without cachedContent...`)
        try {
          response = await this.client.models.generateContentStream({
            model: modelToUse,
            contents: this.toContents(messages),
            config: {
              ...geminiConfig,
              thinkingConfig: { includeThoughts: true },
              systemInstruction,
            },
          })
        } catch (err2: any) {
          activeErr = err2
        }
      }

      if (!response && modelToUse !== 'gemini-3.6-flash') {
        log.warn(`[Gemini] Model "${modelToUse}" failed — automatically falling back to gemini-3.6-flash`)
        this.model = 'gemini-3.6-flash'
        response = await this.client.models.generateContentStream({
          model: 'gemini-3.6-flash',
          contents: this.toContents(messages),
          config: {
            ...geminiConfig,
            thinkingConfig: { includeThoughts: true },
            systemInstruction,
          },
        }).catch((err) => handleError('streamWithThoughts() fallback', err))
      } else if (!response) {
        handleError('streamWithThoughts()', activeErr)
      }
    }

    try {
      for await (const chunk of response) {
        const candidates = chunk.candidates
        if (!candidates || candidates.length === 0) continue

        const parts = candidates[0].content?.parts
        if (!parts) continue

        for (const part of parts) {
          if (!part.text) continue
          yield part.thought
            ? { type: 'thought', content: part.text }
            : { type: 'text', content: part.text }
        }
      }
    } catch (err) {
      handleError('streamWithThoughts() chunk', err)
    }
  }

  /**
   * Vision: send a single image + text prompt, get a text response.
   *
   * Uses Gemini's multimodal capabilities to analyze screenshots.
   *
   * @param image — screenshot as JPEG buffer
   * @param prompt — text prompt to accompany the image
   * @param config — optional generation parameters
   */
  async vision(image: Buffer, prompt: string, config?: GenerationConfig): Promise<string> {
    log.debug(`vision() image=${image.length} bytes, prompt="${prompt.slice(0, 60)}..."`)
    return this.executeWithFallback('vision()', undefined, undefined, async (model, configExtra) => {
      const response = await this.client.models.generateContent({
        model,
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: image.toString('base64') } },
            { text: prompt },
          ],
        }],
        config: {
          ...this.toGeminiConfig(config),
          ...configExtra,
        },
      })

      const text = response.text ?? ''
      log.debug(`vision() response length: ${text.length}`)
      return text
    })
  }

  /**
   * Chat with vision: full conversation + screenshot on the last user message.
   *
   * Attaches the screenshot as `inlineData` (proper multimodal API) to the
   * last user message. This avoids embedding base64 in text which would
   * explode token count.
   *
   * @param messages — conversation history (text only)
   * @param image — screenshot JPEG buffer to attach to the LAST user message
   * @param config — optional generation parameters
   * @param systemInstruction — optional system prompt (native API, saves tokens)
   */
  async chatWithVision(messages: LLMMessage[], image: Buffer, config?: GenerationConfig, systemInstruction?: string, cachedContent?: string): Promise<string> {
    log.debug(`chatWithVision() ${messages.length} message(s), image=${image.length} bytes${cachedContent ? ' (cached)' : ''}`)

    return this.executeWithFallback('chatWithVision()', cachedContent, systemInstruction, async (model, configExtra) => {
      const contents = messages.map((m, index) => {
        const isLastUser = m.role === 'user' && index === messages.length - 1
        const role = m.role === 'model' ? ('model' as const) : ('user' as const)

        if (isLastUser) {
          return {
            role,
            parts: [
              { inlineData: { mimeType: 'image/jpeg' as const, data: image.toString('base64') } },
              { text: m.text },
            ],
          }
        }

        return { role, parts: [{ text: m.text }] }
      })

      const response = await this.client.models.generateContent({
        model,
        contents,
        config: {
          ...this.toGeminiConfig(config),
          ...configExtra,
        },
      })

      const text = response.text ?? ''
      log.debug(`chatWithVision() response length: ${text.length}`)
      return text
    })
  }

  /**
   * Structured output: get LLM response constrained to a JSON schema.
   *
   * Uses Gemini's native `responseMimeType: 'application/json'` +
   * `responseJsonSchema` to force valid JSON output.
   *
   * @param messages — conversation history
   * @param jsonSchema — JSON Schema object (from `z.toJSONSchema()`)
   * @param config — optional generation parameters
   * @param systemInstruction — optional system prompt
   * @returns Raw JSON string — caller should parse with Zod `.parse()`
   */
  async chatStructured(messages: LLMMessage[], jsonSchema: Record<string, unknown>, config?: GenerationConfig, systemInstruction?: string, cachedContent?: string): Promise<string> {
    log.debug(`chatStructured() with ${messages.length} message(s)${cachedContent ? ' (cached)' : ''}`)

    return this.executeWithFallback('chatStructured()', cachedContent, systemInstruction, async (model, configExtra) => {
      const response = await this.client.models.generateContent({
        model,
        contents: this.toContents(messages),
        config: {
          ...this.toGeminiConfig(config),
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema,
          ...configExtra,
        },
      })

      const text = response.text ?? ''
      log.debug(`chatStructured() response length: ${text.length}`)
      return text
    })
  }

  /**
   * Chat with vision + structured output.
   *
   * Combines multimodal (screenshot) input with JSON schema constraint.
   * Used by ActionLoop to get typed action JSON from screen analysis.
   *
   * @param messages — conversation history
   * @param image — screenshot JPEG buffer
   * @param jsonSchema — JSON Schema object (from `z.toJSONSchema()`)
   * @param config — optional generation parameters
   * @param systemInstruction — optional system prompt
   * @returns Raw JSON string — caller should parse with Zod `.parse()`
   */
  async chatWithVisionStructured(messages: LLMMessage[], image: Buffer, jsonSchema: Record<string, unknown>, config?: GenerationConfig, systemInstruction?: string, cachedContent?: string): Promise<string> {
    log.debug(`chatWithVisionStructured() ${messages.length} message(s), image=${image.length} bytes${cachedContent ? ' (cached)' : ''}`)

    return this.executeWithFallback('chatWithVisionStructured()', cachedContent, systemInstruction, async (model, configExtra) => {
      const contents = messages.map((m, index) => {
        const isLastUser = m.role === 'user' && index === messages.length - 1
        const role = m.role === 'model' ? ('model' as const) : ('user' as const)

        if (isLastUser) {
          return {
            role,
            parts: [
              { inlineData: { mimeType: 'image/jpeg' as const, data: image.toString('base64') } },
              { text: m.text },
            ],
          }
        }

        return { role, parts: [{ text: m.text }] }
      })

      const response = await this.client.models.generateContent({
        model,
        contents,
        config: {
          ...this.toGeminiConfig(config),
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema,
          ...configExtra,
        },
      })

      const text = response.text ?? ''
      log.debug(`chatWithVisionStructured() response length: ${text.length}`)
      return text
    })
  }

  /**
   * Computer Use: send conversation with screenshot, using Gemini's native
   * `computer_use` tool for screen interaction.
   *
   * Unlike other methods, this returns the full `GenerateContentResponse`
   * so the caller can inspect `functionCall` parts (click_at, type_text_at, etc.)
   * and `safety_decision` data for permission gating.
   *
   * @param contents — Gemini-native Content[] (not LLMMessage[])
   * @param systemInstruction — optional system prompt
   * @param excludedFunctions — optional list of predefined funcs to exclude
   * @returns Full API response with function_call parts
   */
  async chatWithComputerUse(
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
    systemInstruction?: string,
    excludedFunctions?: string[],
    cachedContent?: string,
  ) {
    log.debug(`chatWithComputerUse() ${contents.length} content(s)${cachedContent ? ' (cached)' : ''}`)

    return this.executeWithFallback('chatWithComputerUse()', cachedContent, systemInstruction, async (model, configExtra) => {
      const response = await this.client.models.generateContent({
        model,
        contents,
        config: {
          ...configExtra,
          tools: [{
            computerUse: {
              environment: Environment.ENVIRONMENT_BROWSER,
              ...(excludedFunctions?.length ? { excludedPredefinedFunctions: excludedFunctions } : {}),
            },
          }],
        },
      })

      log.debug(`chatWithComputerUse() candidates: ${response.candidates?.length ?? 0}`)
      return response
    })
  }
}
