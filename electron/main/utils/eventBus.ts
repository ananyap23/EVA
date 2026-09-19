import { EventEmitter } from 'node:events'

/**
 * Main-process event bus for cross-module communication.
 *
 * Bridges events between services, tRPC routers, and Electron
 * lifecycle code without tight coupling.
 *
 * Naming convention: `domain:event` (e.g. `agent:state`)
 */
export const mainEventBus = new EventEmitter()

// ── Event Types ──

export interface MainEvents {
  /** Agent UI visibility toggled from tray */
  'agent-visibility': [visible: boolean]

  // ── Agent Events (emitted by future AgentService, consumed by agent.router) ──

  /** Agent state transition */
  'agent:state': [state: string]
  /** Current action update (label + progress) */
  'agent:action': [action: { label: string; progress: number } | null]
  /** Streaming response chunk */
  'agent:response': [payload: {
    id: string
    kind: 'response' | 'thoughts'
    text: string
    streaming: boolean
    done: boolean
  }]
  /** Full microtask list update */
  'agent:microtasks': [tasks: Array<{
    id: string
    text: string
    status: 'queued' | 'active' | 'done' | 'failed'
    createdAt: string
  }>]
  /** New permission request */
  'agent:permission': [permission: {
    id: string
    message: string
    riskLevel: 'medium' | 'high' | 'critical'
  }]
  /** Permission response from user */
  'agent:permission-response': [payload: { id: string; allowed: boolean }]
  /** New warning */
  'agent:warning': [warning: { id: string; message: string; dismissable?: boolean }]
  /** Dismiss warning from user */
  'agent:dismiss-warning': [payload: { id: string }]
  /** Action log entry from completed action loop */
  'agent:action-log': [entry: {
    personaId: string
    command: string
    timestamp: string
    entries: string[]
  }]
  /** User command from InputBar */
  'agent:command': [payload: { text: string }]
  /** Terminate currently running process/action/loop */
  'agent:terminate': []
  /** Start a new conversation session */
  'agent:newSession': []
  /** Ephemeral action loop steps (displayed in MicrotaskIsland alongside queued tasks) */
  'agent:action-steps': [steps: Array<{
    id: string
    text: string
    status: 'queued' | 'active' | 'done' | 'failed'
    createdAt: string
  }>]
  /** Cursor animation for agent action overlay (renderer shows animated cursor) */
  'agent:cursor-animation': [payload: {
    type: 'move-click' | 'move-doubleClick' | 'move-rightClick' | 'type' | 'scroll' | 'hide'
    x?: number          // screen-space pixel coords (within overlay window)
    y?: number
    text?: string       // for type animation
    direction?: 'up' | 'down' // for scroll
  }]
  /** Search results from web search action */
  'agent:search-results': [payload: {
    query: string
    results: Array<{ title: string; url: string; snippet: string }>
    searching: boolean
  }]

  // ── Hotkey Events ──

  /** Global hotkey: toggle EVA-01 visibility + InputBar */
  'hotkey:toggle-eva-01': []
  'hotkey:toggle-atlas': []
  /** Global hotkey: toggle microphone listening directly */
  'hotkey:toggle-mic': []

  // ── Audio / STT Events ──

  /** Transcript chunk from STT */
  'audio:transcript': [payload: { text: string; isFinal: boolean }]
  /** Listening state change */
  'audio:listening': [listening: boolean]
  /** STT model download/status updates */
  'stt:model-status': [payload: { downloaded: boolean; progress?: number; error?: string }]

  // ── Persona Events ──

  /** Active persona switched */
  'persona:switched': [payload: { id: string; persona: import('@electron/services/persona/AgentProfile').AgentProfile }]
  /** Prompt saved or reset (triggers cache invalidation) */
  'prompt:saved': [payload: { name: string; personaId?: string }]

  // ── TTS Events (Phase 3.5) ──

  /** TTS speaking status changed */
  'tts:status': [payload: { speaking: boolean }]
  /** TTS audio format for current provider */
  'tts:format': [payload: { format: 'mpeg' | 'opus' | 'web-speech' }]
  /** TTS audio chunk (streaming) */
  'tts:audio': [payload: { chunk: Buffer; done: boolean }]
  /** Request TTS to speak text */
  'tts:speak': [payload: { text: string }]
  /** Web Speech text emission for browser-native synthesis */
  'tts:speak-text': [payload: { text: string; voice?: string; rate?: number; pitch?: number }]
  /** Request TTS to stop */
  'tts:stop': []
}
