/**
 * Config schema — TypeScript interfaces for all configuration sections.
 *
 * These interfaces define the shape of the Config file.
 * Each section groups related settings together.
 */

/** Recursively makes all properties optional */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

// ═══════════════════════════════════════════════════════════════
//  Section interfaces
// ═══════════════════════════════════════════════════════════════

export interface UIConfig {
  /** Which side of the screen the UI stack appears on */
  positionSide: 'left' | 'right' | 'center'
  /** Keep window always on top of other apps when shown */
  alwaysOnTop?: boolean
  /** Open DevTools automatically in dev mode */
  openDevTools: boolean
  /** Minimum log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Write per-request session logs to {userData}/Logs/ */
  debugLog: boolean
  /** Whether UI sound effects are enabled */
  soundEnabled: boolean
  /** Sound effects volume (0.0 – 1.0) */
  soundVolume: number
}

export interface LLMConfig {
  /** LLM provider name */
  provider: string
  /** Base URL for OpenAI-compatible API */
  baseURL: string
  /** LLM API key */
  apiKey: string
  /** Main chat model (text + streaming) */
  textModel: string
  /** Vision model (screenshot analysis) */
  visionModel: string
  /** Whether to use a separate Vision model (if false, textModel handles both) */
  separateVisionModel?: boolean
  /** Classifier model (intent detection, cheap) */
  classifierModel: string
  /** Active multimodal Ollama model */
  ollamaModel?: string
  /** Idle timeout in minutes before unloading Ollama model from VRAM (0 = never, default 5) */
  ollamaIdleMinutes?: number
  /** Ollama context window size (default 2048 for low resource) */
  ollamaContextSize?: number
}

export interface GenerationConfig {
  /** Temperature for chat/stream (0.0–2.0) */
  chatTemperature: number
  /** Top-P nucleus sampling for chat */
  chatTopP: number
  /** Top-K sampling for chat (Gemini only) */
  chatTopK: number
  /** Max output tokens for chat */
  chatMaxTokens: number
  /** Temperature for vision/action (lower = more precise) */
  visionTemperature: number
  /** Max output tokens for vision/action */
  visionMaxTokens: number
}

export interface TTSConfig {
  /** Voice for Kokoro TTS (e.g. 'af_heart', 'af_sarah', 'af_bella', 'am_adam') */
  kokoroVoice?: string
  /** Quantization for Kokoro TTS (default: 'q8') */
  kokoroDtype?: string
  /** TTS provider: 'kokoro' | 'elevenlabs' | 'yandex-alice' | 'web-speech' | 'google-translate' */
  provider: string
  /** TTS API key (e.g. ElevenLabs) */
  apiKey: string
  /** TTS voice ID */
  voiceId: string
  /** TTS model name */
  model: string
  /** Whether TTS is enabled */
  enabled: boolean
  /** Audio output device ID (empty string = system default) */
  speakerDeviceId: string
  /** Speech rate/speed multiplier (0.8 to 1.5, default: 1.0) */
  rate?: number
  /** Speech pitch multiplier (0.8 to 1.3, default: 1.0) */
  pitch?: number
  /** Speech personality tone/manner: 'balanced' | 'concise' | 'expressive' | 'pilot' | 'formal' */
  style?: string
  /** Accent / Regional language code for TTS (e.g. 'en-US', 'en-GB', 'en-IN', 'en-AU') */
  accent?: string
}

export interface AgentConfig {
  /** Maximum total iterations per action loop */
  maxIterations: number
  /** Maximum consecutive failures before aborting */
  maxConsecutiveFailures: number
  /** Cooldown before each action (ms) */
  preActionDelay: number
  /** Cooldown after action before verification screenshot (ms) */
  postActionDelay: number
  /** Max messages in conversation context window */
  maxContextMessages: number
  /** Shell command timeout (ms) */
  commandTimeout: number
  /** Max width for screenshots sent to LLM */
  screenshotMaxWidth: number
  /** JPEG quality for compressed screenshots (0–100) */
  screenshotQuality: number
  /** Delay before transitioning from thoughts → response in chat mode (ms) */
  thoughtsTransitionDelay: number
  /** Words per chunk in response streaming animation */
  streamWordsPerChunk: number
  /** Delay between chunks in response streaming animation (ms) */
  streamChunkDelay: number
}

export interface STTConfig {
  /** Whether STT is enabled */
  enabled: boolean
  /** Handy (cjpais/Handy) local server endpoint */
  handyEndpoint?: string
  /** Groq API Key for Cloud Whisper */
  groqApiKey?: string
  /** In-app local model (e.g. onnx-community/moonshine-tiny-ONNX, Xenova/whisper-base.en, Xenova/whisper-small.en) */
  inAppWhisperModel?: string
  provider: 'handy' | 'groq-whisper' | 'faster-whisper' | 'in-app-whisper' | 'hybrid' | 'whisper' | 'vosk'
  /** Language code for model selection (e.g. 'en', 'ru') */
  language: string
  /** Audio input device ID (empty string = system default) */
  micDeviceId: string
  /** Wake word used to trigger listening (default: 'eva-01') */
  wakeWord: string
  /** Global keyboard shortcut to toggle microphone listening (e.g. 'Ctrl+Shift+Space') */
  micHotkey?: string
  /** Endpoint for offline Whisper service (e.g. http://localhost:8080/v1 or http://localhost:8000/v1) */
  whisperEndpoint: string
  /** Optional API key for cloud Whisper services (OpenAI, Groq, custom) */
  whisperApiKey?: string
  /** Whisper model name (e.g. 'whisper-1', 'base', 'tiny') */
  whisperModel: string
}

// ═══════════════════════════════════════════════════════════════
//  Root config
// ═══════════════════════════════════════════════════════════════

export interface AppConfig {
  ui: UIConfig
  llm: LLMConfig
  generation: GenerationConfig
  tts: TTSConfig
  stt: STTConfig
  agent: AgentConfig
  /** Global hotkey combo string */
  hotkey: string
  /** Currently active persona ID */
  activePersonaId: string
}
