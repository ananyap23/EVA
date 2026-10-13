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
// ── Settings Open Guard (prevents wake-word & listening while in settings) ──
const isSettingsOpen = ref(false)

export function isSTTSettingsOpen(): boolean {
  return isSettingsOpen.value
}

export function setSTTSettingsOpen(open: boolean): void {
  isSettingsOpen.value = open
  if (open) {
    clearSilenceTimer()
    if (phase.value === 'activated' || phase.value === 'listening') {
      phase.value = 'idle'
      transcript.value = ''
      chunks.value = []
      recordedBuffers = []
      preRollBuffers = []
      preRollSamples = 0
      api.audio.stopListening.mutate().catch(() => {})
      console.info('[useSTT] Deactivated — settings opened')
    }
  }
}

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
let lastSeenPartial = ''
let cachedSTTConfig: any = null
let ttsSpeaking = false
let lastSubmitTime = 0
let lastSubmitText = ''
let recordedBuffers: Float32Array[] = []
let preRollBuffers: Float32Array[] = []
let preRollSamples = 0
const MAX_PRE_ROLL_SAMPLES = 16000 * 2 // 2.0s rolling buffer

// Snappy, natural silence thresholds: 700ms base, 1100ms max for responsive turn-taking
const SILENCE_BASE = 700
const SILENCE_MAX = 1100

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

let lastVoiceEnergyTime = 0
let hasSpokenSinceActivation = false

function detectSilenceByEnergy(samples: Float32Array): void {
  if (phase.value !== 'activated' && phase.value !== 'listening') return

  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i]
  }
  const rms = Math.sqrt(sum / samples.length)
  const SPEECH_THRESHOLD = 0.015

  const now = Date.now()
  if (rms > SPEECH_THRESHOLD) {
    lastVoiceEnergyTime = now
    if (!hasSpokenSinceActivation) {
      hasSpokenSinceActivation = true
      phase.value = 'listening'
      transcript.value = 'Listening...'
    }
  } else if (hasSpokenSinceActivation && now - lastVoiceEnergyTime > 1200) {
    hasSpokenSinceActivation = false
    console.info('[useSTT] Silence detected via audio energy -> submitting transcript')
    submitTranscript()
  }
}

function activateWithoutWakeWord(): void {
  if (isSettingsOpen.value) return
  if (!mediaStream) {
    startMic().catch((err) => console.error('[useSTT] Failed to start mic on activation:', err))
  }
  lastSeenPartial = ''
  hasSpokenSinceActivation = false
  lastVoiceEnergyTime = Date.now()
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
      if (isSettingsOpen.value) return
      const { state, terminateProcess } = useAgent()
      const isAgentActive = state.value !== 'idle'
      const isListening = phase.value === 'activated' || phase.value === 'listening'

      if (isListening || isAgentActive) {
        clearSilenceTimer()
        phase.value = 'idle'
        transcript.value = ''
        chunks.value = []
        recordedBuffers = []
        api.audio.stopListening.mutate().catch(() => {})
        terminateProcess()
        console.info('[useSTT] Deactivated listening & cancelled active execution via mic hotkey')
      } else {
        api.system.showWindow.mutate().catch(() => {})
        activateWithoutWakeWord()
        console.info('[useSTT] Activated via mic hotkey')
      }
    },
  })
}

let modelStatusSubscribed = false

function initModelStatusWatch(): void {
  if (modelStatusSubscribed) return
  modelStatusSubscribed = true

  api.audio.onSTTModelStatus.subscribe(undefined, {
    onData(data) {
      if (data.downloaded) {
        console.info('[useSTT] STT model download ready event received, loading model...')
        loadModel().catch((err) => {
          console.error('[useSTT] Failed to load model after download event:', err)
        })
      }
    },
  })
}

initTTSWatch()
initMicHotkeyWatch()
initModelStatusWatch()

// ── Model ──

function attachRecognizer(): void {
  if (!model || recognizer) return
  try {
    recognizer = new model.KaldiRecognizer(16000)
    recognizer.on('result', onResult)
    recognizer.on('partialresult', onPartialResult)
    console.info('[useSTT] KaldiRecognizer attached to audio stream')
  } catch (err) {
    console.error('[useSTT] Failed to instantiate KaldiRecognizer:', err)
  }
}

async function loadModel(): Promise<void> {
  if (model) {
    attachRecognizer()
    return
  }
  if (isModelLoading.value) return

  isModelLoading.value = true
  try {
    const Vosk = await import('vosk-browser')
    const { language } = (await api.settings.getConfig.query()).stt

    model = await Vosk.createModel(`stt-model://${language}.zip`)
    isModelLoaded.value = true
    attachRecognizer()
    console.info('[useSTT] Vosk Model loaded and wake-word recognizer active')
  } catch (err) {
    console.warn('[useSTT] Vosk model not available yet or failed to load:', err)
    isModelLoaded.value = false
  } finally {
    isModelLoading.value = false
  }
}

// ── Mic lifecycle ──

