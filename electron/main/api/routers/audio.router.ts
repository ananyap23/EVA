import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { trpcRouter, publicProcedure } from '@electron/api/context'
import { mainEventBus } from '@electron/utils/eventBus'
import { createLogger } from '@electron/utils/logger'
import { getConfig } from '@electron/utils/config'
import type { STTService } from '@electron/services/stt/STTService'
import { getModelStatus as getModelStatusForLanguage } from '@electron/services/stt/ModelManager'

const log = createLogger('audio.router')

let sttService: STTService | null = null

/** Wire STTService into the router (called from index.ts) */
export function setSTTService(stt: STTService): void {
  sttService = stt
}

/**
 * audio.router — audio/voice + TTS + STT endpoints.
 */
export const audioRouter = trpcRouter({

  // ── STT ──

  /** Start listening for voice input */
  startListening: publicProcedure.mutation(() => {
    sttService?.setListening(true)
    return { ok: true }
  }),

  /** Stop listening for voice input */
  stopListening: publicProcedure.mutation(() => {
    sttService?.setListening(false)
    return { ok: true }
  }),

  /** Subscribe to speech-to-text transcript chunks */
  onTranscript: publicProcedure.subscription(() => {
    return observable<{ text: string; isFinal: boolean }>((emit) => {
      function onTranscript(payload: { text: string; isFinal: boolean }) {
        emit.next(payload)
      }

      mainEventBus.on('audio:transcript', onTranscript)

      return () => {
        mainEventBus.off('audio:transcript', onTranscript)
      }
    })
  }),

  /** Get STT model status (downloaded, path) for a given or configured language */
  getSTTModelStatus: publicProcedure
    .input(z.object({ language: z.string().optional() }).optional())
    .query(({ input }) => {
      if (!sttService) return { downloaded: false, path: '' }
      if (input?.language) {
        // Check status for a specific language (used when user changes language in UI)
        return getModelStatusForLanguage(input.language)
      }
      return sttService.getModelStatus()
    }),

  /** Get model path for renderer to load */
  getSTTModelPath: publicProcedure.query(() => {
    if (!sttService) return ''
    return sttService.getModelPath()
  }),

  /** Get available STT languages */
  getSTTLanguages: publicProcedure.query(() => {
    if (!sttService) return []
    return sttService.getAvailableLanguages()
  }),

  /** Download STT model for a language */
  downloadSTTModel: publicProcedure
    .input(z.object({ language: z.string() }))
    .mutation(async ({ input }) => {
      if (!sttService) throw new Error('STTService not available')
      await sttService.downloadModel(input.language)
      return { ok: true }
    }),

  /** Subscribe to STT model download progress */
  onSTTModelStatus: publicProcedure.subscription(() => {
    return observable<{ downloaded: boolean; progress?: number; error?: string }>((emit) => {
      function onStatus(payload: { downloaded: boolean; progress?: number; error?: string }) {
        emit.next(payload)
      }

      mainEventBus.on('stt:model-status', onStatus)

      return () => {
        mainEventBus.off('stt:model-status', onStatus)
      }
    })
  }),

  /** Transcribe recorded speech audio via offline Whisper flow */
  transcribeAudio: publicProcedure
    .input(z.object({ audioBase64: z.string(), language: z.string().optional() }))
    .mutation(async ({ input }) => {
      if (!sttService) throw new Error('STTService is not available')
      const buffer = Buffer.from(input.audioBase64, 'base64')
      const text = await sttService.transcribeAudio(buffer, input.language)
      return { text }
    }),

  /** Test connectivity to offline Whisper endpoint */
  testWhisper: publicProcedure
    .input(z.object({ endpoint: z.string().optional(), apiKey: z.string().optional() }).optional())
    .mutation(async ({ input }) => {
      if (!sttService) return { ok: false, error: 'STTService not available' }
      return sttService.testWhisperConnection(input?.endpoint, input?.apiKey)
    }),

  // ── TTS (Phase 3.5) ──

  /** Trigger TTS to speak text */
  speak: publicProcedure
    .input(z.object({ text: z.string() }))
    .mutation(({ input }) => {
      log.info(`TTS speak: ${input.text.length} chars`)
      mainEventBus.emit('tts:speak', { text: input.text })
      return { ok: true }
    }),

  /** Stop current TTS playback */
  stopSpeaking: publicProcedure.mutation(() => {
    log.info('TTS stop')
    mainEventBus.emit('tts:stop')
    return { ok: true }
  }),

  /** Subscribe to TTS speaking status */
  onTTSStatus: publicProcedure.subscription(() => {
    return observable<{ speaking: boolean }>((emit) => {
      function onStatus(payload: { speaking: boolean }) {
        emit.next(payload)
      }

      mainEventBus.on('tts:status', onStatus)

      return () => {
        mainEventBus.off('tts:status', onStatus)
      }
    })
  }),

  /** Subscribe to TTS audio format (mpeg, opus, or web-speech) — emitted when speech starts */
  onTTSFormat: publicProcedure.subscription(() => {
    return observable<{ format: 'mpeg' | 'opus' | 'web-speech' }>((emit) => {
      function onFormat(payload: { format: 'mpeg' | 'opus' | 'web-speech' }) {
        emit.next(payload)
      }

      mainEventBus.on('tts:format', onFormat)

      return () => {
        mainEventBus.off('tts:format', onFormat)
      }
    })
  }),

  /** Subscribe to TTS audio chunks (base64-encoded) */
  onTTSAudio: publicProcedure.subscription(() => {
    return observable<{ data: string; done: boolean }>((emit) => {
      function onAudio(payload: { chunk: Buffer; done: boolean }) {
        emit.next({
          data: payload.chunk.toString('base64'),
          done: payload.done,
        })
      }

      mainEventBus.on('tts:audio', onAudio)

      return () => {
        mainEventBus.off('tts:audio', onAudio)
      }
    })
  }),

  /** Subscribe to Web Speech synthesis requests */
  onTTSText: publicProcedure.subscription(() => {
    return observable<{ text: string; voice?: string; rate?: number; pitch?: number }>((emit) => {
      function onText(payload: { text: string; voice?: string; rate?: number; pitch?: number }) {
        emit.next(payload)
      }

      mainEventBus.on('tts:speak-text', onText)

      return () => {
        mainEventBus.off('tts:speak-text', onText)
      }
    })
  }),

  /** Auto-detect the best TTS voice engine based on user PC hardware, locale, and network */
  detectOptimalTTS: publicProcedure.query(async () => {
    const cfg = getConfig()

    // 1. If ElevenLabs API key is configured, recommend ElevenLabs for maximum human realism
    if (cfg.tts.apiKey && cfg.tts.apiKey.trim().length > 10) {
      return {
        recommendedProvider: 'elevenlabs',
        label: '🎙️ ElevenLabs (AI Realistic Voice)',
        reason: 'Active API key detected — provides emotional nuances and ultra-realistic voices.',
      }
    }

    // 2. If language is Russian, recommend Yandex Alice
    if (cfg.stt.language === 'ru' || cfg.tts.accent === 'ru') {
      return {
        recommendedProvider: 'yandex-alice',
        label: '🇷🇺 Yandex Alice (Neural Russian Voice)',
        reason: 'Optimal for Russian speech synthesis with natural inflection.',
      }
    }

    // 3. Check connectivity to Google Translate TTS
    let isOnline = false
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const res = await fetch('https://translate.google.com', { method: 'HEAD', signal: controller.signal })
      clearTimeout(timer)
      isOnline = res.ok || res.status === 302 || res.status === 200
    } catch {
      isOnline = false
    }

    if (isOnline) {
      return {
        recommendedProvider: 'google-translate',
        label: '🌍 Google Free Voice (Multi-Accent, Zero API Key)',
        reason: 'Ultra-low latency, zero API keys required, and natural regional accents.',
      }
    }

    // 4. Offline fallback
    return {
      recommendedProvider: 'web-speech',
      label: '🔊 Web Speech (Local System Voice / Offline)',
      reason: 'Runs completely offline using your Windows installed voices with zero latency.',
    }
  }),
})
