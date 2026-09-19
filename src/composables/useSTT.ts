import { ref, computed } from 'vue'
import { api } from '@/api'
import { useAgent } from './useAgent'
import { usePersonas } from './usePersonas'
import { useSounds } from './useSounds'
import { stopPlayback, isSpeakingOrRecentEcho } from './useTTS'

/**
 * useSTT — voice-first speech-to-text composable.
 *
 * Flow:
 * 1. Vosk runs continuously in background (when enabled)
 * 2. Detects wake word (persona name) in transcript
 * 3. Atlas window appears → ListeningIsland shows animated transcript
 * 4. Silence timer auto-submits command after ~1.5s pause
 * 5. Mic drops audio during TTS playback + echo window (no feedback loop)
 * 6. Tray/hotkey opens → auto-activate listening (no wake word needed)
 * 7. Wake word during TTS → interrupt + new command
 */

// ── State ──

type STTPhase = 'off' | 'idle' | 'activated' | 'listening'

const phase = ref<STTPhase>('off')
const transcript = ref('')
const chunks = ref<string[]>([])
const isModelLoaded = ref(false)
const isModelLoading = ref(false)

// ── Internals ──

let model: any = null
let recognizer: any = null
let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let silenceTimer: ReturnType<typeof setTimeout> | null = null
let ttsSpeaking = false
let lastSubmitTime = 0
let lastSubmitText = ''
let recordedBuffers: Float32Array[] = []
let preRollBuffers: Float32Array[] = []
let preRollSamples = 0
const MAX_PRE_ROLL_SAMPLES = 16000 * 2 // 2.0s rolling buffer

// Low-latency silence thresholds: 450ms base, 750ms max for snappy voice response
const SILENCE_BASE = 450
const SILENCE_MAX = 750

// ── TTS coordination ──

let ttsSubscribed = false

function initTTSWatch() {
  if (ttsSubscribed) return
  ttsSubscribed = true

  api.audio.onTTSStatus.subscribe(undefined, {
    onData(data: { speaking: boolean }) {
      ttsSpeaking = data.speaking
      // DON'T suspend mic during TTS — we need to hear the wake word for interrupt
    },
  })
}

// ── Visibility: auto-activate when EVA-01 shown via tray/hotkey ──

let visibilitySubscribed = false

function initVisibilityWatch() {
  if (visibilitySubscribed) return
  visibilitySubscribed = true

  let isFirst = true
  api.system.onAgentVisibility.subscribe(undefined, {
    onData(visible: boolean) {
      // Skip the initial `true` emitted on subscription connect
      if (isFirst) { isFirst = false; return }

      if (!visible && (phase.value === 'activated' || phase.value === 'listening')) {
        // Agent hidden — cancel active listening, return to wake word mode
        clearSilenceTimer()
        phase.value = 'idle'
        transcript.value = ''
        chunks.value = []
        recordedBuffers = []
        preRollBuffers = []
        preRollSamples = 0
        api.audio.stopListening.mutate()
        console.info('[useSTT] Deactivated — agent hidden')
      }
    },
  })
}

function activateWithoutWakeWord(): void {
  phase.value = 'activated'
  transcript.value = ''
  chunks.value = []
  recordedBuffers = [...preRollBuffers]
  preRollBuffers = []
  preRollSamples = 0
  api.audio.startListening.mutate()
  console.info('[useSTT] Activated via tray/hotkey')
}

// ── Mic Hotkey: Toggle mic listening via global keyboard shortcut ──

let micHotkeySubscribed = false

function initMicHotkeyWatch(): void {
  if (micHotkeySubscribed) return
  micHotkeySubscribed = true

  api.system.onToggleMicHotkey.subscribe(undefined, {
    onData() {
      if (phase.value === 'activated' || phase.value === 'listening') {
        clearSilenceTimer()
        phase.value = 'idle'
        transcript.value = ''
        chunks.value = []
        recordedBuffers = []
        api.audio.stopListening.mutate()
        console.info('[useSTT] Deactivated via mic hotkey')
      } else {
        api.system.showWindow.mutate().catch(() => {})
        activateWithoutWakeWord()
        console.info('[useSTT] Activated via mic hotkey')
      }
    },
  })
}

initTTSWatch()
initMicHotkeyWatch()

// ── Model ──