async function startMic(): Promise<void> {
  if (mediaStream) return

  if (!model) {
    loadModel().catch(() => {})
  }

  const cfg = await api.settings.getConfig.query()
  if (cfg.stt.wakeWord) customWakeWord.value = cfg.stt.wakeWord
  const micDeviceId = cfg.stt.micDeviceId && cfg.stt.micDeviceId !== 'default' ? cfg.stt.micDeviceId : ''

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: micDeviceId
        ? {
            deviceId: { ideal: micDeviceId },
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          }
        : {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
    })
  } catch (deviceErr) {
    console.warn('[useSTT] getUserMedia failed with specified micDeviceId, falling back to default device:', deviceErr)
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })
  }

  audioContext = new AudioContext()
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  const actualRate = audioContext.sampleRate || 16000

  sourceNode = audioContext.createMediaStreamSource(mediaStream)

  // Helper to resample any native browser rate (44.1k/48k) to 16k for Vosk
  function resampleTo16k(audioData: Float32Array, origRate: number): Float32Array {
    if (origRate === 16000) return audioData
    const ratio = origRate / 16000
    const newLen = Math.round(audioData.length / ratio)
    const result = new Float32Array(newLen)
    for (let i = 0; i < newLen; i++) {
      const origIdx = i * ratio
      const low = Math.floor(origIdx)
      const high = Math.min(low + 1, audioData.length - 1)
      const weight = origIdx - low
      result[i] = audioData[low] * (1 - weight) + audioData[high] * weight
    }
    return result
  }

  // Use AudioWorklet if available (off-main-thread), fallback to ScriptProcessor
  await audioContext.audioWorklet.addModule(createWorkletBlob())
  const workletNode = new AudioWorkletNode(audioContext, 'stt-processor')
  workletNode.port.onmessage = (e) => {
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

    if (recognizer) {
      // Vosk recognizer expects exactly 16000Hz audio
      const samples16k = resampleTo16k(samples, actualRate)
      const buf = audioContext!.createBuffer(1, samples16k.length, 16000)
      buf.getChannelData(0).set(samples16k)
      recognizer.acceptWaveform(buf)
    } else if (phase.value === 'activated' || phase.value === 'listening') {
      detectSilenceByEnergy(samples)
    }
  }
  sourceNode.connect(workletNode)
  const silentGain = audioContext.createGain()
  silentGain.gain.value = 0
  workletNode.connect(silentGain)
  silentGain.connect(audioContext.destination)

  phase.value = 'idle'
  initVisibilityWatch()
  initConfigWatch()
  console.info('[useSTT] Mic started, ready for voice and wake word')
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
      cachedSTTConfig = cfg
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
          this.port.postMessage(new Float32Array(input[0]))
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
  const CHUNK_SZ = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK_SZ) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK_SZ)))
  }
  return btoa(binary)
}

// ── Wake word + transcript handling ──

function getWakeWords(): string[] {
  const { activePersona } = usePersonas()
  const personaName = (activePersona.value?.name || 'eva-01').toLowerCase().trim()
  const configured = (customWakeWord.value || 'eva-01').toLowerCase().trim()

  const words = new Set<string>()
  const addVariations = (base: string) => {
    words.add(base)
    if (base.includes('eva') || base === 'eva-01' || base === 'eva') {
      words.add('eva-01')
      words.add('eva 01')
      words.add('eva one')
      words.add('eva')
      words.add('ever')
      words.add('ava')
      words.add('iva')
      words.add('he ever')
      words.add('hey ever')
      words.add('hey eva')
      words.add('hey ava')
      words.add('hey iva')
      words.add('hi eva')
      words.add('hi ever')
      words.add('hello eva')
      words.add('ok eva')
      words.add('okay eva')
    }
  }

  if (configured) addVariations(configured)
  if (personaName) addVariations(personaName)
  // Backwards compatibility alias
  words.add('atlas')
  words.add('hey atlas')

  return Array.from(words)
}

function containsWakeWord(text: string): boolean {
  const lower = text.toLowerCase().trim()
  return getWakeWords().some((w) => {
    const regex = new RegExp(`(^|\\b|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|\\s|$)`, 'i')
    return regex.test(lower)
  })
}

function onPartialResult(msg: any): void {
  if (isSettingsOpen.value) return
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
      // CRITICAL: Only reset silence timer when NEW words/tokens arrive!
      // In Vosk, identical partial results are continuously emitted while silent.
      if (clean !== lastSeenPartial) {
        lastSeenPartial = clean
        resetSilenceTimer()
      }
    }
  }
}

function onResult(msg: any): void {
  if (isSettingsOpen.value) return
  const text: string = msg?.result?.text || msg?.text || ''
  if (!text.trim()) return

  // Ignore stale events right after submit
  if (Date.now() - lastSubmitTime < 500) return

  if (phase.value === 'idle') {
    console.info('[useSTT] Idle speech recognized:', text)
    if (containsWakeWord(text)) {
      activate(text)
    }
  } else if (phase.value === 'activated' || phase.value === 'listening') {
    const clean = stripWakeWord(text).trim()
    if (clean) {
      phase.value = 'listening'
      chunks.value.push(clean)
      transcript.value = ''
      lastSeenPartial = ''
      // Vosk finalized this segment - rapid submit
      clearSilenceTimer()
      silenceTimer = setTimeout(() => {
        submitTranscript()
      }, 900)
    }
  }
}

