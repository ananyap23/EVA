import { KokoroTTSProvider } from './providers/KokoroTTSProvider'
import { BaseService } from '@electron/services/base/BaseService'
import { BaseTTSProvider } from './providers/BaseTTSProvider'
import { ElevenLabsProvider } from './providers/ElevenLabsProvider'
import { YandexAliceProvider } from './providers/YandexAliceProvider'
import { GoogleTranslateTTSProvider } from './providers/GoogleTranslateTTSProvider'
import { getConfig, saveConfig, type AppConfig } from '@electron/utils/config'
import { mainEventBus } from '@electron/utils/eventBus'
import { formatTTSError, isTTSQuotaError } from '@electron/utils/ttsErrors'
import type { PersonaService } from '@electron/services/persona/PersonaService'

/**
 * TTSService — manages TTS provider lifecycle and speech synthesis.
 *
 * Reads provider name, API key, voice ID, and model from config.
 * Supports per-persona voice overrides via PersonaService.
 *
 * Listens for `tts:speak` events from the AgentLoop and
 * emits `tts:audio` chunks + `tts:status` updates.
 */

/**
 * Strip markdown, code blocks, URLs, and noisy symbols so TTS produces smooth, natural speech
 * without literally pronouncing hyphens, asterisks, brackets, or code junk.
 */