async function loadModel(): Promise<void> {
  if (model) return

  isModelLoading.value = true
  try {
    const Vosk = await import('vosk-browser')
    const { language } = (await api.settings.getConfig.query()).stt

    model = await Vosk.createModel(`stt-model://${language}.zip`)
    isModelLoaded.value = true
    console.info('[useSTT] Model loaded')
  } catch (err) {
    console.error('[useSTT] Failed to load model:', err)
    isModelLoaded.value = false
    throw err
  } finally {
    isModelLoading.value = false
  }
}

// ── Mic lifecycle ──

async function startMic(): Promise<void> {
  if (!model) await loadModel()
  if (!model) return

  const sampleRate = 16000

  recognizer = new model.KaldiRecognizer(sampleRate)
  recognizer.on('result', onResult)
  recognizer.on('partialresult', onPartialResult)

  const cfg = await api.settings.getConfig.query()
  if (cfg.stt.wakeWord) customWakeWord.value = cfg.stt.wakeWord
  const micDeviceId = cfg.stt.micDeviceId && cfg.stt.micDeviceId !== 'default' ? cfg.stt.micDeviceId : ''

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: micDeviceId
      ? {
          deviceId: { exact: micDeviceId },
          sampleRate: { ideal: sampleRate },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      : {
          sampleRate: { ideal: sampleRate },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
  })

  audioContext = new AudioContext({ sampleRate })
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  sourceNode = audioContext.createMediaStreamSource(mediaStream)

  // Use AudioWorklet if available (off-main-thread), fallback to ScriptProcessor
  await audioContext.audioWorklet.addModule(createWorkletBlob())
  const workletNode = new AudioWorkletNode(audioContext, 'stt-processor')
  workletNode.port.onmessage = (e) => {
    if (!recognizer) return
    const samples = e.data as Float32Array

    // Maintain a rolling 2-second buffer during idle so audio spoken before/during
    // wake-word detection is preserved for high-accuracy Whisper transcription.
    if (phase.value === 'idle') {
      preRollBuffers.push(new Float32Array(samples))
      preRollSamples += samples.length
      while (preRollSamples > MAX_PRE_ROLL_SAMPLES && preRollBuffers.length > 1) {
        const dropped = preRollBuffers.shift()!
        preRollSamples -= dropped.length
      }
    } else if (phase.value === 'activated' || phase.value === 'listening') {
      // Record audio samples when actively listening for Whisper offline flow
      recordedBuffers.push(new Float32Array(samples))
    }

    const buf = audioContext!.createBuffer(1, samples.length, sampleRate)
    buf.getChannelData(0).set(samples)
    recognizer.acceptWaveform(buf)
  }
  sourceNode.connect(workletNode)
  workletNode.connect(audioContext.destination)

  phase.value = 'idle'
  initVisibilityWatch()
  initConfigWatch()
  console.info('[useSTT] Mic started, listening for wake word...')
}

function stopMic(): void {
  clearSilenceTimer()
  sourceNode?.disconnect()
  sourceNode = null
  audioContext?.close()
  audioContext = null
  mediaStream?.getTracks().forEach((t) => t.stop())
  mediaStream = null
  recognizer?.remove()
  recognizer = null
  phase.value = 'off'
  transcript.value = ''
  chunks.value = []
  recordedBuffers = []
  preRollBuffers = []
  preRollSamples = 0
}

// ── Config Watch: auto-enable/disable and update wake word ──

let configSubscribed = false
const customWakeWord = ref('eva-01')

function initConfigWatch(): void {
  if (configSubscribed) return
  configSubscribed = true

  api.settings.onConfigChange.subscribe(undefined, {
    onData(cfg) {
      if (cfg.stt.wakeWord) {
        customWakeWord.value = cfg.stt.wakeWord
      }
      if (cfg.stt.enabled && phase.value === 'off') {
        enable()
      } else if (!cfg.stt.enabled && phase.value !== 'off') {
        disable()
      }
    },
  })
}

// ── AudioWorklet (inlined as blob) ──

function createWorkletBlob(): string {
  const code = `
    class STTProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0]
        if (input && input[0] && input[0].length > 0) {
          this.port.postMessage(input[0])
        }
        return true
      }
    }
    registerProcessor('stt-processor', STTProcessor)
  `
  return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
}

// ── WAV encoder for offline Whisper flow ──

