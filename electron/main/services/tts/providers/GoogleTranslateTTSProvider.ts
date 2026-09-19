import { BaseTTSProvider } from './BaseTTSProvider'
import { createLogger } from '@electron/utils/logger'

const log = createLogger('GoogleTranslateTTSProvider')

/**
 * GoogleTranslateTTSProvider — free, zero-key neural speech synthesis.
 *
 * Supports multiple English and international regional accents:
 * - en-US (US English)
 * - en-GB (British English)
 * - en-AU (Australian English)
 * - en-IN (Indian English)
 * - en-CA (Canadian English)
 * - and international language codes (es, fr, de, ja, etc.)
 */
export class GoogleTranslateTTSProvider extends BaseTTSProvider {
  readonly name = 'google-translate'
  private accent: string

  get currentAccent(): string {
    return this.accent
  }

  constructor(accent: string = 'en-US') {
    super()
    this.accent = accent || 'en-US'
    log.info(`Initialized GoogleTranslateTTSProvider with accent: ${this.accent}`)
  }

  setAccent(accent: string): void {
    this.accent = accent || 'en-US'
    log.info(`Updated accent to: ${this.accent}`)
  }

  /**
   * Split text into sentence chunks under 180 chars for Google Translate TTS limit.
   */
  private splitText(text: string): string[] {
    const clean = text.replace(/[*_#`[\]()]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!clean) return []
    if (clean.length <= 180) return [clean]

    const chunks: string[] = []
    const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean]
    let current = ''

    for (const sentence of sentences) {
      const trimmed = sentence.trim()
      if (!trimmed) continue

      if ((current + ' ' + trimmed).trim().length <= 180) {
        current = (current + ' ' + trimmed).trim()
      } else {
        if (current) chunks.push(current)
        if (trimmed.length <= 180) {
          current = trimmed
        } else {
          // Hard split long sentence by words
          const words = trimmed.split(' ')
          let sub = ''
          for (const w of words) {
            if ((sub + ' ' + w).trim().length <= 180) {
              sub = (sub + ' ' + w).trim()
            } else {
              if (sub) chunks.push(sub)
              sub = w
            }
          }
          current = sub
        }
      }
    }
    if (current) chunks.push(current)
    return chunks
  }

  /**
   * Fetch a single audio segment (MP3) from Google Translate TTS.
   */
  private async fetchChunk(chunk: string): Promise<Buffer> {
    const lang = this.accent || 'en'
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${encodeURIComponent(lang)}&client=tw-ob`

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com/',
      },
    })

    if (!res.ok) {
      throw new Error(`Google Translate TTS failed with status ${res.status}`)
    }

    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  async synthesize(text: string): Promise<Buffer> {
    log.debug(`synthesize() ${text.length} chars with accent ${this.accent}`)
    const chunks = this.splitText(text)
    if (chunks.length === 0) return Buffer.alloc(0)

    const buffers: Buffer[] = []
    for (const chunk of chunks) {
      const buf = await this.fetchChunk(chunk)
      buffers.push(buf)
    }

    const total = Buffer.concat(buffers)
    log.debug(`synthesize() done: ${total.length} bytes (mp3)`)
    return total
  }

  async *streamSpeech(text: string): AsyncGenerator<Buffer> {
    const chunks = this.splitText(text)
    for (const chunk of chunks) {
      const buf = await this.fetchChunk(chunk)
      yield buf
    }
  }
}