function activate(initialText: string): void {
  if (isSettingsOpen.value) return
  lastSeenPartial = ''
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
  if (!cleaned) return ''

  const wakeWords = getWakeWords()
  const escaped = wakeWords
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|')

  if (escaped) {
    // Strictly strip wake words at the BEGINNING of the utterance (optionally preceded by greetings/fillers)
    const wakeRegex = new RegExp(
      `^(?:(?:hey|hi|hello|ok|okay|yo|um|uh|ah|er)\\s+)*(?:${escaped})\\b[\\s,:;!?-]*`,
      'i',
    )
    cleaned = cleaned.replace(wakeRegex, '').trim()
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

let isTranscribing = false

async function submitTranscript(): Promise<void> {
  if (isSettingsOpen.value || isTranscribing) return
  isTranscribing = true
  clearSilenceTimer()

  // Drain audio buffers immediately so overlapping speech chunks cannot double-submit
  const currentRecorded = recordedBuffers.splice(0)
  preRollBuffers = []
  preRollSamples = 0

  const allParts = [...chunks.value]
  const currentPartial = transcript.value.trim()
  if (currentPartial && !allParts.includes(currentPartial)) {
    allParts.push(currentPartial)
  }
  const voskFallback = allParts.join(' ').trim()
  let fullText = voskFallback
  lastSeenPartial = ''

  // If Whisper or In-App Whisper mode is configured (or hybrid)
  try {
    const config = cachedSTTConfig || (await api.settings.getConfig.query())
    const isWhisperFlow =
      config.stt.provider === 'whisper' ||
      config.stt.provider === 'in-app-whisper' ||
      config.stt.provider === 'hybrid' ||
      config.stt.provider === 'groq-whisper' ||
      config.stt.provider === 'faster-whisper' ||
      config.stt.provider === 'handy'

    if (isWhisperFlow && currentRecorded.length > 0) {
      console.info('[useSTT] Running Whisper transcription with', currentRecorded.length, 'audio chunks...')
      const actualSampleRate = audioContext?.sampleRate || 16000
      const wavBase64 = encodeWAV(currentRecorded, actualSampleRate)
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
  } finally {
    isTranscribing = false
  }

  // If Whisper returned empty, use Vosk candidate
  if (!fullText && voskFallback) {
    fullText = voskFallback
  }
  if (!fullText) return

  // Clean any leading punctuation or conversational filler ("ah", "um", "uh", "hey")
  fullText = stripWakeWord(fullText)
  fullText = fullText.replace(/^[,.:;!?-]+/, '').replace(/^(ah|um|uh|er|eh|hey|hi|yo)\s+/i, '').trim()
  if (!fullText) {
    if (phase.value === 'activated' || phase.value === 'listening') {
      console.info('[useSTT] Wake word invoked without command -> greeting user')
      fullText = 'Hello!'
    } else {
      return
    }
  }

  // Discard empty/hallucinated bracketed tokens (e.g. [BLANK_AUDIO], [TAKE VO], [MUSIC], (silence)) or repetition loops
  const isGarbageToken = (t: string) => {
    const stripped = t.replace(/[([{][^\])}]*[\])}]/g, '').trim()
    if (!stripped) return true
    if (/^(take vo|blank audio|subtitles by|thank you for watching)$/i.test(stripped)) return true
    // Repeated 2-word loop e.g. "ever ever ever"
    if (/^(\b\w+\s+\w+\b)(?:\s+\1)+$/i.test(stripped)) return true
    return false
  }

  if (isGarbageToken(fullText)) {
    console.info('[useSTT] Dropped silent/garbage transcription token:', fullText)
    phase.value = 'idle'
    transcript.value = ''
    chunks.value = []
    api.audio.stopListening.mutate().catch(() => {})
    return
  }

  // Guard: prevent duplicate submissions and substring spurt bursts
  const now = Date.now()
  const lower = fullText.toLowerCase()
  const lastLower = lastSubmitText.toLowerCase()
  if (
    now - lastSubmitTime < 3500 &&
    (lower === lastLower || lower.startsWith(lastLower) || lastLower.startsWith(lower) || (lastLower.length > 5 && lower.includes(lastLower)))
  ) {
    console.info('[useSTT] Dropping redundant/spurt auto-submit:', fullText, 'vs last:', lastSubmitText)
    return
  }
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

export function stopListening(): void {
  clearSilenceTimer()
  phase.value = 'idle'
  transcript.value = ''
  chunks.value = []
  recordedBuffers = []
  api.audio.stopListening.mutate().catch(() => {})
  console.info('[useSTT] Manually stopped listening')
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
    stopListening,
  }
}