function encodeWAV(buffers: Float32Array[], sampleRate: number): string {
  const totalLength = buffers.reduce((acc, b) => acc + b.length, 0)
  const buffer = new ArrayBuffer(44 + totalLength * 2)
  const view = new DataView(buffer)

  // RIFF header
  view.setUint32(0, 0x52494646, false) // 'RIFF'
  view.setUint32(4, 36 + totalLength * 2, true)
  view.setUint32(8, 0x57415645, false) // 'WAVE'
  view.setUint32(12, 0x666d7420, false) // 'fmt '
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // Mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // 16 bits per sample
  view.setUint32(36, 0x64617461, false) // 'data'
  view.setUint32(40, totalLength * 2, true)

  let offset = 44
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, buf[i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
  }

  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// ── Wake word + transcript handling ──

function getWakeWords(): string[] {
  const { activePersona } = usePersonas()
  const personaName = (activePersona.value?.name || 'eva-01').toLowerCase().trim()
  const configured = (customWakeWord.value || 'eva-01').toLowerCase().trim()

  const words = new Set<string>()
  if (configured) {
    words.add(configured)
    if (configured.includes('eva')) {
      words.add('eva')
      words.add('eva-01')
      words.add('eva 01')
      words.add('eva one')
      // Phonetic variants that speech models frequently output for "eva":
      words.add('ever')
      words.add('ava')
      words.add('iva')
      words.add('eeva')
      words.add('ayva')
      words.add('eyva')
      words.add('ifa')
    }
  }
  if (personaName) {
    words.add(personaName)
    if (personaName.includes('eva')) {
      words.add('eva')
      words.add('eva-01')
      words.add('eva 01')
      words.add('eva one')
      words.add('ever')
      words.add('ava')
      words.add('iva')
    }
  }
  // Backwards compatibility alias
  words.add('atlas')

  return Array.from(words)
}

function containsWakeWord(text: string): boolean {
  const lower = text.toLowerCase()
  return getWakeWords().some((w) => lower.includes(w))
}

function onPartialResult(msg: any): void {
  const partial: string = msg?.result?.partial || msg?.partial || ''
  if (!partial) return

  // Ignore stale events right after submit
  if (Date.now() - lastSubmitTime < 500) return

  if (phase.value === 'idle') {
    if (containsWakeWord(partial)) {
      activate(partial)
    }
  } else if (phase.value === 'activated' || phase.value === 'listening') {
    const clean = stripWakeWord(partial)
    if (clean) {
      phase.value = 'listening'
      transcript.value = clean
      resetSilenceTimer()
    }
  }
}

function onResult(msg: any): void {
  const text: string = msg?.result?.text || msg?.text || ''
  if (!text.trim()) return

  // Ignore stale events right after submit
  if (Date.now() - lastSubmitTime < 500) return

  if (phase.value === 'idle') {
    if (containsWakeWord(text)) {
      activate(text)
    }
  } else if (phase.value === 'activated' || phase.value === 'listening') {
    const clean = stripWakeWord(text).trim()
    if (clean) {
      phase.value = 'listening'
      chunks.value.push(clean)
      transcript.value = ''
      resetSilenceTimer()
    }
  }
}

function activate(initialText: string): void {
  // Always stop TTS on interrupt
  stopPlayback()
  api.audio.stopSpeaking.mutate().catch(() => {})
  ttsSpeaking = false

  // Play instant wake chime for 0-latency auditory confirmation
  try {
    useSounds().activate()
  } catch {
    // Audio context may not be ready
  }

  phase.value = 'activated'
  transcript.value = ''
  chunks.value = []
  
  // Seed recordedBuffers with pre-roll audio so Whisper receives the complete utterance
  recordedBuffers = [...preRollBuffers]
  preRollBuffers = []
  preRollSamples = 0

  // Show EVA-01 window
  api.system.showWindow.mutate().catch(() => {})
  api.audio.startListening.mutate()

  // Extract command after wake word
  const afterWake = stripWakeWord(initialText).trim()
  if (afterWake) {
    phase.value = 'listening'
    transcript.value = afterWake
    chunks.value = [afterWake]
    resetSilenceTimer()
  }

  console.info('[useSTT] Wake word detected — activated, command:', afterWake)
}

function stripWakeWord(text: string): string {
  let cleaned = text.trim()
  const lower = cleaned.toLowerCase()
  // Match longest wake word phrase first (e.g. "eva-01" before "eva")
  const sorted = [...getWakeWords()].sort((a, b) => b.length - a.length)
  for (const wake of sorted) {
    const idx = lower.indexOf(wake)
    if (idx >= 0) {
      cleaned = cleaned.slice(idx + wake.length)
      break
    }
  }
  // Strip leading punctuation and conversational hesitations / filler words like "ah", "um", "uh", "hey", "hi"
  cleaned = cleaned.replace(/^[,.:;!?-]+/, '').trim()
  cleaned = cleaned.replace(/^(ah|um|uh|er|eh|hey|hi|yo)\s+/i, '').trim()
  return cleaned
}

// ── Silence timer → auto-submit ──

function resetSilenceTimer(): void {
  clearSilenceTimer()
  // Dynamic timeout: short text → more patience, long text → quicker submit
  const wordCount = chunks.value.join(' ').split(/\s+/).length + transcript.value.split(/\s+/).length
  const timeout = wordCount <= 2 ? SILENCE_MAX : SILENCE_BASE
  silenceTimer = setTimeout(() => {
    submitTranscript()
  }, timeout)
}

function clearSilenceTimer(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer)
    silenceTimer = null
  }
}

