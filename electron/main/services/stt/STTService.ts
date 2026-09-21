import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

export function isInAppWhisperDownloaded(modelName: string = 'Xenova/whisper-base.en'): boolean {
  try {
    const hfHome = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface', 'hub')
    const folderName = 'models--' + modelName.replace('/', '--')
    const modelDir = path.join(hfHome, folderName)
    if (!fs.existsSync(modelDir)) return false
    const snapshotsDir = path.join(modelDir, 'snapshots')
    if (!fs.existsSync(snapshotsDir)) return false
    const snapshots = fs.readdirSync(snapshotsDir)
    if (snapshots.length === 0) return false
    const snapPath = path.join(snapshotsDir, snapshots[0])
    const files = fs.readdirSync(snapPath)
    return files.some((f) => f.endsWith('.onnx') || f.endsWith('.bin') || f.includes('model'))
  } catch {
    return false
  }
}

let activeSTTAbort: AbortController | null = null

export function cancelInAppSTTDownload(): void {
  if (activeSTTAbort) {
    activeSTTAbort.abort()
    activeSTTAbort = null
  }
  mainEventBus.emit('stt:in-app-progress', {
    model: 'in-app-whisper',
    status: 'cancelled',
    file: 'Download cancelled by user',
    progress: 0,
  })
}
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
   * Helper to convert WAV buffer to 16kHz Float32Array
   */
  private wavToFloat32Array(buffer: Buffer): Float32Array {
    let offset = 0
    let sampleRate = 16000
    if (buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF') {
      offset = 44
      sampleRate = buffer.readUInt32LE(24)
    }
    const sampleCount = Math.floor((buffer.length - offset) / 2)
    const float32 = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      const int16 = buffer.readInt16LE(offset + i * 2)
      float32[i] = int16 < 0 ? int16 / 32768 : int16 / 32767
    }
    if (sampleRate !== 16000 && sampleRate > 0) {
      // Resample to 16kHz for Xenova transformers pipeline
      const ratio = sampleRate / 16000
      const newLen = Math.round(float32.length / ratio)
      const resampled = new Float32Array(newLen)
      for (let i = 0; i < newLen; i++) {
        const origIdx = i * ratio
        const low = Math.floor(origIdx)
        const high = Math.min(low + 1, float32.length - 1)
        const weight = origIdx - low
        resampled[i] = float32[low] * (1 - weight) + float32[high] * weight
      }
      return resampled
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

    let modelName = config.stt.inAppWhisperModel || 'Xenova/whisper-tiny.en'
    if (modelName.includes('small') || modelName.includes('medium') || modelName.includes('large')) {
      modelName = 'Xenova/whisper-tiny.en'
    }
    if (this.loadedModelName !== modelName) {
      this.inAppPipeline = null
      this.loadedModelName = modelName
    }
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
    let modelName = config.stt.inAppWhisperModel || 'Xenova/whisper-tiny.en'
    if (modelName.includes('small') || modelName.includes('medium') || modelName.includes('large')) {
      modelName = 'Xenova/whisper-tiny.en'
    }
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
    const pipelineOpts: Record<string, any> = { task: 'transcribe' }
    if (targetLang && !modelName.endsWith('.en')) {
      pipelineOpts.language = targetLang
    }

    const output = await this.inAppPipeline(float32, pipelineOpts)

    const text = (output?.text || '').trim()
    this.log.info(`In-app Whisper result: "${text}"`)
    return text
  }

  /**
   * Transcribe an audio buffer (16kHz WAV/PCM) via in-app or offline Whisper endpoint.
   */
  async transcribeAudio(audioBuffer: Buffer, language?: string): Promise<string> {
    const config = getConfig()

    let endpoint = config.stt.whisperEndpoint || 'http://localhost:8080/v1'
    let model = config.stt.whisperModel || 'whisper-1'
    let apiKey = config.stt.whisperApiKey || 'offline-whisper'

    // Handy local server preset
    if (config.stt.provider === 'handy') {
      endpoint = config.stt.handyEndpoint || 'http://localhost:8000/v1'
      model = config.stt.whisperModel || 'whisper-1'
    }

    // Groq Cloud Whisper preset
    if (config.stt.provider === 'groq-whisper') {
      endpoint = 'https://api.groq.com/openai/v1'
      model = config.stt.whisperModel || 'whisper-large-v3-turbo'
      apiKey = config.stt.groqApiKey || config.stt.whisperApiKey || ''
    } else if (config.stt.provider === 'faster-whisper') {
      endpoint = config.stt.whisperEndpoint || 'http://localhost:8080/v1'
      model = config.stt.whisperModel || 'whisper-1'
    }
    const rawLang = language || (config.stt.language !== 'auto' ? config.stt.language : undefined)
    // Normalize regional language codes to standard ISO 639-1 2-letter codes (e.g. 'en-in', 'en-US' -> 'en', 'hi-IN' -> 'hi')
    const targetLang = rawLang && rawLang !== 'auto' ? rawLang.split(/[-_]/)[0].toLowerCase() : undefined

    // Route to in-app Whisper if in-app-whisper, hybrid, or endpoint is in-app
    if (config.stt.provider === 'in-app-whisper' || config.stt.provider === 'hybrid' || endpoint === 'in-app') {
      return this.transcribeWithInAppWhisper(audioBuffer, targetLang)
    }

    this.log.info(`Transcribing ${audioBuffer.length} bytes of audio via Whisper at ${endpoint} (model: ${model})`)

    try {
      const { default: OpenAI, toFile } = await import('openai')
      const client = new OpenAI({
        baseURL: endpoint,
        apiKey: apiKey || 'offline-whisper',
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
  async testWhisperConnection(endpointInput?: string, apiKeyInput?: string, modelInput?: string): Promise<{ ok: boolean; error?: string; message?: string }> {
    const config = getConfig()
    let endpoint = (endpointInput || config.stt.whisperEndpoint || 'http://localhost:8080/v1').replace(/\/+$/, '')
    let apiKey = apiKeyInput || config.stt.whisperApiKey

    if (endpointInput === 'groq' || (!endpointInput && config.stt.provider === 'groq-whisper')) {
      endpoint = 'https://api.groq.com/openai/v1'
      apiKey = apiKeyInput || config.stt.groqApiKey || config.stt.whisperApiKey
    }

    const isTestingInApp = endpoint === 'in-app' || (!endpointInput && (config.stt.provider === 'in-app-whisper' || config.stt.provider === 'hybrid')) || (!!modelInput && endpoint !== 'https://api.groq.com/openai/v1')

    if (isTestingInApp) {
      const modelName = modelInput || config.stt.inAppWhisperModel || 'Xenova/whisper-base.en'
      this.log.info(`Testing / downloading in-app STT model: ${modelName}`)

      activeSTTAbort = new AbortController()
      mainEventBus.emit('stt:in-app-progress', {
        model: modelName,
        status: 'downloading',
        progress: 5,
        file: 'Connecting to Hugging Face...',
      })

      try {
        const { pipeline, env } = await import('@xenova/transformers')
        env.allowLocalModels = true
        env.allowRemoteModels = true
        const os = await import('node:os')
        const cpus = os.cpus().length
        if (env.backends?.onnx?.wasm) {
          env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, cpus))
        }

        if (this.loadedModelName !== modelName || !this.inAppPipeline) {
          this.inAppPipeline = null
          this.loadedModelName = modelName

          this.inAppPipeline = await pipeline('automatic-speech-recognition', modelName, {
            quantized: true,
            progress_callback: (info: any) => {
              if (activeSTTAbort?.signal.aborted) throw new Error('Download cancelled')
              if (info) {
                const progressPct = info.progress !== undefined ? Math.round(info.progress) : (info.status === 'done' ? 100 : 0)
                mainEventBus.emit('stt:in-app-progress', {
                  model: modelName,
                  file: info.file || 'model_quantized.onnx',
                  progress: progressPct,
                  loaded: info.loaded,
                  total: info.total,
                  status: info.status || 'downloading',
                })
              }
            },
          })
        }

        // Test with 0.2s silence
        const dummy = new Float32Array(16000 * 0.2)
        await this.inAppPipeline(dummy)

        mainEventBus.emit('stt:in-app-progress', {
          model: modelName,
          status: 'ready',
          progress: 100,
          file: 'Model Ready & Cached',
        })

        return { ok: true, message: `Ready (${modelName.replace('Xenova/', '')})` }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        this.log.error('In-app Whisper test/download failed:', err)
        mainEventBus.emit('stt:in-app-progress', {
          model: modelName,
          status: 'error',
          file: message,
          progress: 0,
        })
        return { ok: false, error: message }
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
