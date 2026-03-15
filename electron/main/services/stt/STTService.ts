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
}
