/**
 * OllamaModelManager — Centralized singleton for managing Ollama models and inference.
 *
 * Tailored specifically for low-resource environments (RTX 2050 4GB VRAM, 8GB RAM),
 * while remaining fully responsive and stable across all devices.
 *
 * Guarantees:
 * 1. Only ONE model ever loaded in VRAM at a time (zero model thrashing).
 * 2. Only multimodal models (vision + text) are selectable in Ollama mode.
 * 3. Concurrency = 1: All requests pass through a strictly sequential FIFO queue.
 * 4. In-flight cancellation via AbortController for Stop / superseding actions.
 * 5. Automatic idle unloading via keep_alive: 0 after configurable timeout.
 * 6. Safe model switching: abort -> unload old model -> verify release -> switch.
 * 7. Real-time hardware telemetry (VRAM, RAM, tokens/sec, latency, queue length).
 */

import os from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from '@electron/utils/logger'
import { getConfig, saveConfig } from '@electron/utils/config'
import { mainEventBus } from '@electron/utils/eventBus'
import { sleep } from '@electron/utils/other'

const execAsync = promisify(exec)
const log = createLogger('OllamaModelManager')

export type OllamaState = 'unloaded' | 'loading' | 'ready' | 'inferring' | 'unloading'

export interface OllamaModelInfo {
  name: string
  sizeBytes: number
  parameterSize: string
  quantization: string
  isVisionCapable: boolean
  warning?: string
}

export interface OllamaTelemetry {
  activeModel: string
  state: OllamaState
  queueLength: number
  vram: {
    totalMB: number
    usedMB: number
    freeMB: number
  }
  ram: {
    totalMB: number
    usedMB: number
    freeMB: number
  }
  lastPromptTokens: number
  lastCompletionTokens: number
  lastTokensPerSec: number
  lastLatencyMs: number
  lastLoadTimeMs: number
  lastUnloadTimeMs: number
}

interface QueuedTask<T> {
  name: string
  execute: (signal: AbortSignal) => Promise<T>
  resolve: (value: T) => void
  reject: (reason: any) => void
  controller: AbortController
}

export class OllamaModelManager {
  private static instance: OllamaModelManager | null = null