export function cleanTextForSpeech(raw: string): string {
  if (!raw) return ''
  let text = raw
  // Code blocks
  text = text.replace(/```[\s\S]*?```/g, '')
  // Inline code
  text = text.replace(/`([^`]+)`/g, '$1')
  // URLs
  text = text.replace(/https?:\/\/\S+/gi, '')
  // Images and markdown links
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // HTML tags
  text = text.replace(/<[^>]+>/g, '')
  // Markdown headers (#) and blockquotes (>)
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/^>\s+/gm, '')
  // Tables
  text = text.replace(/\|/g, ' ')
  // Bullet lists (- , * , + ) -> natural comma pause
  text = text.replace(/^[\s*+-]+\s+/gm, '')
  // Bold, italics, strikethrough (*, **, _, ~)
  text = text.replace(/[*_~]{1,3}/g, '')
  // Remove clusters of symbols like &^((*$( or -----
  text = text.replace(/[-_=+~`!@#$%^&*()[\]{}|\\:;"'<>,.?/]{3,}/g, ' ')
  // Remove isolated special characters that TTS pronounces literally
  text = text.replace(/\s[&^$#@|~\\/<>+=]\s/g, ' ')
  // Normalize hyphens/dashes between words to natural commas or spaces
  text = text.replace(/\s+[-–—]+\s+/g, ', ')
  // Clean multiple newlines and spaces
  text = text.replace(/\n{2,}/g, '. ')
  text = text.replace(/\n/g, ' ')
  text = text.replace(/\s{2,}/g, ' ')
  return text.trim()
}

export class TTSService extends BaseService {
  private provider: BaseTTSProvider | null = null
  private speaking = false
  private abortController: AbortController | null = null
  private personaService: PersonaService | null = null
  private activeVoiceId = ''
  private activeProviderName = ''
  private activeApiKey = ''
  private activeKokoroVoice = ''
  private activeKokoroDtype = ''
  private activeAccent = ''

  // Bound handlers for proper add/remove
  private readonly boundOnSpeak = this.onSpeak.bind(this)
  private readonly boundOnStop = this.onStop.bind(this)
  private readonly boundOnPersonaSwitched = this.onPersonaSwitched.bind(this)
  private readonly boundOnConfigChanged = this.onConfigChanged.bind(this)

  /** Set after both services are registered (avoids circular dep) */
  setPersonaService(ps: PersonaService): void {
    this.personaService = ps
  }

  async init(): Promise<void> {
    // Always register event listeners so runtime enable/disable works
    mainEventBus.on('tts:speak', this.boundOnSpeak)
    mainEventBus.on('tts:stop', this.boundOnStop)
    mainEventBus.on('persona:switched', this.boundOnPersonaSwitched)
    mainEventBus.on('config:changed', this.boundOnConfigChanged)

    const config = getConfig()

    if (!config.tts.enabled) {
      this.log.info('TTS is disabled in config — listeners registered, provider skipped')
      return
    }

    const effective = this.resolveEffectiveProvider(config)
    const needsApiKey = effective === 'elevenlabs'

    if (needsApiKey && !config.tts.apiKey) {
      this.log.warn('No TTS API key configured — TTS calls will fail')
      mainEventBus.emit('agent:warning', {
        id: 'missing-tts-key',
        message: 'TTS API key not configured. Set your API key in settings or select Web Speech / Google Free Voice for free voice output.',
        dismissable: true,
      })
      return
    }

    this.createProvider(effective, config.tts.apiKey, this.getActiveVoiceId())
    this.log.info(`TTSService initialized (provider: ${config.tts.provider}, effective: ${effective})`)
  }

  /**
   * Determine the most effective TTS provider for this machine configuration.
   */
  resolveEffectiveProvider(config?: AppConfig): string {
    const cfg = config || getConfig()
    if (cfg.tts.provider && cfg.tts.provider !== 'auto') {
      return cfg.tts.provider
    }

    // Auto-detect best engine:
    // 1. If ElevenLabs API key is configured, use ElevenLabs for maximum human realism
    if (cfg.tts.apiKey && cfg.tts.apiKey.trim().length > 10) {
      return 'elevenlabs'
    }

    // 2. If language is Russian, use Yandex Alice
    if (cfg.stt.language === 'ru' || cfg.tts.accent === 'ru') {
      return 'yandex-alice'
    }

    // 3. Default to Google Free Voice (zero API key, natural multi-accent neural audio)
    return 'google-translate'
  }

  async dispose(): Promise<void> {
    this.stop()
    this.disposeProvider()
    mainEventBus.off('tts:speak', this.boundOnSpeak)
    mainEventBus.off('tts:stop', this.boundOnStop)
    mainEventBus.off('persona:switched', this.boundOnPersonaSwitched)
    mainEventBus.off('config:changed', this.boundOnConfigChanged)
    this.provider = null
    this.log.info('TTSService disposed')
  }

  /** Dispose current provider (close connections etc.) */
  private disposeProvider(): void {
    if (this.provider instanceof YandexAliceProvider) {
      this.provider.close()
    }
  }

  /**
   * Get the voice ID to use — persona override > global config.
   */
  private getActiveVoiceId(): string {
    const persona = this.personaService?.getActive()
    if (persona?.ttsVoiceId) {
      return persona.ttsVoiceId
    }
    return getConfig().tts.voiceId
  }

  /** Audio format for the current provider */
  get audioFormat(): 'mpeg' | 'opus' | 'wav' | 'web-speech' {
    const config = getConfig()
    const effective = this.resolveEffectiveProvider(config)
    if (effective === 'web-speech') return 'web-speech'
    if (this.provider?.name === 'kokoro') return 'wav'
    return this.provider?.name === 'yandex-alice' ? 'opus' : 'mpeg'
  }

  /** Create a provider by name */
  private createProvider(name: string, apiKey: string, voiceId: string): void {
    const config = getConfig()
    const resolved = name === 'auto' ? this.resolveEffectiveProvider(config) : name

    // Dispose previous provider before creating a new one
    this.disposeProvider()

    switch (resolved) {
      case 'kokoro':
        this.provider = new KokoroTTSProvider(config.tts.kokoroVoice || 'af_heart', config.tts.kokoroDtype || 'q8')
        break
      case 'web-speech':
        this.provider = null
        break
      case 'yandex-alice':
        this.provider = new YandexAliceProvider()
        break
      case 'google-translate':
        this.provider = new GoogleTranslateTTSProvider(config.tts.accent || 'en-US')
        break
      case 'elevenlabs':
        this.provider = new ElevenLabsProvider(apiKey, voiceId, config.tts.model)
        break
      default:
        this.provider = new GoogleTranslateTTSProvider(config.tts.accent || 'en-US')
    }
  }

  /** Switch provider at runtime */
  setProvider(name: string): void {
    const config = getConfig()
    const resolved = name === 'auto' ? this.resolveEffectiveProvider(config) : name
    const needsApiKey = resolved === 'elevenlabs'
    if (needsApiKey && !config.tts.apiKey) {
      this.log.error('Cannot switch TTS provider: no API key')
      return
    }
    this.createProvider(resolved, config.tts.apiKey, this.getActiveVoiceId())
    this.log.info(`Switched TTS to provider: ${name} (resolved: ${resolved})`)
  }

  /** Toggle TTS on/off */
  setEnabled(enabled: boolean): void {
    saveConfig({ tts: { enabled } })
    this.log.info(`TTS ${enabled ? 'enabled' : 'disabled'}`)

    if (enabled && !this.provider) {
      const config = getConfig()
      if (config.tts.apiKey || config.tts.provider === 'yandex-alice' || config.tts.provider === 'web-speech' || config.tts.provider === 'google-translate') {
        this.createProvider(config.tts.provider, config.tts.apiKey, this.getActiveVoiceId())
      }
    }

    if (!enabled) {
      this.stop()
    }
  }

  /** Whether the service has a usable provider */
  get isReady(): boolean {
    const config = getConfig()
    if (config.tts.provider === 'web-speech') return config.tts.enabled
    return this.provider !== null && config.tts.enabled
  }

  /** Speak text — streams audio chunks via event bus */
  async speak(rawText: string): Promise<void> {
    const text = cleanTextForSpeech(rawText)
    if (!text) return
    const config = getConfig()

    if (!config.tts.enabled) {
      this.log.debug('TTS disabled, skipping speech')
      return
    }

    const effectiveProvider = this.resolveEffectiveProvider(config)

    // Web Speech browser-native playback
    if (effectiveProvider === 'web-speech') {
      this.stop()
      this.speaking = true
      mainEventBus.emit('tts:status', { speaking: true })
      mainEventBus.emit('tts:format', { format: 'web-speech' })
      mainEventBus.emit('tts:speak-text', {
        text,
        voice: this.getActiveVoiceId(),
        rate: config.tts.rate ?? 1.0,
        pitch: config.tts.pitch ?? 1.0,
      })
      return
    }

    if (effectiveProvider === 'google-translate') {
      const targetAccent = config.tts.accent || 'en-US'
      if (!this.provider || !(this.provider instanceof GoogleTranslateTTSProvider)) {
        this.createProvider('google-translate', '', '')
      } else if ((this.provider as GoogleTranslateTTSProvider).currentAccent !== targetAccent) {
        (this.provider as GoogleTranslateTTSProvider).setAccent(targetAccent)
      }
    }

    if (!this.provider) {
      this.createProvider(effectiveProvider, config.tts.apiKey, this.getActiveVoiceId())
    }

    if (!this.provider) {
      this.log.warn('No TTS provider configured, falling back to Web Speech')
      mainEventBus.emit('tts:speak-text', {
        text,
        voice: this.getActiveVoiceId(),
        rate: config.tts.rate ?? 1.0,
        pitch: config.tts.pitch ?? 1.0,
      })
      return
    }

    // Only recreate provider if the voice changed (avoid unnecessary client creation)
    const targetVoice = this.getActiveVoiceId()
    if (config.tts.apiKey && this.activeVoiceId !== targetVoice) {
      this.createProvider(effectiveProvider, config.tts.apiKey, targetVoice)
      this.activeVoiceId = targetVoice
    }

    // Stop any ongoing speech
    this.stop()

    this.speaking = true
    this.abortController = new AbortController()
    mainEventBus.emit('tts:status', { speaking: true })
    mainEventBus.emit('tts:format', { format: this.audioFormat })

    try {
      const stream = this.provider.streamSpeech(text)

      for await (const chunk of stream) {
        if (this.abortController?.signal.aborted) {
          this.log.debug('Speech aborted')
          break
        }

        mainEventBus.emit('tts:audio', { chunk, done: false })
      }

      if (!this.abortController?.signal.aborted) {
        mainEventBus.emit('tts:audio', { chunk: Buffer.alloc(0), done: true })
      }
    } catch (err) {
      const message = formatTTSError(err)
      this.log.error('TTS stream error, falling back to Web Speech:', err)

      // Fall back to Web Speech synthesis so audio is never dropped
      mainEventBus.emit('tts:speak-text', {
        text,
        voice: this.getActiveVoiceId(),
        rate: config.tts.rate ?? 1.0,
        pitch: config.tts.pitch ?? 1.0,
      })

      // Surface error as a dismissable warning in WarningIsland
      mainEventBus.emit('agent:warning', {
        id: 'tts-runtime-error',
        message,
        dismissable: true,
      })

      // Auto-disable TTS on quota exhaustion to avoid spamming failed requests
      if (isTTSQuotaError(err)) {
        this.log.warn('TTS quota exhausted — auto-disabling TTS')
        this.provider = null
        saveConfig({ tts: { enabled: false } })

        // Override warning with explicit "disabled" message
        mainEventBus.emit('agent:warning', {
          id: 'tts-runtime-error',
          message: 'ElevenLabs quota exhausted. TTS has been automatically disabled. Re-enable in Settings → TTS when credits reset.',
          dismissable: true,
        })
      }
    } finally {
      this.speaking = false
      this.abortController = null
      mainEventBus.emit('tts:status', { speaking: false })
    }
  }

  /** Stop current speech */
  stop(): void {
    if (this.speaking) {
      this.abortController?.abort()
      this.speaking = false
      mainEventBus.emit('tts:status', { speaking: false })
      mainEventBus.emit('tts:stop-audio')
      this.log.debug('TTS speech stopped')
    }
  }

  /** Event handler: tts:speak */
  private async onSpeak(payload: { text: string }): Promise<void> {
    await this.speak(payload.text)
  }

  /** Event handler: tts:stop */
  private onStop(): void {
    this.stop()
  }

  /** Event handler: persona:switched — rebuild provider with new voice */
  private onPersonaSwitched(): void {
    const config = getConfig()
    if (config.tts.apiKey && config.tts.enabled) {
      const voiceId = this.getActiveVoiceId()
      this.createProvider(config.tts.provider, config.tts.apiKey, voiceId)
      this.log.info(`TTS voice updated for persona: ${voiceId}`)
    }
  }

  /** Event handler: config:changed — apply TTS settings in realtime */
  private onConfigChanged(config: AppConfig): void {
    if (!config.tts.enabled) {
      if (this.provider) {
        this.stop()
        this.disposeProvider()
        this.provider = null
        this.log.info('TTS disabled at runtime')
      }
      return
    }

    const effective = this.resolveEffectiveProvider(config)
    const voiceId = this.getActiveVoiceId()
    const apiKey = config.tts.apiKey || ''
    const kokoroVoice = config.tts.kokoroVoice || 'af_heart'
    const kokoroDtype = config.tts.kokoroDtype || 'q8'
    const accent = config.tts.accent || 'en-US'

    // Prevent rebuilding providers on every unrelated config save!
    if (
      this.provider &&
      this.activeProviderName === effective &&
      this.activeVoiceId === voiceId &&
      this.activeApiKey === apiKey &&
      this.activeKokoroVoice === kokoroVoice &&
      this.activeKokoroDtype === kokoroDtype &&
      this.activeAccent === accent
    ) {
      return
    }

    this.activeProviderName = effective
    this.activeVoiceId = voiceId
    this.activeApiKey = apiKey
    this.activeKokoroVoice = kokoroVoice
    this.activeKokoroDtype = kokoroDtype
    this.activeAccent = accent

    const needsApiKey = effective === 'elevenlabs'
    if (!needsApiKey || apiKey) {
      mainEventBus.emit('agent:dismiss-warning', { id: 'missing-tts-key' })
      this.createProvider(effective, apiKey, voiceId)
      this.log.info('TTS provider (re)built from config change')
    }
  }
}
