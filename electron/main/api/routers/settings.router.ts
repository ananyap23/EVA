import { createLogger } from '@electron/utils/logger'
const log = createLogger('SettingsRouter')
import { z } from 'zod'
import { app } from 'electron'
import { observable } from '@trpc/server/observable'
import { trpcRouter, publicProcedure } from '@electron/api/context'
import { getConfig, saveConfig, defaultConfig, type AppConfig } from '@electron/utils/config'
import { mainEventBus } from '@electron/utils/eventBus'
import { PromptLoader } from '@electron/services/intelligence/PromptLoader'
import { OllamaModelManager } from '@electron/services/intelligence/OllamaModelManager'
import { openLogsFolder } from '@electron/utils/sessionLogger'

const promptLoader = new PromptLoader()

/**
 * settings.router — config & prompt management.
 *
 * Config: read / write AppConfig (persisted to Config).
 * Prompts: list / read / save / reset .md prompt templates.
 */

const uiSchema = z.object({
  positionSide: z.enum(['left', 'right', 'center']).optional(),
  alwaysOnTop: z.boolean().optional(),
  openDevTools: z.boolean().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  debugLog: z.boolean().optional(),
  soundEnabled: z.boolean().optional(),
  soundVolume: z.number().min(0).max(1).optional(),
}).optional()

const llmSchema = z.object({
  provider: z.string().optional(),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  textModel: z.string().optional(),
  visionModel: z.string().optional(),
  classifierModel: z.string().optional(),
  separateVisionModel: z.boolean().optional(),
  ollamaModel: z.string().optional(),
  ollamaIdleMinutes: z.number().optional(),
  ollamaContextSize: z.number().optional(),
}).optional()

const generationSchema = z.object({
  chatTemperature: z.number().min(0).max(2).optional(),
  chatTopP: z.number().min(0).max(1).optional(),
  chatTopK: z.number().int().min(1).optional(),
  chatMaxTokens: z.number().int().min(1).optional(),
  visionTemperature: z.number().min(0).max(2).optional(),
  visionMaxTokens: z.number().int().min(1).optional(),
}).optional()

const ttsSchema = z.object({
  provider: z.string().optional(),
  apiKey: z.string().optional(),
  voiceId: z.string().optional(),
  model: z.string().optional(),
  enabled: z.boolean().optional(),
  speakerDeviceId: z.string().optional(),
  rate: z.number().optional(),
  pitch: z.number().optional(),
  style: z.string().optional(),
  accent: z.string().optional(),
  kokoroVoice: z.string().optional(),
  kokoroDtype: z.string().optional(),
}).optional()

const agentSchema = z.object({
  maxIterations: z.number().int().min(1).optional(),
  maxConsecutiveFailures: z.number().int().min(1).optional(),
  preActionDelay: z.number().int().min(0).optional(),
  postActionDelay: z.number().int().min(0).optional(),
  maxContextMessages: z.number().int().min(1).optional(),
  commandTimeout: z.number().int().min(1000).optional(),
  screenshotMaxWidth: z.number().int().min(640).optional(),
  screenshotQuality: z.number().int().min(1).max(100).optional(),
}).optional()

const sttSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['handy', 'groq-whisper', 'faster-whisper', 'in-app-whisper', 'hybrid', 'whisper', 'vosk']).optional(),
  language: z.string().optional(),
  micDeviceId: z.string().optional(),
  wakeWord: z.string().optional(),
  micHotkey: z.string().optional(),
  whisperEndpoint: z.string().optional(),
  whisperModel: z.string().optional(),
  whisperApiKey: z.string().optional(),
  inAppWhisperModel: z.string().optional(),
  groqApiKey: z.string().optional(),
  handyEndpoint: z.string().optional(),
}).optional()

