import { defineComponent, ref, computed, type PropType, onMounted, onBeforeUnmount } from 'vue'
import type { AppConfig } from '@/composables/useSettings'
import { api } from '@/api'
import { useSounds } from '@/composables/useSounds'
import { playWebSpeech } from '@/composables/useTTS'
import CustomSelect from '../components/CustomSelect'

/**
 * VoiceTab — Audio devices (mic + speaker), TTS, and STT (Vosk + Whisper offline flow).
 */
export default defineComponent({
  name: 'VoiceTab',

  props: {
    config: { type: Object as PropType<AppConfig>, required: true },
  },

  emits: ['update'],

  setup(props, { emit }) {
    const { playTest, setSpeakerId } = useSounds()

    // Model management
    const modelStatus = ref<{ downloaded: boolean; path: string }>({ downloaded: false, path: '' })
    const downloading = ref(false)
    const downloadProgress = ref(0)
    const downloadError = ref('')
    const languages = ref<{ code: string; label: string }[]>([])
    const resetting = ref(false)

    // Audio Devices
    const micDevices = ref<{ value: string; label: string }[]>([])
    const speakerDevices = ref<{ value: string; label: string }[]>([])
    const testingMic = ref(false)
    const micLevel = ref(0)
    let micStream: MediaStream | null = null
    let micAudioCtx: AudioContext | null = null
    let micAnimFrame: number | null = null

    // System Voices for Web Speech
    const systemVoices = ref<{ value: string; label: string }[]>([])

    function loadSystemVoices() {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const voices = window.speechSynthesis.getVoices()
        systemVoices.value = [
          { value: '', label: 'Default System Voice' },
          ...voices.map((v) => ({
            value: v.name,
            label: `${v.name} (${v.lang})`,
          })),
        ]
      }
    }

    // Mic Command Shortcut Recording
    const recordingMicHotkey = ref(false)
    let micHotkeyHandler: ((e: KeyboardEvent) => void) | null = null

    function stopRecordingMicHotkey() {
      if (micHotkeyHandler) {
        window.removeEventListener('keydown', micHotkeyHandler, true)
        micHotkeyHandler = null
      }
      recordingMicHotkey.value = false
    }

    function startRecordingMicHotkey() {
      stopRecordingMicHotkey()
      recordingMicHotkey.value = true
      const handler = (e: KeyboardEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const parts: string[] = []
        if (e.ctrlKey) parts.push('Ctrl')
        if (e.altKey) parts.push('Alt')
        if (e.shiftKey) parts.push('Shift')
        if (e.metaKey) parts.push('Meta')
        const key = e.key
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return
        parts.push(key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key)
        emit('update', 'stt', { ...props.config.stt, micHotkey: parts.join('+') })
        stopRecordingMicHotkey()
      }
      micHotkeyHandler = handler
      window.addEventListener('keydown', handler, true)
    }

    // Whisper Connection Tests (In-App & External/Cloud)
    const testingInAppWhisper = ref(false)
    const inAppWhisperStatus = ref<{ ok?: boolean; message?: string } | null>(null)
    const testingExternalWhisper = ref(false)
    const externalWhisperStatus = ref<{ ok?: boolean; message?: string } | null>(null)

    // TTS Auto-Detection
    const detectingTTS = ref(false)
    const detectedTTS = ref<{ recommendedProvider: string; label: string; reason: string } | null>(null)

    async function runAutoDetectTTS() {
      detectingTTS.value = true
      try {
        const res = await api.audio.detectOptimalTTS.query()
        detectedTTS.value = res
      } catch (err) {
        console.warn('Auto-detect TTS failed:', err)
      } finally {
        detectingTTS.value = false
      }
    }

    const sortedLanguages = computed(() =>
      [...languages.value].sort((a, b) => a.label.localeCompare(b.label)),
    )

    const languageOptions = computed(() =>
      sortedLanguages.value.map((l) => ({ value: l.code, label: l.label })),
    )

    async function loadAudioDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const mics = devices
          .filter((d) => d.kind === 'audioinput')
          .map((d, index) => ({
            value: d.deviceId,
            label: d.label || `Microphone ${index + 1}`,
          }))
        micDevices.value = [{ value: '', label: 'Default - System Microphone' }, ...mics]

        const speakers = devices
          .filter((d) => d.kind === 'audiooutput')
          .map((d, index) => ({
            value: d.deviceId,
            label: d.label || `Speaker / Output ${index + 1}`,
          }))
        speakerDevices.value = [{ value: '', label: 'Default - System Speaker' }, ...speakers]
      } catch (err) {
        console.warn('Failed to enumerate audio devices:', err)
      }
    }

    onMounted(async () => {
      await loadAudioDevices()
      loadSystemVoices()
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.onvoiceschanged = loadSystemVoices
      }

      try {
        const [status, langs] = await Promise.all([
          api.audio.getSTTModelStatus.query(),
          api.audio.getSTTLanguages.query(),
        ])
        modelStatus.value = status as { downloaded: boolean; path: string }
        languages.value = langs as { code: string; label: string }[]
      } catch (err) {
        console.error('Failed to load STT status:', err)
      }

      api.audio.onSTTModelStatus.subscribe(undefined, {
        onData(data: { downloaded: boolean; progress?: number; error?: string }) {
          if (data.downloaded) {
            modelStatus.value.downloaded = true
            downloading.value = false
            downloadProgress.value = 100
          }
          if (data.error) { downloadError.value = data.error; downloading.value = false }
        },
      })

      runAutoDetectTTS()
    })

    onBeforeUnmount(() => {
      stopMicTest()
      stopRecordingMicHotkey()
    })

    async function toggleMicTest() {
      if (testingMic.value) {
        stopMicTest()
      } else {
        await startMicTest()
      }
    }

    async function startMicTest() {
      stopMicTest()
      try {
        const deviceId = props.config.stt.micDeviceId
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        })
        micAudioCtx = new AudioContext()
        const source = micAudioCtx.createMediaStreamSource(micStream)
        const analyser = micAudioCtx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)

        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        testingMic.value = true

        const updateMeter = () => {
          if (!testingMic.value) return
          analyser.getByteFrequencyData(dataArray)
          let sum = 0
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i]
          }
          const avg = sum / dataArray.length
          micLevel.value = Math.min(100, Math.round((avg / 128) * 100))
          micAnimFrame = requestAnimationFrame(updateMeter)
        }
        updateMeter()
      } catch (err) {
        console.error('Mic test failed:', err)
        stopMicTest()
      }
    }

    function stopMicTest() {
      testingMic.value = false
      micLevel.value = 0
      if (micAnimFrame) cancelAnimationFrame(micAnimFrame)
      micAnimFrame = null
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop())
        micStream = null
      }
      if (micAudioCtx) {
        micAudioCtx.close()
        micAudioCtx = null
      }
    }

    function testSpeakerOutput() {
      const sinkId = props.config.tts.speakerDeviceId
      setSpeakerId(sinkId)
      playTest(sinkId)
    }

    function testSpeechOutput() {
      const tts = props.config.tts
      if (tts.provider === 'web-speech') {
        playWebSpeech('EVA-01 speech synthesis online. All systems synchronized and operational.', {
          voice: tts.voiceId,
          rate: tts.rate ?? 1.0,
          pitch: tts.pitch ?? 1.0,
        })
      } else {
        api.audio.speak.mutate({
          text: 'EVA-01 speech synthesis online. All systems synchronized and operational.',
        })
      }
    }

    async function testInAppWhisper() {
      testingInAppWhisper.value = true
      inAppWhisperStatus.value = null
      try {
        const res = await api.audio.testWhisper.mutate({
          endpoint: 'in-app',
        })
        if (res.ok) {
          inAppWhisperStatus.value = {
            ok: true,
            message: res.message || 'In-App Whisper Engine Ready (Embedded / Offline)',
          }
        } else {
          inAppWhisperStatus.value = { ok: false, message: res.error || 'Initialization failed' }
        }
      } catch (err: unknown) {
        inAppWhisperStatus.value = {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        }
      } finally {
        testingInAppWhisper.value = false
      }
    }

    async function testExternalWhisper() {
      testingExternalWhisper.value = true
      externalWhisperStatus.value = null
      try {
        const res = await api.audio.testWhisper.mutate({
          endpoint: props.config.stt.whisperEndpoint,
          apiKey: props.config.stt.whisperApiKey,
        })
        if (res.ok) {
          externalWhisperStatus.value = {
            ok: true,
            message: res.message || 'Whisper API Connected & Ready',
          }
        } else {
          externalWhisperStatus.value = { ok: false, message: res.error || 'Connection failed' }
        }
      } catch (err: unknown) {
        externalWhisperStatus.value = {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        }
      } finally {
        testingExternalWhisper.value = false
      }
    }

    async function downloadModel() {
      downloading.value = true
      downloadError.value = ''
      downloadProgress.value = 0
      try {
        await api.audio.downloadSTTModel.mutate({ language: props.config.stt.language })
        modelStatus.value.downloaded = true
      } catch (err: unknown) {
        downloadError.value = (err as Error).message || 'Download failed'
      } finally {
        downloading.value = false
      }
    }

    async function refreshModelStatus() {
      try {
        const status = await api.audio.getSTTModelStatus.query({ language: props.config.stt.language })
        modelStatus.value = status as { downloaded: boolean; path: string }
      } catch (err) {
        console.error('Failed to refresh STT model status:', err)
      }
    }

    return {
      modelStatus,
      downloading,
      downloadProgress,
      downloadError,
      languageOptions,
      downloadModel,
      resetting,
      refreshModelStatus,
      micDevices,
      speakerDevices,
      systemVoices,
      testingMic,
      micLevel,
      toggleMicTest,
      testSpeakerOutput,
      testSpeechOutput,
      recordingMicHotkey,
      startRecordingMicHotkey,
      testingInAppWhisper,
      inAppWhisperStatus,
      testInAppWhisper,
      testingExternalWhisper,
      externalWhisperStatus,
      testExternalWhisper,
      detectingTTS,
      detectedTTS,
      runAutoDetectTTS,
    }
  },

  render() {
    const tts = this.config.tts
    const stt = this.config.stt
    const isAlice = tts.provider === 'yandex-alice'

    return (
      <div class="settings-tab">
        <h2 class="settings-tab__title">Voice & Audio</h2>
        <p class="settings-tab__subtitle">Audio devices, Text-to-Speech, and Speech-to-Text</p>

        {/* ── Audio Devices (Microphone & Speaker) ── */}
        <div class="settings-section">
          <div class="settings-section__title">Audio Devices</div>
          <div class="settings-section__card">
            {/* Microphone */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Microphone</span>
                <span class="settings-row__hint">Input device for speech commands</span>
              </div>
              <div class="settings-row__control" style="min-width: 220px;">
                <CustomSelect
                  modelValue={stt.micDeviceId || ''}
                  onUpdate:modelValue={(v: string) => { stt.micDeviceId = v }}
                  options={this.micDevices}
                />
              </div>
            </div>

            {/* Mic Meter & Test */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Microphone Level</span>
                <span class="settings-row__hint">Speak into your mic to test input</span>
              </div>
              <div class="settings-row__control" style="display: flex; align-items: center; gap: 10px; width: 220px;">
                <div style="flex: 1; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden;">
                  <div style={{
                    width: `${this.micLevel}%`,
                    height: '100%',
                    background: this.micLevel > 70 ? 'oklch(0.7 0.2 140)' : 'oklch(0.65 0.2 260)',
                    transition: 'width 80ms ease-out',
                  }} />
                </div>
                <button
                  type="button"
                  class="settings-field__button"
                  style="padding: 4px 10px; font-size: 11px;"
                  onClick={() => this.toggleMicTest()}
                >
                  <span class="settings-field__button-icon">{this.testingMic ? 'stop' : 'mic'}</span>
                  {this.testingMic ? 'Stop' : 'Test'}
                </button>
              </div>
            </div>

            {/* Mic Command Shortcut */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Mic Command Shortcut</span>
                <span class="settings-row__hint">Global keyboard shortcut to toggle voice listening</span>
              </div>
              <div class="settings-row__control">
                <div class="settings-hotkey">
                  <kbd class="settings-hotkey__key">{stt.micHotkey || 'Ctrl+Shift+Space'}</kbd>
                  <button
                    type="button"
                    class="settings-hotkey__record"
                    onClick={() => this.startRecordingMicHotkey()}
                  >
                    {this.recordingMicHotkey ? 'Press keys…' : 'Change'}
                  </button>
                </div>
              </div>
            </div>

            {/* Speaker */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Speaker / Output</span>
                <span class="settings-row__hint">Audio playback device for voice and sounds</span>
              </div>
              <div class="settings-row__control" style="min-width: 220px;">
                <CustomSelect
                  modelValue={tts.speakerDeviceId || ''}
                  onUpdate:modelValue={(v: string) => { tts.speakerDeviceId = v }}
                  options={this.speakerDevices}
                />
              </div>
            </div>

            {/* Test Speaker */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Speaker Test</span>
                <span class="settings-row__hint">Play a chime to test output</span>
              </div>
              <div class="settings-row__control">
                <button
                  type="button"
                  class="settings-field__button"
                  onClick={() => this.testSpeakerOutput()}
                >
                  <span class="settings-field__button-icon">volume_up</span>
                  Play Test Sound
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── Speech-to-Text & In-App Whisper ── */}
        <div class="settings-section">
          <div class="settings-section__title">Speech-to-Text & Wake Word</div>
          <div class="settings-section__card">
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Enable Speech-to-Text</span>
                <span class="settings-row__hint">Voice input through microphone</span>
              </div>
              <div class="settings-row__control">
                <input type="checkbox" class="settings-field__toggle" checked={stt.enabled}
                  onChange={(e: Event) => { stt.enabled = (e.target as HTMLInputElement).checked }} />
              </div>
            </div>

            {/* Wake Word */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Wake Word</span>
                <span class="settings-row__hint">Word spoken to activate listening</span>
              </div>
              <div class="settings-row__control" style="min-width: 220px;">
                <input
                  type="text"
                  class="settings-field__input"
                  value={stt.wakeWord || 'eva-01'}
                  placeholder="e.g. eva-01, jarvis, computer"
                  onInput={(e: Event) => { stt.wakeWord = (e.target as HTMLInputElement).value }}
                />
              </div>
            </div>

            {/* Wake Word Quick Presets */}
            <div class="settings-row" style="border-top: none; padding-top: 0;">
              <div class="settings-row__info">
                <span class="settings-row__hint">Quick presets:</span>
              </div>
              <div class="settings-row__control" style="display: flex; gap: 6px; flex-wrap: wrap;">
                {['eva-01', 'eva', 'atlas', 'jarvis', 'computer'].map((word) => (
                  <button
                    key={word}
                    type="button"
                    class="settings-field__button"
                    style={{
                      padding: '3px 8px',
                      fontSize: '11px',
                      opacity: (stt.wakeWord || 'eva-01').toLowerCase() === word ? '1' : '0.6',
                    }}
                    onClick={() => { stt.wakeWord = word }}
                  >
                    {word}
                  </button>
                ))}
              </div>
            </div>

            {/* STT Engine */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">STT Engine</span>
                <span class="settings-row__hint">Recognition model backend</span>
              </div>
              <div class="settings-row__control" style="min-width: 240px;">
                <CustomSelect
                  modelValue={stt.provider || 'hybrid'}
                  onUpdate:modelValue={(v: string) => { stt.provider = v as any }}
                  options={[
                    { value: 'in-app-whisper', label: '⚡ In-App Whisper (Embedded / Offline)' },
                    { value: 'hybrid', label: '🔀 Hybrid (Vosk Wake + In-App Whisper)' },
                    { value: 'whisper', label: '🌐 External Whisper Server (Port 8080)' },
                    { value: 'vosk', label: '🎙️ Vosk (WebAssembly Offline)' },
                  ]}
                />
              </div>
            </div>

            {/* Language */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Language</span>
              </div>
              <div class="settings-row__control" style="min-width: 220px;">
                <CustomSelect
                  modelValue={stt.language}
                  onUpdate:modelValue={(v: string) => { stt.language = v; this.refreshModelStatus() }}
                  options={this.languageOptions}
                />
              </div>
            </div>

            {/* Vosk Model status if Vosk or Hybrid */}
            {(stt.provider === 'vosk' || stt.provider === 'hybrid') && (
              <div class="settings-row">
                <div class="settings-row__info">
                  <span class="settings-row__label">Vosk Wake Word Model</span>
                  <span class="settings-row__hint">
                    {this.modelStatus.downloaded ? '✓ Downloaded & Ready' : 'Not downloaded'}
                  </span>
                </div>
                <div class="settings-row__control">
                  {!this.modelStatus.downloaded && (
                    this.downloading ? (
                      <div class="stt-download-progress" style="width: 160px;">
                        <div class="stt-download-progress__bar" style={{ width: `${this.downloadProgress}%` }} />
                        <span class="stt-download-progress__text">{this.downloadProgress}%</span>
                      </div>
                    ) : (
                      <button class="settings-field__button" onClick={this.downloadModel}>
                        <span class="settings-field__button-icon">download</span>
                        Download
                      </button>
                    )
                  )}
                </div>
              </div>
            )}
          </div>

          {/* In-App Whisper Settings */}
          {(stt.provider === 'in-app-whisper' || stt.provider === 'hybrid') && (
            <div style="margin-top: 12px;">
              <div class="settings-section__card" style="padding: 12px 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <span style="font-weight: 600; font-size: 13px; display: block;">⚡ In-App Embedded Whisper</span>
                    <span style="font-size: 11px; opacity: 0.7;">Runs directly in the app using @xenova/transformers. No server required.</span>
                  </div>
                  <button
                    type="button"
                    class="settings-field__button"
                    style="white-space: nowrap;"
                    onClick={() => this.testInAppWhisper()}
                    disabled={this.testingInAppWhisper}
                  >
                    <span class="settings-field__button-icon">speed</span>
                    {this.testingInAppWhisper ? 'Testing Engine…' : 'Test In-App Whisper'}
                  </button>
                </div>

                <div style="margin-top: 12px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px;">
                  <div>
                    <span style="font-size: 12px; font-weight: 500; display: block;">Model Precision</span>
                    <span style="font-size: 11px; opacity: 0.6;">Select model trade-off between recognition quality and speed</span>
                  </div>
                  <div style="width: 240px;">
                    <CustomSelect
                      modelValue={stt.inAppWhisperModel || 'Xenova/whisper-base.en'}
                      onUpdate:modelValue={(v: string) => { stt.inAppWhisperModel = v }}
                      options={[
                        { value: 'Xenova/whisper-base.en', label: 'Base English (High Accuracy, ~75MB)' },
                        { value: 'Xenova/whisper-tiny.en', label: 'Tiny English (Fastest, ~40MB)' },
                        { value: 'Xenova/whisper-small.en', label: 'Small English (Max Accuracy, ~240MB)' },
                      ]}
                    />
                  </div>
                </div>

                {this.inAppWhisperStatus && (
                  <div style={{
                    marginTop: '8px',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    backgroundColor: this.inAppWhisperStatus.ok ? 'oklch(0.3 0.08 140 / 0.3)' : 'oklch(0.3 0.1 25 / 0.3)',
                    color: this.inAppWhisperStatus.ok ? 'oklch(0.85 0.15 140)' : 'oklch(0.85 0.15 25)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}>
                    <span>{this.inAppWhisperStatus.ok ? '✓' : '⚠'}</span>
                    <span>{this.inAppWhisperStatus.message}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* External / Cloud Whisper API Settings */}
          <div style="margin-top: 12px;">
            <div class="settings-section__card" style="padding: 12px 16px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <div>
                  <span style="font-weight: 600; font-size: 13px; display: block;">🌐 External / Cloud Whisper API</span>
                  <span style="font-size: 11px; opacity: 0.7;">Use OpenAI, Groq, or a self-hosted Whisper server</span>
                </div>
                <button
                  type="button"
                  class="settings-field__button"
                  style="white-space: nowrap;"
                  onClick={() => this.testExternalWhisper()}
                  disabled={this.testingExternalWhisper}
                >
                  <span class="settings-field__button-icon">wifi_tethering</span>
                  {this.testingExternalWhisper ? 'Testing API…' : 'Test Whisper API'}
                </button>
              </div>

              <div class="settings-field" style="margin-bottom: 10px;">
                <span class="settings-field__label">Whisper Endpoint</span>
                <input
                  type="text"
                  class="settings-field__input"
                  value={stt.whisperEndpoint || 'http://localhost:8080/v1'}
                  placeholder="e.g. https://api.openai.com/v1 or http://localhost:8080/v1"
                  onInput={(e: Event) => { stt.whisperEndpoint = (e.target as HTMLInputElement).value }}
                />
                <div style="display: flex; gap: 6px; margin-top: 6px;">
                  <button
                    type="button"
                    class="settings-field__button"
                    style="padding: 2px 8px; font-size: 11px;"
                    onClick={() => { stt.whisperEndpoint = 'https://api.openai.com/v1'; stt.whisperModel = 'whisper-1' }}
                  >
                    OpenAI Cloud
                  </button>
                  <button
                    type="button"
                    class="settings-field__button"
                    style="padding: 2px 8px; font-size: 11px;"
                    onClick={() => { stt.whisperEndpoint = 'https://api.groq.com/openai/v1'; stt.whisperModel = 'whisper-large-v3' }}
                  >
                    Groq Whisper
                  </button>
                  <button
                    type="button"
                    class="settings-field__button"
                    style="padding: 2px 8px; font-size: 11px;"
                    onClick={() => { stt.whisperEndpoint = 'http://localhost:8080/v1'; stt.whisperModel = 'whisper-1' }}
                  >
                    Localhost:8080
                  </button>
                </div>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 6px;">
                <label class="settings-field" style="margin-bottom: 0;">
                  <span class="settings-field__label">Whisper API Key</span>
                  <input
                    type="password"
                    class="settings-field__input"
                    value={stt.whisperApiKey || ''}
                    placeholder="Enter API key (e.g. sk-...)"
                    onInput={(e: Event) => { stt.whisperApiKey = (e.target as HTMLInputElement).value }}
                  />
                </label>

                <label class="settings-field" style="margin-bottom: 0;">
                  <span class="settings-field__label">Model Name</span>
                  <input
                    type="text"
                    class="settings-field__input"
                    value={stt.whisperModel || 'whisper-1'}
                    placeholder="e.g. whisper-1, base"
                    onInput={(e: Event) => { stt.whisperModel = (e.target as HTMLInputElement).value }}
                  />
                </label>
              </div>

              {this.externalWhisperStatus && (
                <div style={{
                  marginTop: '8px',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  backgroundColor: this.externalWhisperStatus.ok ? 'oklch(0.3 0.08 140 / 0.3)' : 'oklch(0.3 0.1 25 / 0.3)',
                  color: this.externalWhisperStatus.ok ? 'oklch(0.85 0.15 140)' : 'oklch(0.85 0.15 25)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}>
                  <span>{this.externalWhisperStatus.ok ? '✓' : '⚠'}</span>
                  <span>{this.externalWhisperStatus.message}</span>
                </div>
              )}
            </div>
          </div>

          {this.downloadError && (
            <div style="margin-top: 8px; color: oklch(0.72 0.17 25); font-size: 12px;">{this.downloadError}</div>
          )}
        </div>

        {/* ── Text-to-Speech & Speech Customization ── */}
        <div class="settings-section">
          <div class="settings-section__title">Text-to-Speech & Speech Style</div>
          <div class="settings-section__card">
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Enable TTS</span>
                <span class="settings-row__hint">Voice output for agent responses</span>
              </div>
              <div class="settings-row__control">
                <input type="checkbox" class="settings-field__toggle" checked={tts.enabled}
                  onChange={(e: Event) => { tts.enabled = (e.target as HTMLInputElement).checked }} />
              </div>
            </div>

            {/* Provider */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">TTS Provider</span>
                <span class="settings-row__hint">Speech engine</span>
              </div>
              <div class="settings-row__control" style="min-width: 240px;">
                <CustomSelect
                  modelValue={tts.provider || 'auto'}
                  onUpdate:modelValue={(v: string) => { tts.provider = v }}
                  options={[
                    { value: 'auto', label: '✨ Auto-Detect (Optimal for your PC & Network)' },
                    { value: 'google-translate', label: '🌍 Google Free Voice (Multi-Accent, No API Key)' },
                    { value: 'web-speech', label: '🔊 Web Speech (Local System Voice / Free)' },
                    { value: 'yandex-alice', label: '🇷🇺 Yandex Alice (Free, Russian)' },
                    { value: 'elevenlabs', label: '🎙️ ElevenLabs (AI Realistic Voice)' },
                  ]}
                />
              </div>
            </div>

            {/* Auto-Detect Voice Recommendation Card */}
            <div style={{
              margin: '8px 0 14px 0',
              padding: '12px 14px',
              borderRadius: '8px',
              backgroundColor: 'rgba(255,255,255,0.025)',
              border: '1px solid rgba(255,255,255,0.06)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
            }}>
              <div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span style="font-size: 13px; font-weight: 600; color: #fff;">
                    {this.detectedTTS ? this.detectedTTS.label : '✨ Hardware & Network Voice Match'}
                  </span>
                  {this.detectedTTS && (
                    <span style="font-size: 10px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; padding: 1px 6px; border-radius: 4px; font-weight: 600;">
                      Detected Match
                    </span>
                  )}
                </div>
                <span style="font-size: 11px; opacity: 0.7; display: block; margin-top: 2px;">
                  {this.detectedTTS ? this.detectedTTS.reason : 'Scanning PC configuration, locale, and network latency...'}
                </span>
              </div>
              <div style="display: flex; gap: 6px; align-items: center;">
                <button
                  type="button"
                  class="settings-field__button"
                  style="white-space: nowrap; font-size: 11px; padding: 4px 10px;"
                  onClick={() => this.runAutoDetectTTS()}
                  disabled={this.detectingTTS}
                >
                  <span class="settings-field__button-icon">radar</span>
                  {this.detectingTTS ? 'Scanning…' : 'Scan PC Match'}
                </button>
                {this.detectedTTS && tts.provider !== this.detectedTTS.recommendedProvider && (
                  <button
                    type="button"
                    class="settings-field__button"
                    style="white-space: nowrap; font-size: 11px; padding: 4px 10px; background: rgba(56, 189, 248, 0.2); border-color: rgba(56, 189, 248, 0.4);"
                    onClick={() => {
                      tts.provider = this.detectedTTS!.recommendedProvider
                    }}
                  >
                    Apply Optimal
                  </button>
                )}
              </div>
            </div>

            {/* Accent Selection for Google Free Voice / Auto */}
            {(tts.provider === 'google-translate' || tts.provider === 'auto') && (
              <div class="settings-row">
                <div class="settings-row__info">
                  <span class="settings-row__label">Accent / Region</span>
                  <span class="settings-row__hint">Select pronunciation accent (no API key required)</span>
                </div>
                <div class="settings-row__control" style="min-width: 240px;">
                  <CustomSelect
                    modelValue={tts.accent || 'en-US'}
                    onUpdate:modelValue={(v: string) => { tts.accent = v }}
                    options={[
                      { value: 'en-US', label: '🇺🇸 US English' },
                      { value: 'en-GB', label: '🇬🇧 British English' },
                      { value: 'en-IN', label: '🇮🇳 Indian English' },
                      { value: 'en-AU', label: '🇦🇺 Australian English' },
                      { value: 'en-CA', label: '🇨🇦 Canadian English' },
                      { value: 'es', label: '🇪🇸 Spanish' },
                      { value: 'fr', label: '🇫🇷 French' },
                      { value: 'de', label: '🇩🇪 German' },
                      { value: 'ja', label: '🇯🇵 Japanese' },
                      { value: 'ru', label: '🇷🇺 Russian' },
                    ]}
                  />
                </div>
              </div>
            )}

            {/* Speech Style & Tone (How it speaks) */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Speech Style & Tone</span>
                <span class="settings-row__hint">How EVA-01 speaks and phrases responses</span>
              </div>
              <div class="settings-row__control" style="min-width: 240px;">
                <CustomSelect
                  modelValue={tts.style || 'balanced'}
                  onUpdate:modelValue={(v: string) => { tts.style = v }}
                  options={[
                    { value: 'balanced', label: 'Balanced & Natural' },
                    { value: 'concise', label: 'Concise & Direct (1-2 sentences)' },
                    { value: 'expressive', label: 'Expressive & Energetic' },
                    { value: 'pilot', label: 'EVA-01 Pilot (Tactical & Alert)' },
                    { value: 'formal', label: 'Formal & Articulate' },
                  ]}
                />
              </div>
            </div>

            {/* System Voice Selection (Web Speech) */}
            {tts.provider === 'web-speech' && (
              <div class="settings-row">
                <div class="settings-row__info">
                  <span class="settings-row__label">System Voice</span>
                  <span class="settings-row__hint">Select from installed Windows voices</span>
                </div>
                <div class="settings-row__control" style="min-width: 240px;">
                  <CustomSelect
                    modelValue={tts.voiceId || ''}
                    onUpdate:modelValue={(v: string) => { tts.voiceId = v }}
                    options={this.systemVoices}
                  />
                </div>
              </div>
            )}

            {/* Speech Rate (Speed) */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Speech Speed ({(tts.rate ?? 1.0).toFixed(2)}x)</span>
                <span class="settings-row__hint">Speech playback rate</span>
              </div>
              <div class="settings-row__control" style="display: flex; align-items: center; gap: 10px; width: 220px;">
                <input
                  type="range"
                  min="0.7"
                  max="1.5"
                  step="0.05"
                  value={tts.rate ?? 1.0}
                  style="flex: 1;"
                  onInput={(e: Event) => { tts.rate = parseFloat((e.target as HTMLInputElement).value) }}
                />
                <button
                  type="button"
                  class="settings-field__button"
                  style="padding: 2px 8px; font-size: 11px;"
                  onClick={() => { tts.rate = 1.0 }}
                >
                  1.0x
                </button>
              </div>
            </div>

            {/* Pitch */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Voice Pitch ({(tts.pitch ?? 1.0).toFixed(2)})</span>
                <span class="settings-row__hint">Speech frequency tuning</span>
              </div>
              <div class="settings-row__control" style="display: flex; align-items: center; gap: 10px; width: 220px;">
                <input
                  type="range"
                  min="0.8"
                  max="1.3"
                  step="0.05"
                  value={tts.pitch ?? 1.0}
                  style="flex: 1;"
                  onInput={(e: Event) => { tts.pitch = parseFloat((e.target as HTMLInputElement).value) }}
                />
                <button
                  type="button"
                  class="settings-field__button"
                  style="padding: 2px 8px; font-size: 11px;"
                  onClick={() => { tts.pitch = 1.0 }}
                >
                  Reset
                </button>
              </div>
            </div>

            {/* Test Voice Button */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Test Voice</span>
                <span class="settings-row__hint">Hear EVA-01 speak with current settings</span>
              </div>
              <div class="settings-row__control">
                <button
                  type="button"
                  class="settings-field__button"
                  onClick={() => this.testSpeechOutput()}
                >
                  <span class="settings-field__button-icon">record_voice_over</span>
                  Test Voice Output
                </button>
              </div>
            </div>
          </div>

          {/* ElevenLabs settings */}
          {tts.provider === 'elevenlabs' && (
            <div style="margin-top: 12px;">
              <label class="settings-field">
                <span class="settings-field__label">ElevenLabs API Key</span>
                <input type="password" class="settings-field__input" value={tts.apiKey}
                  placeholder="Enter ElevenLabs API key..."
                  onInput={(e: Event) => { tts.apiKey = (e.target as HTMLInputElement).value }} />
              </label>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <label class="settings-field">
                  <span class="settings-field__label">Voice ID</span>
                  <input type="text" class="settings-field__input" value={tts.voiceId}
                    placeholder="e.g. JBFqnCBsd6RMkjVDRZzb"
                    onInput={(e: Event) => { tts.voiceId = (e.target as HTMLInputElement).value }} />
                </label>
                <label class="settings-field">
                  <span class="settings-field__label">Model</span>
                  <input type="text" class="settings-field__input" value={tts.model}
                    placeholder="e.g. eleven_flash_v2_5"
                    onInput={(e: Event) => { tts.model = (e.target as HTMLInputElement).value }} />
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Reset */}
        <button class="settings-reset-btn" onClick={async () => {
          this.resetting = true
          try {
            const u1 = await api.settings.resetSection.mutate({ section: 'tts' })
            this.$emit('update', 'tts', u1.tts)
            const u2 = await api.settings.resetSection.mutate({ section: 'stt' })
            this.$emit('update', 'stt', u2.stt)
          } finally { this.resetting = false }
        }} disabled={this.resetting}>
          <span class="settings-reset-btn__icon">restart_alt</span>
          {this.resetting ? 'Resetting…' : 'Reset Voice to Defaults'}
        </button>
      </div>
    )
  },
})