async function submitTranscript(): Promise<void> {
  const allParts = [...chunks.value]
  const currentPartial = transcript.value.trim()
  if (currentPartial && !allParts.includes(currentPartial)) {
    allParts.push(currentPartial)
  }
  const voskFallback = allParts.join(' ').trim()
  let fullText = voskFallback

  // If Whisper, Hybrid, or In-App Whisper mode is enabled and audio was recorded
  try {
    const config = await api.settings.getConfig.query()
    const isWhisperFlow =
      config.stt.provider === 'whisper' ||
      config.stt.provider === 'hybrid' ||
      config.stt.provider === 'in-app-whisper'

    if (isWhisperFlow && recordedBuffers.length > 0) {
      console.info('[useSTT] Running Whisper transcription with', recordedBuffers.length, 'audio chunks...')
      const wavBase64 = encodeWAV(recordedBuffers, 16000)
      const res = await api.audio.transcribeAudio.mutate({
        audioBase64: wavBase64,
        language: config.stt.language !== 'auto' ? config.stt.language : undefined,
      })
      if (res.text && res.text.trim()) {
        const whisperClean = stripWakeWord(res.text).trim() || res.text.trim()
        if (whisperClean) {
          fullText = whisperClean
          console.info('[useSTT] Whisper recognized:', fullText)
        }
      }
    }
  } catch (err) {
    console.warn('[useSTT] Whisper transcription error, fallback to Vosk text:', err)
  }

  recordedBuffers = []
  preRollBuffers = []
  preRollSamples = 0

  // If Whisper returned empty, use Vosk candidate
  if (!fullText && voskFallback) {
    fullText = voskFallback
  }
  if (!fullText) return

  // Clean any leading punctuation or conversational filler ("ah", "um", "uh", "hey")
  fullText = stripWakeWord(fullText)
  fullText = fullText.replace(/^[,.:;!?-]+/, '').replace(/^(ah|um|uh|er|eh|hey|hi|yo)\s+/i, '').trim()
  if (!fullText) return

  // Guard: prevent duplicate submissions
  const now = Date.now()
  if (fullText === lastSubmitText && now - lastSubmitTime < 3000) return
  lastSubmitTime = now
  lastSubmitText = fullText

  console.info('[useSTT] Auto-submit:', fullText)
  try {
    useSounds().processing()
  } catch {
    // Ignored
  }
  const { sendCommand } = useAgent()
  sendCommand(fullText)

  // Reset to idle (keep listening for next wake word)
  phase.value = 'idle'
  transcript.value = ''
  chunks.value = []
  api.audio.stopListening.mutate()
}

// ── Public API ──

async function enable(): Promise<void> {
  if (phase.value !== 'off') return
  try {
    await startMic()
  } catch (err) {
    console.error('[useSTT] Failed to enable:', err)
  }
}

function disable(): void {
  stopMic()
}

// ── Composable ──

export function useSTT() {
  const isActivated = computed(() => phase.value === 'activated' || phase.value === 'listening')

  return {
    phase,
    transcript,
    chunks,
    isActivated,
    isModelLoaded,
    isModelLoading,
    activeWakeWord: customWakeWord,
    enable,
    disable,
  }
}