export const settingsRouter = trpcRouter({
  /** Get full current config */
  getConfig: publicProcedure.query((): AppConfig => {
    return getConfig()
  }),

  /** Save partial config updates → disk + notify subscribers */
  saveConfig: publicProcedure
    .input(z.object({
      ui: uiSchema,
      llm: llmSchema,
      generation: generationSchema,
      tts: ttsSchema,
      stt: sttSchema,
      agent: agentSchema,
      hotkey: z.string().optional(),
      activePersonaId: z.string().optional(),
    }))
    .mutation(({ input }) => {
      // Prevent stale activePersonaId from the frontend overwriting the
      // value set by PersonaService.switch() — persona switching has its
      // own dedicated API, settings save should never change it.
      const { activePersonaId: _ignored, ...safeInput } = input
      saveConfig(safeInput as any)
      const updated = getConfig()
      mainEventBus.emit('config:changed', updated)
      return updated
    }),

  /** Subscribe to config changes */
  onConfigChange: publicProcedure.subscription(() => {
    return observable<AppConfig>((emit) => {
      const handler = (config: AppConfig) => emit.next(config)
      mainEventBus.on('config:changed', handler)
      return () => {
        mainEventBus.removeListener('config:changed', handler)
      }
    })
  }),

  /** List available prompt names */
  listPrompts: publicProcedure
    .input(z.object({ personaId: z.string().optional() }).optional())
    .query(({ input }): string[] => {
      return promptLoader.list(input?.personaId)
    }),

  /** Get prompt content by name */
  getPrompt: publicProcedure
    .input(z.object({ name: z.string(), personaId: z.string().optional() }))
    .query(({ input }): string => {
      return promptLoader.load(input.name, undefined, input.personaId)
    }),

  /** Save prompt content */
  savePrompt: publicProcedure
    .input(z.object({ name: z.string(), content: z.string(), personaId: z.string().optional() }))
    .mutation(({ input }) => {
      promptLoader.save(input.name, input.content, input.personaId)
      mainEventBus.emit('prompt:saved', { name: input.name, personaId: input.personaId })
      return true
    }),

  /** Reset prompt to bundled default */
  resetPrompt: publicProcedure
    .input(z.object({ name: z.string(), personaId: z.string().optional() }))
    .mutation(({ input }) => {
      promptLoader.reset(input.name, input.personaId)
      mainEventBus.emit('prompt:saved', { name: input.name, personaId: input.personaId })
      return promptLoader.load(input.name, undefined, input.personaId)
    }),

  /** Open session logs folder in OS file manager */
  openSessionLogs: publicProcedure.mutation(async () => {
    await openLogsFolder()
    return true
  }),

  /** Open full log file in OS default application */
  openLogFile: publicProcedure.mutation(async () => {
    const { openLogFile } = await import('@electron/utils/logger')
    await openLogFile()
    return true
  }),

  /** Reset a config section to factory defaults */
  resetSection: publicProcedure
    .input(z.object({ section: z.enum(['ui', 'llm', 'generation', 'tts', 'stt', 'agent']) }))
    .mutation(({ input }) => {
      const defaults = defaultConfig[input.section]
      saveConfig({ [input.section]: defaults } as Partial<AppConfig>)
      const updated = getConfig()
      mainEventBus.emit('config:changed', updated)
      return updated
    }),

  /** Test connection to local LLM endpoint (e.g. Ollama, LM Studio, vLLM) and fetch available models */
  
  /** Fetch recent Google Gemini models using API key */
  fetchGeminiModels: publicProcedure
    .input(z.object({ apiKey: z.string() }))
    .mutation(async ({ input }) => {
      const fallbackLatest = [
        'gemini-3.1-flash-lite-preview',
        'gemini-3-flash',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.0-flash',
        'gemini-2.0-flash-exp',
        'gemini-1.5-flash',
        'gemini-1.5-pro',
      ]

      if (!input.apiKey || !input.apiKey.trim()) {
        return { ok: true, models: fallbackLatest, isLive: false }
      }

      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${input.apiKey.trim()}`, {
          method: 'GET',
          signal: AbortSignal.timeout(7000),
        })

        if (!res.ok) {
          return {
            ok: false,
            error: `Gemini API returned HTTP ${res.status}: ${res.statusText}`,
            models: fallbackLatest,
            isLive: false,
          }
        }

        const data = await res.json()
        const rawModels: any[] = data.models || []

        // Filter models that support generateContent (exclude embeddings/AQA)
        const genModels = rawModels.filter((m) => {
          const methods = m.supportedGenerationMethods || []
          return methods.includes('generateContent')
        })

        // Sort dynamically by version descending (3.1 > 3.0 > 2.5 > 2.0 > 1.5)
        const allModels = genModels
          .map((m) => m.name.replace(/^models\//, ''))
          .filter((name) => name.toLowerCase().includes('gemini'))
          .sort((a, b) => {
            const matchA = a.match(/gemini-(\d+(?:\.\d+)?)/i)
            const matchB = b.match(/gemini-(\d+(?:\.\d+)?)/i)
            const verA = matchA ? parseFloat(matchA[1]) : 0
            const verB = matchB ? parseFloat(matchB[1]) : 0

            if (verB !== verA) return verB - verA
            // Flash before pro for faster latency
            if (a.includes('flash') && !b.includes('flash')) return -1
            if (!a.includes('flash') && b.includes('flash')) return 1
            return a.localeCompare(b)
          })

        return {
          ok: true,
          models: allModels.length > 0 ? allModels : fallbackLatest,
          isLive: true,
        }
      } catch (err: any) {
        return {
          ok: false,
          error: err.message || 'Connection error to Gemini API',
          models: fallbackLatest,
          isLive: false,
        }
      }
    }),

  /** Fetch Groq models using API key with Whisper filtering */
  fetchGroqModels: publicProcedure
    .input(z.object({ apiKey: z.string() }))
    .mutation(async ({ input }) => {
      const fallbackWhisper = [
        'whisper-large-v3-turbo',
        'whisper-large-v3',
        'distil-whisper-large-v3-en',
      ]

      if (!input.apiKey || !input.apiKey.trim()) {
        return { ok: true, models: fallbackWhisper, whisperModels: fallbackWhisper, isLive: false }
      }

      try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${input.apiKey.trim()}`,
          },
          signal: AbortSignal.timeout(7000),
        })

        if (!res.ok) {
          return {
            ok: false,
            error: `Groq API returned HTTP ${res.status}: ${res.statusText}`,
            models: fallbackWhisper,
            whisperModels: fallbackWhisper,
            isLive: false,
          }
        }

        const data = (await res.json()) as { data?: Array<{ id: string }> }
        const rawModels: Array<{ id: string }> = data.data || []
        const allModelIds = rawModels.map((m) => m.id)
        const whisperModels = allModelIds.filter((id) => id.toLowerCase().includes('whisper'))

        whisperModels.sort((a, b) => {
          if (a.includes('turbo') && !b.includes('turbo')) return -1
          if (!a.includes('turbo') && b.includes('turbo')) return 1
          return a.localeCompare(b)
        })

        return {
          ok: true,
          models: allModelIds,
          whisperModels: whisperModels.length > 0 ? whisperModels : fallbackWhisper,
          isLive: true,
        }
      } catch (err: any) {
        return {
          ok: false,
          error: err.message || 'Connection error to Groq API',
          models: fallbackWhisper,
          whisperModels: fallbackWhisper,
          isLive: false,
        }
      }
    }),

  testLocalLLM: publicProcedure
    .input(z.object({
      baseURL: z.string(),
      apiKey: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const isOllama = input.baseURL.includes('11434') || input.baseURL.toLowerCase().includes('ollama')
      let wasStarted = false

      // Helper: check if Ollama port is responding
      const checkOllamaAlive = async (host = '127.0.0.1') => {
        try {
          const res = await fetch(`http://${host}:11434/`, { signal: AbortSignal.timeout(1500) })
          return res.ok
        } catch {
          return false
        }
      }

      // Auto-start Ollama if not running
      if (isOllama) {
        const isUp = (await checkOllamaAlive('127.0.0.1')) || (await checkOllamaAlive('localhost'))
        if (!isUp) {
          try {
            const { spawn } = await import('node:child_process')
            const path = await import('node:path')
            const fs = await import('node:fs')

            const defaultPath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
            const ollamaBin = fs.existsSync(defaultPath) ? defaultPath : 'ollama'

            log.info(`Attempting to auto-start Ollama service via ${ollamaBin} serve...`)
            const child = spawn(ollamaBin, ['serve'], {
              detached: true,
              stdio: 'ignore',
              shell: true,
              windowsHide: true,
            })
            child.unref()

            // Wait up to 10 seconds for Ollama to come online
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 500))
              if ((await checkOllamaAlive('127.0.0.1')) || (await checkOllamaAlive('localhost'))) {
                wasStarted = true
                log.info('Ollama service auto-started and ready!')
                break
              }
            }
          } catch (launchErr) {
            log.warn('Could not auto-start Ollama:', launchErr)
          }
        }
      }

      // Prepare candidate URLs (swap localhost <-> 127.0.0.1 to avoid Windows IPv6 delays)
      const rawUrl = input.baseURL.trim().replace(/\/+$/, '')
      const candidateBases = [rawUrl]
      if (rawUrl.includes('localhost')) {
        candidateBases.push(rawUrl.replace('localhost', '127.0.0.1'))
      } else if (rawUrl.includes('127.0.0.1')) {
        candidateBases.push(rawUrl.replace('127.0.0.1', 'localhost'))
      }

      let lastError = ''
      const modelsFound = new Set<string>()

      for (const base of candidateBases) {
        const v1Url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
        const nativeTagsUrl = `${base.replace(/\/v1$/, '')}/api/tags`

        const headers: Record<string, string> = {}
        if (input.apiKey && input.apiKey.trim()) {
          headers['Authorization'] = `Bearer ${input.apiKey.trim()}`
        }

        // Try /v1/models (OpenAI standard)
        try {
          const res = await fetch(v1Url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(6000),
          })
          if (res.ok) {
            const data = (await res.json()) as { data?: Array<{ id: string }> }
            if (Array.isArray(data?.data)) {
              for (const m of data.data) {
                if (m.id) modelsFound.add(m.id)
              }
            }
          } else {
            lastError = `HTTP ${res.status}: ${res.statusText}`
          }
        } catch (e: any) {
          lastError = e?.message || String(e)
        }

        // Try /api/tags (Ollama native standard)
        if (modelsFound.size === 0 || isOllama) {
          try {
            const res = await fetch(nativeTagsUrl, {
              method: 'GET',
              headers,
              signal: AbortSignal.timeout(4000),
            })
            if (res.ok) {
              const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> }
              if (Array.isArray(data?.models)) {
                for (const m of data.models) {
                  const name = m.name || m.model
                  if (name) modelsFound.add(name)
                }
              }
            }
          } catch (e: any) {
            if (!lastError) lastError = e?.message || String(e)
          }
        }

        if (modelsFound.size > 0) break
      }

      const allModels = Array.from(modelsFound)

      // For Ollama: also probe each model's vision capability via /api/show
      let visionModels: string[] = []
      if (isOllama && allModels.length > 0) {
        const ollamaBase = rawUrl.replace(/\/v1\/?$/, '')
        const visionChecks = await Promise.allSettled(
          allModels.map(async (name) => {
            try {
              const showRes = await fetch(`${ollamaBase}/api/show`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
                signal: AbortSignal.timeout(3000),
              })
              if (!showRes.ok) return null
              const showData = await showRes.json()
              const families: string[] = showData.details?.families || []
              const infoKeys = Object.keys(showData.model_info || {})
              const isVision =
                families.some((f: string) => /clip|mllama|vision|vl|llava|minicpm/i.test(f)) ||
                infoKeys.some((k: string) => k.includes('.vision.') || k.includes('.clip.') || k.includes('projector') || k.includes('mllama')) ||
                Boolean(showData.projector_info)
              return isVision ? name : null
            } catch {
              return null
            }
          })
        )
        visionModels = visionChecks
          .filter((r) => r.status === 'fulfilled' && r.value !== null)
          .map((r: any) => r.value as string)
      }

      if (allModels.length > 0) {
        return {
          ok: true,
          models: allModels,
          visionModels,
          message: wasStarted
            ? `Ollama launched & verified! Found ${allModels.length} model(s), ${visionModels.length} vision-capable`
            : `Connected! Found ${allModels.length} local model(s), ${visionModels.length} vision-capable`,
        }
      }

      return {
        ok: false,
        models: [],
        visionModels: [],
        error: lastError || 'Failed to connect to local LLM server. Make sure it is installed and running.',
      }
    }),

  /** Get Ollama live diagnostics (VRAM, RAM, queue, tokens/sec) */
  getOllamaDiagnostics: publicProcedure.query(async () => {
    return OllamaModelManager.getInstance().getDiagnostics()
  }),

  /**
   * Discover installed Ollama models with vision capability detection.
   * Filters using /api/show projector/family inspection — no hardcoded lists.
   */
  getOllamaVisionModels: publicProcedure
    .input(z.object({ baseURL: z.string().optional() }).optional())
    .query(async ({ input }) => {
      return OllamaModelManager.getInstance().discoverModels()
    }),

  /** Safely unload the currently loaded Ollama model from VRAM */
  unloadOllamaModel: publicProcedure.mutation(async () => {
    return OllamaModelManager.getInstance().unloadAllModels()
  }),

  /**
   * Safely switch the active Ollama model:
   * Aborts active inference → unloads old model → updates config.
   */
  switchOllamaModel: publicProcedure
    .input(z.object({ model: z.string() }))
    .mutation(async ({ input }) => {
      return OllamaModelManager.getInstance().switchModel(input.model)
    }),

  /** Get app version from package.json */
  getAppVersion: publicProcedure.query(() => {
    return {
      version: app.getVersion(),
      name: app.getName(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }
  }),
})
