import { ref, computed } from 'vue'
import { api } from '@/api'
import { useAgent } from './useAgent'
import { usePersonas } from './usePersonas'
import { stopPlayback } from './useTTS'

/**
 * useSTT — voice-first speech-to-text composable.
 *
 * Flow:
 * 1. Vosk runs continuously in background (when enabled)
 * 2. Detects wake word (persona name) in transcript
 * 3. Atlas window appears → ListeningIsland shows animated transcript
 * 4. Silence timer auto-submits command after ~1.5s pause
 * 5. Mic mutes during TTS playback (no feedback loop)
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

const SILENCE_BASE = 700
const SILENCE_MAX = 1500

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

// ── Visibility: auto-activate when Atlas shown via tray/hotkey ──

let visibilitySubscribed = false

function initVisibilityWatch() {
  if (visibilitySubscribed) return
  visibilitySubscribed = true

  let isFirst = true
  api.system.onAgentVisibility.subscribe(undefined, {
    onData(visible: boolean) {
      // Skip the initial `true` emitted on subscription connect
      if (isFirst) { isFirst = false; return }

      if (visible && phase.value === 'idle') {
        activateWithoutWakeWord()
      } else if (!visible && (phase.value === 'activated' || phase.value === 'listening')) {
        // Agent hidden — cancel active listening, return to wake word mode
        clearSilenceTimer()
        phase.value = 'idle'
        transcript.value = ''
        chunks.value = []
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
  api.audio.startListening.mutate()
  console.info('[useSTT] Activated via tray/hotkey')
}

initTTSWatch()

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

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: { ideal: sampleRate },
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })

  audioContext = new AudioContext({ sampleRate })
  sourceNode = audioContext.createMediaStreamSource(mediaStream)

  // Use AudioWorklet if available (off-main-thread), fallback to ScriptProcessor
  await audioContext.audioWorklet.addModule(createWorkletBlob())
  const workletNode = new AudioWorkletNode(audioContext, 'stt-processor')
  workletNode.port.onmessage = (e) => {
    if (!recognizer) return
    // During TTS: only process audio for wake word detection (idle phase)
    // Skip feeding audio when actively listening to avoid TTS echo
    if (ttsSpeaking && phase.value !== 'idle') return

    const samples = e.data as Float32Array
    const buf = audioContext!.createBuffer(1, samples.length, sampleRate)
    buf.getChannelData(0).set(samples)
    recognizer.acceptWaveform(buf)
  }
  sourceNode.connect(workletNode)
  workletNode.connect(audioContext.destination)

  phase.value = 'idle'
  initVisibilityWatch()
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

// ── Wake word + transcript handling ──

function getWakeWord(): string {
  const { activePersona } = usePersonas()
  const name = (activePersona.value?.name || 'atlas').toLowerCase()
  return name
}

function onPartialResult(msg: any): void {
  const partial: string = msg?.result?.partial || msg?.partial || ''
  if (!partial) return

  // Ignore stale events right after submit
  if (Date.now() - lastSubmitTime < 500) return

  if (phase.value === 'idle') {
    if (partial.toLowerCase().includes(getWakeWord())) {
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
    if (text.toLowerCase().includes(getWakeWord())) {
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
  // Always stop TTS on interrupt — backend may have finished streaming
  // while frontend is still playing the audio blob
  stopPlayback()
  api.audio.stopSpeaking.mutate().catch(() => {})
  ttsSpeaking = false

  phase.value = 'activated'
  transcript.value = ''
  chunks.value = []

  // Show Atlas window
  api.system.showWindow.mutate().catch(() => {})
  api.audio.startListening.mutate()

  // Extract command after wake word
  const afterWake = stripWakeWord(initialText).trim()
  if (afterWake) {
    phase.value = 'listening'
    transcript.value = afterWake
    resetSilenceTimer()
  }
  // If afterWake is empty → don't start timer, wait for actual speech

  console.info('[useSTT] Wake word detected — activated')
}

function stripWakeWord(text: string): string {
  const wake = getWakeWord()
  const lower = text.toLowerCase()
  const idx = lower.indexOf(wake)
  if (idx >= 0) {
    return text.slice(idx + wake.length).trim()
  }
  return text
}

// ── Silence timer → auto-submit ──

function resetSilenceTimer(): void {
  clearSilenceTimer()
  // Dynamic timeout: short text → more patience, long text → quicker submit
  const wordCount = chunks.value.join(' ').split(/\s+/).length + transcript.value.split(/\s+/).length
  const timeout = wordCount <= 2 ? SILENCE_MAX : SILENCE_BASE
  silenceTimer = setTimeout(submitTranscript, timeout)
}

function clearSilenceTimer(): void {
  if (silenceTimer) {
    clearTimeout(silenceTimer)
    silenceTimer = null
  }
}

function submitTranscript(): void {
  const fullText = chunks.value.join(' ').trim()
  if (!fullText) return

  // Guard: prevent duplicate submissions
  const now = Date.now()
  if (fullText === lastSubmitText && now - lastSubmitTime < 3000) return
  lastSubmitTime = now
  lastSubmitText = fullText

  console.info('[useSTT] Auto-submit:', fullText)
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
    enable,
    disable,
  }
}
