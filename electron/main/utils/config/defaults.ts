/**
 * Config defaults — factory defaults for all config sections.
 *
 * Used on first launch and as fallbacks when loading a saved config
 * that may be missing newly-added fields.
 */

import { app } from 'electron'
import type { AppConfig } from './schema'

export const defaultConfig: AppConfig = {
  ui: {
    positionSide: 'right',
    alwaysOnTop: true,
    openDevTools: false,
    logLevel: 'debug',
    debugLog: false,
    soundEnabled: true,
    soundVolume: 0.5,
  },
  llm: {
    provider: 'gemini',
    baseURL: 'http://localhost:1234/v1',
    apiKey: '',
    textModel: 'gemini-3.1-flash-lite-preview',
    visionModel: '',
    separateVisionModel: false,
    classifierModel: '',
  },
  generation: {
    chatTemperature: 0.7,
    chatTopP: 0.95,
    chatTopK: 40,
    chatMaxTokens: 2048,
    visionTemperature: 0.2,
    visionMaxTokens: 1024,
  },
  tts: {
    provider: 'elevenlabs',
    apiKey: '',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb',
    model: 'eleven_flash_v2_5',
    enabled: true,
    speakerDeviceId: '',
    rate: 1.0,
    pitch: 1.0,
    style: 'balanced',
    accent: 'en-US',
  },
  stt: {
    enabled: true,
    provider: 'hybrid',
    language: 'en',
    micDeviceId: '',
    wakeWord: 'eva-01',
    micHotkey: 'Ctrl+Shift+Space',
    whisperEndpoint: 'http://localhost:8080/v1',
    whisperApiKey: '',
    whisperModel: 'whisper-1',
    inAppWhisperModel: 'Xenova/whisper-base.en',
  },
  agent: {
    maxIterations: 15,
    maxConsecutiveFailures: 3,
    preActionDelay: 200,
    postActionDelay: 800,
    maxContextMessages: 40,
    commandTimeout: 30_000,
    screenshotMaxWidth: 1280,
    screenshotQuality: 80,
    thoughtsTransitionDelay: 500,
    streamWordsPerChunk: 3,
    streamChunkDelay: 30,
  },
  hotkey: 'Ctrl+Space',
  activePersonaId: 'eva-01-default',
}
