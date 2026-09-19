import { BaseService } from '@electron/services/base/BaseService'
import { getConfig } from '@electron/utils/config'
import { mainEventBus } from '@electron/utils/eventBus'
import * as ModelManager from './ModelManager'

/**
 * STTService — backend orchestrator for speech-to-text.
 *
 * The actual recognition runs in the renderer via vosk-browser (WebAssembly).
 * This service handles:
 * - Model file management (download, verify, path resolution)
 * - Config-driven state
 * - Listening state events for Orb animation
 */
export class STTService extends BaseService {
  private listening = false

  async init(): Promise<void> {
    const config = getConfig()

    if (!config.stt.enabled) {
      this.log.info('STT is disabled in config')
      return
    }

    const status = ModelManager.getModelStatus(config.stt.language)
    if (status.downloaded) {
      this.log.info(`STT model ready (${config.stt.language}) at ${status.path}`)
    } else {
      this.log.warn(`STT model not downloaded for '${config.stt.language}' — download from Settings`)
    }
  }

  async dispose(): Promise<void> {
    this.listening = false
    this.log.info('STTService disposed')
  }

  /** Model status for the configured language */
  getModelStatus() {
    const { language } = getConfig().stt
    return ModelManager.getModelStatus(language)
  }

  /** Download model for a language */
  async downloadModel(language: string): Promise<void> {
    this.log.info(`Downloading model for '${language}'...`)
    await ModelManager.downloadModel(language)
  }

  /** Model path for the configured language (used by renderer to load model) */
  getModelPath(): string {
    const { language } = getConfig().stt
    return ModelManager.modelPath(language)
  }

  /** Available languages with labels */
  getAvailableLanguages(): { code: string; label: string }[] {
    return ModelManager.availableLanguages()
  }

  /** Set listening state (called from router) */
  setListening(active: boolean): void {
    this.listening = active
    mainEventBus.emit('audio:listening', active)
    this.log.debug(`Listening: ${active}`)
  }

  get isListening(): boolean {
    return this.listening
  }

  private inAppPipeline: any = null
  private loadingInApp = false
  private loadedModelName = ''

