import { ref } from 'vue'
import { api } from '@/api'

/**
 * useTTS — TTS audio playback with dual-format support.
 *
 * Supports two playback modes based on the provider's audio format:
 * - **mpeg**: streaming via MediaSource Extensions (MSE)
 * - **opus**: complete buffer via blob URL + Audio element
 *
 * Subscribes to `audio.onTTSFormat`, `audio.onTTSAudio`, `audio.onTTSStatus`.
 *
 * Usage: call `useTTS()` once in MainView setup — it auto-subscribes.
 */

const speaking = ref(false)
let ttsEndedAt = 0

/**
 * Returns true if TTS is actively speaking, or if speech ended
 * within the last 1000ms. Used by STT to prevent acoustic loopback.
 */
export function isSpeakingOrRecentEcho(): boolean {
  if (speaking.value) return true
  if (Date.now() - ttsEndedAt < 1000) return true
  return false
}

let currentFormat: 'mpeg' | 'opus' | 'web-speech' = 'mpeg'
let mediaSource: MediaSource | null = null
let sourceBuffer: SourceBuffer | null = null
let audioElement: HTMLAudioElement | null = null
let pendingChunks: Uint8Array[] = []
let sourceBufferReady = false
let subscribed = false

// ── Helpers ──

/** Convert base64 string to Uint8Array */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function applySpeakerSink(element: HTMLAudioElement) {
  try {
    const config = await api.settings.getConfig.query()
    const deviceId = config.tts.speakerDeviceId
    if (deviceId && 'setSinkId' in element) {
      await (element as any).setSinkId(deviceId)
    }
  } catch (err) {
    console.warn('[useTTS] Failed to set speaker sinkId:', err)
  }
}

// ── MSE pipeline (for mpeg streaming) ──

/** Flush any queued chunks to the SourceBuffer */
function flushPendingChunks() {
  if (!sourceBuffer || sourceBuffer.updating || pendingChunks.length === 0) return
  const chunk = pendingChunks.shift()!
  sourceBuffer.appendBuffer(chunk.buffer as ArrayBuffer)
}

/** Reset MSE state for a new speech session */
function resetMSE() {
  // Clean up previous session
  if (audioElement) {
    audioElement.pause()
    audioElement.removeAttribute('src')
    audioElement.load()
  }

  if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
    try {
      mediaSource.removeSourceBuffer(sourceBuffer)
    } catch {
      // ignore
    }
  }

  pendingChunks = []
  sourceBuffer = null
  sourceBufferReady = false

  // Create fresh MediaSource
  mediaSource = new MediaSource()
  audioElement = audioElement || new Audio()
  applySpeakerSink(audioElement)
  audioElement.src = URL.createObjectURL(mediaSource)

  mediaSource.addEventListener('sourceopen', () => {
    if (!mediaSource) return
    try {
      sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg')
      sourceBufferReady = true

      sourceBuffer.addEventListener('updateend', () => {
        flushPendingChunks()
      })

      // Flush any chunks that arrived before sourceopen
      flushPendingChunks()

      // Start playback
      audioElement?.addEventListener('ended', () => {
        speaking.value = false
        ttsEndedAt = Date.now()
      }, { once: true })

      audioElement?.play().catch((err) => {
        console.warn('[useTTS] Playback failed:', err)
        speaking.value = false
        ttsEndedAt = Date.now()
      })
    } catch (err) {
      console.error('[useTTS] Failed to create SourceBuffer:', err)
    }
  })
}

/** Add an audio chunk to the MSE pipeline */
function addChunkMSE(base64Data: string) {
  const chunk = base64ToUint8Array(base64Data)
  if (chunk.length === 0) return

  pendingChunks.push(chunk)

  if (sourceBufferReady) {
    flushPendingChunks()
  }
}

/** Signal that all audio has been received (MSE) */
function endStreamMSE() {
  const waitForFlush = () => {
    if (!sourceBuffer || !mediaSource) return
    if (sourceBuffer.updating || pendingChunks.length > 0) {
      setTimeout(waitForFlush, 50)
      return
    }
    if (mediaSource.readyState === 'open') {
      try {
        mediaSource.endOfStream()
      } catch {
        // ignore
      }
    }
  }
  waitForFlush()
}

// ── Blob URL pipeline (for opus / non-streaming) ──

/** Collected chunks for non-streaming playback */
let blobChunks: Uint8Array[] = []

/** Reset blob state for a new session */
function resetBlob() {
  blobChunks = []

  // Clean up previous audio element
  if (audioElement) {
    audioElement.pause()
    audioElement.removeAttribute('src')
    audioElement.load()
  }

  audioElement = audioElement || new Audio()
}

/** Add a chunk to the blob buffer */
function addChunkBlob(base64Data: string) {
  const chunk = base64ToUint8Array(base64Data)
  if (chunk.length === 0) return
  blobChunks.push(chunk)
}

