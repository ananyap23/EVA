import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

/** Check on-disk existence of downloaded Kokoro weights in HuggingFace cache */
export function isKokoroDownloaded(): boolean {
  try {
    const hfHome = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface', 'hub')
    const modelDir = path.join(hfHome, 'models--onnx-community--Kokoro-82M-v1.0-ONNX')
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

let activeKokoroAbort: AbortController | null = null

export async function startKokoroDownload(): Promise<{ ok: boolean; error?: string }> {
  activeKokoroAbort = new AbortController()
  const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX'

  mainEventBus.emit('tts:kokoro-progress', {
    model: 'Kokoro-82M',
    status: 'downloading',
    file: 'Connecting to Hugging Face...',
    progress: 5,
  })

  try {
    const { KokoroTTS } = await import('kokoro-js')
    await KokoroTTS.from_pretrained(modelId, {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (info: any) => {
        if (activeKokoroAbort?.signal.aborted) {
          throw new Error('Download cancelled')
        }
        if (info) {
          const progressPct = info.progress !== undefined ? Math.round(info.progress) : (info.status === 'done' ? 100 : 0)
          mainEventBus.emit('tts:kokoro-progress', {
            model: 'Kokoro-82M',
            file: info.file || 'model.onnx',
            progress: progressPct,
            loaded: info.loaded,
            total: info.total,
            status: info.status || 'downloading',
          })
        }
      },
    })

    mainEventBus.emit('tts:kokoro-progress', {
      model: 'Kokoro-82M',
      status: 'ready',
      progress: 100,
      file: 'Model Ready & Cached',
    })
    return { ok: true }
  } catch (err: any) {
    if (activeKokoroAbort?.signal.aborted || err?.message === 'Download cancelled') {
      mainEventBus.emit('tts:kokoro-progress', {
        model: 'Kokoro-82M',
        status: 'cancelled',
        file: 'Download cancelled by user',
        progress: 0,
      })
      return { ok: false, error: 'Download cancelled' }
    }
    const msg = err?.message || 'Download failed'
    mainEventBus.emit('tts:kokoro-progress', {
      model: 'Kokoro-82M',
      status: 'error',
      file: msg,
      progress: 0,
    })
    return { ok: false, error: msg }
  } finally {
    activeKokoroAbort = null
  }
}

export function cancelKokoroDownload(): void {
  if (activeKokoroAbort) {
    activeKokoroAbort.abort()
    activeKokoroAbort = null
  }
  mainEventBus.emit('tts:kokoro-progress', {
    model: 'Kokoro-82M',
    status: 'cancelled',
    file: 'Download cancelled by user',
    progress: 0,
  })
}
import { mainEventBus } from '@electron/utils/eventBus'
import { BaseTTSProvider } from './BaseTTSProvider'
import { createLogger } from '@electron/utils/logger'

const log = createLogger('KokoroTTSProvider')

/**
 * Helper to encode Float32Array PCM into a standard 16-bit 24kHz mono WAV Buffer.
 */
function float32ToWavBuffer(samples: Float32Array, sampleRate: number = 24000): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples.length * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM format
  buffer.writeUInt16LE(1, 22) // 1 channel
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate (SampleRate * NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // 16 bits per sample
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2)
  }
  return buffer
}

/**
 * KokoroTTSProvider — local, high-fidelity neural speech synthesis via kokoro-js (ONNX Runtime).
 *
 * Runs completely locally on CPU without requiring Python, PyTorch, or CUDA.
 * Model weights are automatically downloaded from Hugging Face on demand and cached locally.
 */
export class KokoroTTSProvider extends BaseTTSProvider {
  readonly name = 'kokoro'

  private ttsInstance: any = null
  private loadingPromise: Promise<any> | null = null
  private voice: string
  private dtype: string

  constructor(voice: string = 'af_heart', dtype: string = 'q8') {
    super()
    this.voice = voice || 'af_heart'
    this.dtype = dtype || 'q8'
    log.info(`KokoroTTSProvider created (voice: ${this.voice}, dtype: ${this.dtype})`)
  }

  setVoice(voice: string): void {
    this.voice = voice || 'af_heart'
    log.info(`Kokoro voice set to: ${this.voice}`)
  }

  /**
   * Lazily loads the KokoroTTS model on demand.
   * Auto-downloads weights if not already cached.
   */
  async getOrInitEngine(): Promise<any> {
    if (this.ttsInstance) return this.ttsInstance
    if (this.loadingPromise) return this.loadingPromise

    this.loadingPromise = (async () => {
      try {
        log.info(`Initializing Kokoro-82M ONNX model (dtype: ${this.dtype})...`)
        const { KokoroTTS } = await import('kokoro-js')
        const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX'

        mainEventBus.emit('tts:kokoro-progress', {
          model: 'Kokoro-82M',
          status: 'downloading',
          file: 'Connecting to Hugging Face...',
          progress: 5,
        })

        this.ttsInstance = await KokoroTTS.from_pretrained(modelId, {
          dtype: this.dtype as any,
          device: 'cpu',
          progress_callback: (info: any) => {
            if (info) {
              const progressPct = info.progress !== undefined ? Math.round(info.progress) : (info.status === 'done' ? 100 : 0)
              mainEventBus.emit('tts:kokoro-progress', {
                model: 'Kokoro-82M',
                file: info.file || 'model.onnx',
                progress: progressPct,
                loaded: info.loaded,
                total: info.total,
                status: info.status || 'downloading',
              })
            }
          },
        })

        log.info('KokoroTTS model loaded successfully!')
        mainEventBus.emit('tts:kokoro-progress', {
          model: 'Kokoro-82M',
          status: 'ready',
          progress: 100,
          file: 'Model Ready',
        })
        return this.ttsInstance
      } catch (err) {
        log.error('Failed to load KokoroTTS model:', err)
        mainEventBus.emit('tts:kokoro-progress', {
          model: 'Kokoro-82M',
          status: 'error',
          file: (err as Error).message || 'Download failed',
          progress: 0,
        })
        this.loadingPromise = null
        throw err
      }
    })()

    return this.loadingPromise
  }

  /** Full synthesis: send text, get complete WAV audio buffer. */
  async synthesize(text: string): Promise<Buffer> {
    const tts = await this.getOrInitEngine()
    log.info(`Synthesizing "${text.slice(0, 40)}..." with Kokoro voice "${this.voice}"`)

    const result = await tts.generate(text, {
      voice: this.voice,
    })

    if (result && result.audio) {
      const sampleRate = result.sampling_rate || 24000
      return float32ToWavBuffer(result.audio, sampleRate)
    }

    throw new Error('Kokoro did not return audio data')
  }

  /**
   * Streaming synthesis: yields sentences sequentially.
   */
  async *streamSpeech(text: string): AsyncGenerator<Buffer> {
    // Split into sentences so playback begins immediately after the first sentence
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]

    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim()
      if (!sentence) continue
      try {
        const chunk = await this.synthesize(sentence)
        yield chunk
      } catch (err) {
        log.warn(`Error synthesizing sentence with Kokoro: "${sentence.slice(0, 30)}"`, err)
      }
    }
  }
}