  /**
   * Helper to convert 16kHz WAV buffer to Float32Array
   */
  private wavToFloat32Array(buffer: Buffer): Float32Array {
    let offset = 0
    if (buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF') {
      offset = 44
    }
    const sampleCount = Math.floor((buffer.length - offset) / 2)
    const float32 = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      const int16 = buffer.readInt16LE(offset + i * 2)
      float32[i] = int16 < 0 ? int16 / 32768 : int16 / 32767
    }
    return float32
  }

  /**
   * Asynchronously pre-warm in-app Whisper pipeline on startup so inference has 0 cold-start delay.
   */
  async prewarm(): Promise<void> {
    const config = getConfig()
    const isWhisperUsed =
      config.stt.provider === 'in-app-whisper' ||
      config.stt.provider === 'hybrid' ||
      config.stt.whisperEndpoint === 'in-app'

    if (!isWhisperUsed) return

    const modelName = config.stt.inAppWhisperModel || 'Xenova/whisper-base.en'
    this.log.info(`Pre-warming in-app Whisper (${modelName})...`)
    try {
      const { pipeline, env } = await import('@xenova/transformers')
      env.allowLocalModels = true
      env.allowRemoteModels = true
      const os = await import('node:os')
      const cpus = os.cpus().length
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, cpus))
        env.backends.onnx.wasm.simd = true
      }

      if (!this.inAppPipeline) {
        try {
          this.inAppPipeline = await pipeline('automatic-speech-recognition', modelName, {
            quantized: true,
          })
        } catch {
          this.inAppPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
            quantized: true,
          })
        }
        this.loadedModelName = modelName
      }

      // Run a tiny 0.1s silence slice to initialize ONNX execution session & memory buffers
      const dummy = new Float32Array(16000 * 0.1)
      await this.inAppPipeline(dummy)
      this.log.info(`In-app Whisper pre-warmed & ready with ${Math.max(1, Math.min(8, cpus))} ONNX threads!`)
    } catch (err) {
      this.log.warn('In-app Whisper prewarm encountered an issue:', err)
    }
  }

  /**
   * Transcribe via embedded in-app Whisper (@xenova/transformers)
   */
  async transcribeWithInAppWhisper(audioBuffer: Buffer, language?: string): Promise<string> {
    const config = getConfig()
    const modelName = config.stt.inAppWhisperModel || 'Xenova/whisper-base.en'
    const targetLang = language || (config.stt.language !== 'auto' ? config.stt.language : undefined)

    if (this.loadedModelName !== modelName) {
      this.inAppPipeline = null
      this.loadedModelName = modelName
    }

    this.log.info(`Transcribing ${audioBuffer.length} bytes with in-app Whisper (${modelName})`)

    if (!this.inAppPipeline && !this.loadingInApp) {
      this.loadingInApp = true
      try {
        const { pipeline, env } = await import('@xenova/transformers')
        env.allowLocalModels = true
        env.allowRemoteModels = true
        const os = await import('node:os')
        const cpus = os.cpus().length
        if (env.backends?.onnx?.wasm) {
          env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, cpus))
          env.backends.onnx.wasm.simd = true
        }

        try {
          this.inAppPipeline = await pipeline('automatic-speech-recognition', modelName, {
            quantized: true,
          })
          this.log.info(`In-app Whisper model (${modelName}) loaded successfully`)
        } catch (modelErr) {
          this.log.warn(`Failed loading ${modelName}, attempting fallback to tiny:`, modelErr)
          this.inAppPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
            quantized: true,
          })
          this.log.info('In-app Whisper fallback model (tiny) loaded successfully')
        }
      } finally {
        this.loadingInApp = false
      }
    }

    if (!this.inAppPipeline) {
      throw new Error('Failed to initialize in-app Whisper engine')
    }

    const float32 = this.wavToFloat32Array(audioBuffer)
    const output = await this.inAppPipeline(float32, {
      language: targetLang,
      task: 'transcribe',
    })

    const text = (output?.text || '').trim()
    this.log.info(`In-app Whisper result: "${text}"`)
    return text
  }

  /**
   * Transcribe an audio buffer (16kHz WAV/PCM) via in-app or offline Whisper endpoint.
   */
  async transcribeAudio(audioBuffer: Buffer, language?: string): Promise<string> {
    const config = getConfig()
    const endpoint = config.stt.whisperEndpoint || 'http://localhost:8080/v1'
    const model = config.stt.whisperModel || 'whisper-1'
    const targetLang = language || (config.stt.language !== 'auto' ? config.stt.language : undefined)

    // Route to in-app Whisper if in-app-whisper, hybrid, or endpoint is in-app
    if (config.stt.provider === 'in-app-whisper' || config.stt.provider === 'hybrid' || endpoint === 'in-app') {
      return this.transcribeWithInAppWhisper(audioBuffer, targetLang)
    }

    this.log.info(`Transcribing ${audioBuffer.length} bytes of audio via Whisper at ${endpoint} (model: ${model})`)

    try {
      const { default: OpenAI, toFile } = await import('openai')
      const client = new OpenAI({
        baseURL: endpoint,
        apiKey: config.stt.whisperApiKey || 'offline-whisper',
        dangerouslyAllowBrowser: false,
      })

      const file = await toFile(audioBuffer, 'speech.wav', { type: 'audio/wav' })
      const response = await client.audio.transcriptions.create({
        file,
        model,
        ...(targetLang ? { language: targetLang } : {}),
      })

      const text = typeof response === 'string' ? response : (response as { text?: string })?.text ?? ''
      this.log.info(`Whisper transcription result: "${text}"`)
      return text
    } catch (err: unknown) {
      // If remote fails, fallback to in-app Whisper
      this.log.warn('Remote Whisper failed, attempting in-app Whisper fallback...', err)
      try {
        return await this.transcribeWithInAppWhisper(audioBuffer, targetLang)
      } catch (fallbackErr) {
        const message = err instanceof Error ? err.message : String(err)
        this.log.error('Whisper transcription failed:', fallbackErr)
        throw new Error(`Whisper transcription error: ${message}`)
      }
    }
  }

  /**
   * Test connectivity to offline Whisper endpoint or in-app model.
   */
  async testWhisperConnection(endpointInput?: string, apiKeyInput?: string): Promise<{ ok: boolean; error?: string; message?: string }> {
    const config = getConfig()
    const endpoint = (endpointInput || config.stt.whisperEndpoint || 'http://localhost:8080/v1').replace(/\/+$/, '')
    const apiKey = apiKeyInput || config.stt.whisperApiKey

    const isTestingInApp = endpoint === 'in-app' || (!endpointInput && config.stt.provider === 'in-app-whisper')

    if (isTestingInApp) {
      try {
        const { pipeline, env } = await import('@xenova/transformers')
        env.allowLocalModels = true
        env.allowRemoteModels = true
        const modelName = config.stt.inAppWhisperModel || 'Xenova/whisper-base.en'
        if (!this.inAppPipeline) {
          try {
            this.inAppPipeline = await pipeline('automatic-speech-recognition', modelName, {
              quantized: true,
            })
          } catch (loadErr) {
            this.log.warn(`Failed loading ${modelName}, falling back to tiny:`, loadErr)
            this.inAppPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
              quantized: true,
            })
          }
        }
        // Run a dummy 0.5s silence test to verify onnx execution
        const dummy = new Float32Array(16000 * 0.5)
        await this.inAppPipeline(dummy)
        return { ok: true, message: `In-App Whisper Engine Ready (${modelName.replace('Xenova/', '')})` }
      } catch (err) {
        return { ok: false, error: (err as Error).message || 'Failed to initialize in-app Whisper' }
      }
    }

    try {
      // Test endpoint availability via standard fetch with timeout & authorization header if key provided
      const headers: Record<string, string> = {}
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
      const res = await fetch(`${endpoint}/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok || res.status === 404 || res.status === 405) {
        return { ok: true, message: apiKey ? 'API Key & Endpoint Verified' : 'Endpoint reachable' }
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'Authentication failed (401/403): Invalid API Key' }
      }
      return { ok: false, error: `Endpoint responded with status ${res.status}` }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message || 'Cannot reach Whisper endpoint' }
    }
  }
}