/** All chunks received — create blob URL and play */
function endStreamBlob() {
  if (blobChunks.length === 0) return

  // Merge all chunks into a single Uint8Array for Blob constructor
  const totalLength = blobChunks.reduce((acc, c) => acc + c.length, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const c of blobChunks) {
    merged.set(c, offset)
    offset += c.length
  }

  const blob = new Blob([merged.buffer], { type: 'audio/ogg; codecs=opus' })
  const url = URL.createObjectURL(blob)

  if (!audioElement) audioElement = new Audio()
  applySpeakerSink(audioElement)
  audioElement.src = url
  audioElement.play().catch((err) => {
    console.warn('[useTTS] Blob playback failed:', err)
  })

  // Clean up blob URL when done
  audioElement.addEventListener('ended', () => {
    URL.revokeObjectURL(url)
    speaking.value = false
    ttsEndedAt = Date.now()
  }, { once: true })

  blobChunks = []
}

// ── Subscriptions ──

function initSubscriptions() {
  if (subscribed) return
  subscribed = true

  // TTS format (tells us which playback pipeline to use)
  api.audio.onTTSFormat.subscribe(undefined, {
    onData(data: { format: 'mpeg' | 'opus' | 'web-speech' }) {
      currentFormat = data.format
    },
  })

  // Web Speech text synthesis (browser native)
  api.audio.onTTSText.subscribe(undefined, {
    onData(data: { text: string; voice?: string; rate?: number; pitch?: number }) {
      playWebSpeech(data.text, data)
    },
  })

  // TTS status
  api.audio.onTTSStatus.subscribe(undefined, {
    onData(data: { speaking: boolean }) {
      speaking.value = data.speaking
      if (!data.speaking) {
        ttsEndedAt = Date.now()
      }

      if (data.speaking) {
        // New speech session — prepare playback pipeline
        if (currentFormat === 'opus') {
          resetBlob()
        } else if (currentFormat === 'mpeg') {
          resetMSE()
        }
      }
    },
  })

  // TTS audio chunks
  api.audio.onTTSAudio.subscribe(undefined, {
    onData(data: { data: string; done: boolean }) {
      if (currentFormat === 'opus') {
        if (data.done) {
          endStreamBlob()
        } else {
          addChunkBlob(data.data)
        }
      } else if (currentFormat === 'mpeg') {
        if (data.done) {
          endStreamMSE()
        } else {
          addChunkMSE(data.data)
        }
      }
    },
  })
}

/** Play speech using the browser's built-in Web Speech API */
export function playWebSpeech(
  text: string,
  options?: { voice?: string; rate?: number; pitch?: number },
) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()

  const utterance = new SpeechSynthesisUtterance(text)
  if (options?.rate) utterance.rate = Math.max(0.5, Math.min(2.0, options.rate))
  if (options?.pitch) utterance.pitch = Math.max(0.5, Math.min(1.5, options.pitch))

  const voices = window.speechSynthesis.getVoices()
  if (options?.voice) {
    const matched = voices.find((v) => v.name === options.voice || v.voiceURI === options.voice)
    if (matched) utterance.voice = matched
  } else {
    // Pick an English or system voice
    const enVoice = voices.find((v) => v.lang.startsWith('en'))
    if (enVoice) utterance.voice = enVoice
  }

  speaking.value = true
  utterance.onstart = () => {
    speaking.value = true
  }
  utterance.onend = () => {
    speaking.value = false
    ttsEndedAt = Date.now()
  }
  utterance.onerror = () => {
    speaking.value = false
    ttsEndedAt = Date.now()
  }

  // Failsafe auto-reset in case Chromium pauses or fails to emit onend on long texts
  const estimatedSeconds = Math.max(3, Math.min(25, (text.split(/\s+/).length / 2.2) + 2))
  setTimeout(() => {
    if (speaking.value) {
      speaking.value = false
      ttsEndedAt = Date.now()
    }
  }, estimatedSeconds * 1000)

  window.speechSynthesis.speak(utterance)
}

/** Stop frontend audio playback immediately (call from outside useTTS, e.g. useResponse) */
export function stopPlayback() {
  // Cancel Web Speech API
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel()
    } catch {
      // ignore
    }
  }

  // Clear pending chunks so nothing new gets appended
  pendingChunks = []
  blobChunks = []

  // Tear down MSE pipeline
  if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
    try {
      sourceBuffer.abort()
      mediaSource.removeSourceBuffer(sourceBuffer)
    } catch {
      // ignore — may already be removed
    }
  }
  sourceBuffer = null
  sourceBufferReady = false
  mediaSource = null

  // Stop and reset audio element
  if (audioElement) {
    audioElement.pause()
    audioElement.removeAttribute('src')
    audioElement.load()
  }
  speaking.value = false
  ttsEndedAt = Date.now()
}

export function useTTS() {
  initSubscriptions()

  /** Stop playback immediately */
  function stop() {
    stopPlayback()
    api.audio.stopSpeaking.mutate()
  }

  return {
    speaking,
    stop,
    playWebSpeech,
  }
}