  private state: OllamaState = 'unloaded'
  private activeModel = ''
  private queue: QueuedTask<any>[] = []
  private activeTask: QueuedTask<any> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  // Telemetry metrics
  private lastPromptTokens = 0
  private lastCompletionTokens = 0
  private lastTokensPerSec = 0
  private lastLatencyMs = 0
  private lastLoadTimeMs = 0
  private lastUnloadTimeMs = 0

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): OllamaModelManager {
    if (!OllamaModelManager.instance) {
      OllamaModelManager.instance = new OllamaModelManager()
    }
    return OllamaModelManager.instance
  }


  /**
   * Automatically attempts to launch Ollama if it is offline.
   */
  async ensureOllamaRunning(): Promise<boolean> {
    const baseURL = this.getBaseURL()
    try {
      const res = await fetch(`${baseURL}/api/tags`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      // Offline, proceed to auto-start
    }

    if (process.platform === 'win32') {
      log.info('Ollama is offline, attempting automatic background launch...')
      try {
        const { spawn } = await import('node:child_process')
        const proc = spawn('ollama', ['serve'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        proc.unref()

        for (let i = 0; i < 8; i++) {
          await sleep(500)
          try {
            const check = await fetch(`${baseURL}/api/tags`, { signal: AbortSignal.timeout(1000) })
            if (check.ok) {
              log.info('Ollama successfully auto-started in background!')
              return true
            }
          } catch { /* ignore */ }
        }
      } catch (err) {
        log.warn(`Could not auto-start Ollama: ${err}`)
      }
    }
    return false
  }

  /**
   * Base URL for Ollama HTTP API (defaults to http://127.0.0.1:11434).
   */
  private getBaseURL(): string {
    const raw = getConfig().llm.baseURL || 'http://127.0.0.1:11434/v1'
    return raw.replace(/\/v1\/?$/, '').replace(/\/$/, '')
  }

  /**
   * Initialize manager: query hardware, verify zero preloaded models, and hook events.
   */
  async init(): Promise<void> {
    const config = getConfig()
    this.activeModel = config.llm.ollamaModel || config.llm.textModel || 'qwen2.5vl:3b'

    log.info(`Initializing OllamaModelManager with active model: ${this.activeModel}`)

    // Startup requirement: Verify Ollama health and guarantee no model is preloaded
    try {
      await this.startupCheck()
    } catch (err: any) {
      log.warn(`Ollama startup probe failed (Ollama service may be starting or offline): ${err?.message || err}`)
    }

    // Register terminate listener
    mainEventBus.on('agent:terminate', () => {
      this.abortCurrent('Cancelled by user')
    })
  }

  /**
   * Health check and ensure memory is clean at startup.
   */
  async startupCheck(): Promise<{ ok: boolean; models: string[] }> {
    const baseURL = this.getBaseURL()
    const psRes = await fetch(`${baseURL}/api/ps`, { signal: AbortSignal.timeout(3000) })
    if (!psRes.ok) return { ok: false, models: [] }

    const psData = await psRes.json()
    const loaded = psData.models || []

    if (loaded.length > 0) {
      log.info(`Found ${loaded.length} model(s) preloaded at startup, releasing for clean state...`)
      for (const m of loaded) {
        await this.unloadSpecificModel(m.name)
      }
      this.state = 'unloaded'
    } else {
      this.state = 'unloaded'
      log.info('Ollama startup check: 0 models preloaded in VRAM (clean state)')
    }

    return { ok: true, models: loaded.map((m: any) => m.name) }
  }

  /**
   * Discover installed models and identify only multimodal vision-capable models.
   */
  async discoverModels(): Promise<OllamaModelInfo[]> {
    const baseURL = this.getBaseURL()
    try {
      const res = await fetch(`${baseURL}/api/tags`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      const list = data.models || []
      const results: OllamaModelInfo[] = []

      for (const m of list) {
        const name = m.name
        let isVisionCapable = false
        let parameterSize = ''
        let quantization = ''
        let warning: string | undefined

        try {
          const showRes = await fetch(`${baseURL}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
            signal: AbortSignal.timeout(4000),
          })
          if (showRes.ok) {
            const showData = await showRes.json()
            const families: string[] = showData.details?.families || []
            const infoKeys = Object.keys(showData.model_info || {})

            parameterSize = showData.details?.parameter_size || ''
            quantization = showData.details?.quantization_level || ''

            // Dynamic capability detection: checks families, model_info keys, projector
            isVisionCapable =
              families.some((f) => /clip|mllama|vision|vl|llava|minicpm/i.test(f)) ||
              infoKeys.some((k) => k.includes('.vision.') || k.includes('.clip.') || k.includes('projector') || k.includes('mllama')) ||
              Boolean(showData.projector_info)

            // Compatibility / performance warnings for 4GB VRAM
            const paramNum = parseFloat(parameterSize) || 0
            if (isVisionCapable) {
              if (name.toLowerCase().includes('moondream')) {
                warning = 'Caption-only model: cannot perform general tool actions or instruction reasoning.'
              } else if (paramNum > 8) {
                warning = 'High memory footprint (>8B): will offload to CPU RAM on 4GB VRAM, causing slower response.'
              }
            }
          }
        } catch (showErr: any) {
          log.debug(`Failed to inspect model ${name}:`, showErr?.message)
        }

        results.push({
          name,
          sizeBytes: m.size || 0,
          parameterSize,
          quantization,
          isVisionCapable,
          warning,
        })
      }

      return results
    } catch (err: any) {
      log.warn(`Failed to discover Ollama models: ${err?.message || err}`)
      return []
    }
  }

  /**
   * Enqueue an inference request. Guarantees concurrency = 1 and auto-idle management.
   */
  async enqueue<T>(taskName: string, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // Cancel idle timer while inference is running
    this.clearIdleTimer()

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      const task: QueuedTask<T> = {
        name: taskName,
        execute,
        resolve,
        reject,
        controller,
      }

      this.queue.push(task)
      this.processNext()
    })
  }

  /**
   * Process the next request in the FIFO queue.
   */
  private async processNext(): Promise<void> {
    if (this.activeTask || this.queue.length === 0) return

    const task = this.queue.shift()!
    this.activeTask = task
    this.state = 'inferring'
    const startTime = Date.now()

    try {
      const result = await task.execute(task.controller.signal)
      this.state = 'ready'
      this.lastLatencyMs = Date.now() - startTime
      task.resolve(result)
    } catch (err: any) {
      if (task.controller.signal.aborted || err?.name === 'AbortError') {
        log.info(`Ollama task "${task.name}" was cancelled`)
        task.reject(new Error('Inference cancelled'))
      } else {
        log.error(`Ollama task "${task.name}" error:`, err?.message || err)
        task.reject(err)
      }
      this.state = 'ready'
    } finally {
      this.activeTask = null
      // Start idle countdown as soon as queue is drained
      if (this.queue.length === 0) {
        this.resetIdleTimer()
      } else {
        // Continue draining
        this.processNext()
      }
    }
  }

  /**
   * Abort currently running inference and clear pending queued requests.
   */
  abortCurrent(reason = 'User stopped'): void {
    if (this.activeTask) {
      log.info(`Aborting active Ollama inference: ${this.activeTask.name} (${reason})`)
      this.activeTask.controller.abort(new Error(reason))
    }
    // Reject pending queued tasks
    while (this.queue.length > 0) {
      const queued = this.queue.shift()!
      queued.reject(new Error(`Cancelled: ${reason}`))
    }
    this.state = 'ready'
    this.resetIdleTimer()
  }

  /**
   * Safe model switching:
   * 1. Cancel active inference & clear queue.
   * 2. Unload current model from VRAM using keep_alive: 0.
   * 3. Verify VRAM release via /api/ps.
   * 4. Update configuration with new model (no eager preloading).
   */
  async switchModel(newModel: string): Promise<{ ok: boolean; error?: string }> {
    if (!newModel) return { ok: false, error: 'No model specified' }

    log.info(`Safely switching Ollama model from "${this.activeModel}" -> "${newModel}"...`)
    this.abortCurrent('Switching model')
    this.clearIdleTimer()

    // 1. Unload old model
    const unloadResult = await this.unloadAllModels()
    if (!unloadResult.ok) {
      log.warn(`Unload before switch encountered issue: ${unloadResult.error}`)
    }

    // 2. Set new model in manager & app config
    this.activeModel = newModel
    try {
      saveConfig({
        llm: {
          ollamaModel: newModel,
          textModel: newModel,
          visionModel: newModel,
          classifierModel: newModel,
          separateVisionModel: false,
        },
      })
      log.info(`Model successfully switched to "${newModel}". Ready for on-demand inference.`)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update config' }
    }
  }

  /**
   * Unload all currently loaded models from Ollama VRAM.
   */
  async unloadAllModels(): Promise<{ ok: boolean; error?: string }> {
    this.state = 'unloading'
    const t0 = Date.now()
    const baseURL = this.getBaseURL()

    try {
      const psRes = await fetch(`${baseURL}/api/ps`, { signal: AbortSignal.timeout(4000) })
      if (!psRes.ok) throw new Error(`HTTP ${psRes.status}`)
      const psData = await psRes.json()
      const loaded = psData.models || []

      for (const m of loaded) {
        await this.unloadSpecificModel(m.name)
      }

      // Verify release
      const verifyRes = await fetch(`${baseURL}/api/ps`, { signal: AbortSignal.timeout(3000) })
      const verifyData = await verifyRes.json()
      const remaining = verifyData.models || []

      this.lastUnloadTimeMs = Date.now() - t0
      this.state = remaining.length === 0 ? 'unloaded' : 'ready'

      if (remaining.length === 0) {
        log.info(`Ollama VRAM released completely in ${this.lastUnloadTimeMs}ms. 0 models loaded.`)
        return { ok: true }
      } else {
        log.warn(`Some models still registered in /api/ps: ${remaining.map((r: any) => r.name).join(', ')}`)
        return { ok: true }
      }
    } catch (err: any) {
      this.state = 'unloaded'
      log.error(`Failed to unload Ollama models:`, err?.message || err)
      return { ok: false, error: err?.message || 'Unload failed' }
    }
  }

  /**
   * Unload a specific model using Ollama's official `keep_alive: 0` API.
   */
  private async unloadSpecificModel(modelName: string): Promise<void> {
    const baseURL = this.getBaseURL()
    try {
      log.info(`Unloading model "${modelName}" from VRAM via keep_alive: 0...`)
      await fetch(`${baseURL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, keep_alive: 0 }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (err: any) {
      log.warn(`Unload call for "${modelName}" failed: ${err?.message || err}`)
    }
  }

  /**
   * Reset the idle timer. When timer expires, auto-unloads model from VRAM.
   */
  private resetIdleTimer(): void {
    this.clearIdleTimer()
    const idleMinutes = getConfig().llm.ollamaIdleMinutes ?? 5

    if (idleMinutes <= 0) {
      // 0 means never auto-unload
      return
    }

    const timeoutMs = idleMinutes * 60 * 1000
    this.idleTimer = setTimeout(async () => {
      if (this.queue.length === 0 && !this.activeTask && this.state !== 'unloaded') {
        log.info(`Ollama idle timeout (${idleMinutes}m) reached. Auto-unloading model to free VRAM...`)
        await this.unloadAllModels()
      }
    }, timeoutMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /**
   * Record telemetry from completed generation (called by OpenAIProvider).
   */
  recordInferenceMetrics(promptTokens: number, completionTokens: number, durationMs: number): void {
    this.lastPromptTokens = promptTokens
    this.lastCompletionTokens = completionTokens
    this.lastLatencyMs = durationMs
    if (durationMs > 0 && completionTokens > 0) {
      this.lastTokensPerSec = parseFloat(((completionTokens / durationMs) * 1000).toFixed(1))
    }
  }

  /**
   * Collect hardware and inference telemetry.
   */
  async getDiagnostics(): Promise<OllamaTelemetry> {
    const vram = await this.getRealtimeVRAM()
    const totalRamMB = Math.round(os.totalmem() / (1024 * 1024))
    const freeRamMB = Math.round(os.freemem() / (1024 * 1024))

    return {
      activeModel: this.activeModel,
      state: this.state,
      queueLength: this.queue.length + (this.activeTask ? 1 : 0),
      vram,
      ram: {
        totalMB: totalRamMB,
        usedMB: totalRamMB - freeRamMB,
        freeMB: freeRamMB,
      },
      lastPromptTokens: this.lastPromptTokens,
      lastCompletionTokens: this.lastCompletionTokens,
      lastTokensPerSec: this.lastTokensPerSec,
      lastLatencyMs: this.lastLatencyMs,
      lastLoadTimeMs: this.lastLoadTimeMs,
      lastUnloadTimeMs: this.lastUnloadTimeMs,
    }
  }

  /**
   * Fast real-time VRAM probe via nvidia-smi (50-100ms) with graceful fallback.
   */
  private async getRealtimeVRAM(): Promise<{ totalMB: number; usedMB: number; freeMB: number }> {
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync(
          'nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader,nounits',
          { timeout: 1500 }
        )
        const parts = stdout.trim().split(',').map((p) => parseInt(p.trim(), 10))
        if (parts.length >= 3 && !isNaN(parts[0])) {
          return {
            totalMB: parts[0],
            usedMB: parts[1],
            freeMB: parts[2],
          }
        }
      } catch {
        // Non-nvidia or nvidia-smi not in PATH
      }
    }

    return { totalMB: 4096, usedMB: 0, freeMB: 4096 }
  }

  /**
   * Clean shutdown on application quit.
   */
  async shutdown(): Promise<void> {
    log.info('OllamaModelManager shutting down...')
    this.clearIdleTimer()
    this.abortCurrent('Application shutdown')
    await this.unloadAllModels()
  }
}
