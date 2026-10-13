import { defineComponent, ref, computed, type PropType, onMounted, onBeforeUnmount } from 'vue'
import type { AppConfig } from '@/composables/useSettings'
import { api } from '@/api'
import { useSounds } from '@/composables/useSounds'
import { useTTS, playWebSpeech } from '@/composables/useTTS'
import CustomSelect, { type SelectOption } from '../components/CustomSelect'

const kokoroVoiceOptions: SelectOption[] = [
  {
    value: 'af_heart',
    label: 'af_heart (Samantha - Warm & Expressive)',
    sublabel: 'Neural Local (Recommended)',
    icon: 'favorite',
    iconBg: 'linear-gradient(135deg, #f43f5e, #be123c)',
    iconColor: '#fff',
  },
  {
    value: 'af_sarah',
    label: 'af_sarah (Natural US Female)',
    sublabel: 'Neural Local',
    icon: 'female',
    iconBg: 'linear-gradient(135deg, #06b6d4, #0e7490)',
    iconColor: '#fff',
  },
  {
    value: 'af_bella',
    label: 'af_bella (Energetic US Female)',
    sublabel: 'Neural Local',
    icon: 'auto_awesome',
    iconBg: 'linear-gradient(135deg, #f59e0b, #b45309)',
    iconColor: '#fff',
  },
  {
    value: 'af_nicole',
    label: 'af_nicole (Crisp US Female)',
    sublabel: 'Neural Local',
    icon: 'mic',
    iconBg: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
    iconColor: '#fff',
  },
  {
    value: 'am_adam',
    label: 'am_adam (Conversational US Male)',
    sublabel: 'Neural Local',
    icon: 'male',
    iconBg: 'linear-gradient(135deg, #6366f1, #4338ca)',
    iconColor: '#fff',
  },
  {
    value: 'am_michael',
    label: 'am_michael (Deep Calm US Male)',
    sublabel: 'Neural Local',
    icon: 'sound_detection_loud_sound',
    iconBg: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
    iconColor: '#fff',
  },
  {
    value: 'bf_emma',
    label: 'bf_emma (British Female)',
    sublabel: 'Neural Local',
    icon: 'public',
    iconBg: 'linear-gradient(135deg, #10b981, #047857)',
    iconColor: '#fff',
  },
  {
    value: 'bm_george',
    label: 'bm_george (British Male)',
    sublabel: 'Neural Local',
    icon: 'travel_explore',
    iconBg: 'linear-gradient(135deg, #0ea5e9, #0369a1)',
    iconColor: '#fff',
  },
]

const sttModelOptions: SelectOption[] = [
  {
    value: 'onnx-community/moonshine-tiny-ONNX',
    label: 'Moonshine Tiny',
    sublabel: 'Fast Edge Model (ONNX)',
    icon: 'bolt',
    iconBg: 'linear-gradient(135deg, #f59e0b, #d97706)',
    iconColor: '#fff',
  },
  {
    value: 'Xenova/whisper-base.en',
    label: 'Whisper Base',
    sublabel: 'Balanced Speed & Accuracy',
    icon: 'neurology',
    iconBg: 'linear-gradient(135deg, #10b981, #059669)',
    iconColor: '#fff',
  },
  {
    value: 'Xenova/whisper-small.en',
    label: 'Whisper Small',
    sublabel: 'High Precision / Complex',
    icon: 'precision_manufacturing',
    iconBg: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
    iconColor: '#fff',
  },
  {
    value: 'Xenova/whisper-tiny.en',
    label: 'Whisper Tiny',
    sublabel: 'Lightweight / Low RAM',
    icon: 'speed',
    iconBg: 'linear-gradient(135deg, #06b6d4, #0891b2)',
    iconColor: '#fff',
  },
  {
    value: 'groq-whisper',
    label: 'Groq Cloud Whisper',
    sublabel: 'Ultra-Fast ~90ms LPU',
    icon: 'rocket_launch',
    iconBg: 'linear-gradient(135deg, #f97316, #ea580c)',
    iconColor: '#fff',
  },
  {
    value: 'faster-whisper',
    label: 'Faster-Whisper Server',
    sublabel: 'Local GPU / Port 8080',
    icon: 'dns',
    iconBg: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
    iconColor: '#fff',
  },
  {
    value: 'handy',
    label: 'Handy Integration',
    sublabel: 'cjpais/Handy Desktop App',
    icon: 'desktop_windows',
    iconBg: 'linear-gradient(135deg, #6366f1, #4338ca)',
    iconColor: '#fff',
  },
]

const ttsEngineOptions: SelectOption[] = [
  {
    value: 'kokoro',
    label: 'Kokoro TTS (Local Neural Voice)',
    sublabel: '100% Free & Offline (82M)',
    icon: 'spatial_audio',
    iconBg: 'linear-gradient(135deg, #10b981, #059669)',
    iconColor: '#fff',
  },
  {
    value: 'web-speech',
    label: 'Web Speech (System Voice / Samantha)',
    sublabel: 'OS Native Zero Latency',
    icon: 'record_voice_over',
    iconBg: 'linear-gradient(135deg, #06b6d4, #0891b2)',
    iconColor: '#fff',
  },
  {
    value: 'elevenlabs',
    label: 'ElevenLabs (High-Fidelity Cloud)',
    sublabel: 'API Key Required',
    icon: 'auto_awesome',
    iconBg: 'linear-gradient(135deg, #a855f7, #7e22ce)',
    iconColor: '#fff',
  },
  {
    value: 'google-translate',
    label: 'Google Voice (Multi-Accent)',
    sublabel: 'Zero Key Cloud',
    icon: 'language',
    iconBg: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
    iconColor: '#fff',
  },
  {
    value: 'yandex-alice',
    label: 'Yandex Alice (Russian Voice)',
    sublabel: 'Free Cloud',
    icon: 'translate',
    iconBg: 'linear-gradient(135deg, #ef4444, #dc2626)',
    iconColor: '#fff',
  },
  {
    value: 'auto',
    label: 'Auto-Detect (System Recommended)',
    sublabel: 'Optimal PC Match',
    icon: 'magic_button',
    iconBg: 'linear-gradient(135deg, #f59e0b, #d97706)',
    iconColor: '#fff',
  },
]

export default defineComponent({
  name: 'VoiceTab',

  props: {
    config: { type: Object as PropType<AppConfig>, required: true },
  },

  emits: ['update'],

  setup(props, { emit }) {
    const { playTest, setSpeakerId } = useSounds()

    // Model management (Wake / Vosk)
    const modelStatus = ref<{ downloaded: boolean; path: string }>({ downloaded: false, path: '' })
    const downloadingWake = ref(false)
    const downloadWakeProgress = ref(0)
    const downloadWakeError = ref('')
    const languages = ref<{ code: string; label: string }[]>([])

    // Audio Devices
    const micDevices = ref<{ value: string; label: string }[]>([])
    const speakerDevices = ref<{ value: string; label: string }[]>([])
    const testingMic = ref(false)
    const micLevel = ref(0)
    let micStream: MediaStream | null = null
    let micAudioCtx: AudioContext | null = null
    let micAnimFrame: number | null = null

    // System Voices for Web Speech
    const systemVoices = ref<SelectOption[]>([])

    function loadSystemVoices() {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const voices = window.speechSynthesis.getVoices()
        systemVoices.value = [
          {
            value: '',
            label: 'Default System Voice',
            sublabel: 'Auto Selected',
            icon: 'desktop_windows',
            iconBg: 'linear-gradient(135deg, #64748b, #475569)',
            iconColor: '#fff',
          },
          ...voices.map((v) => {
            const isSamantha = v.name.toLowerCase().includes('samantha')
            return {
              value: v.name,
              label: v.name,
              sublabel: v.lang,
              icon: isSamantha ? 'favorite' : 'record_voice_over',
              iconBg: isSamantha
                ? 'linear-gradient(135deg, #f43f5e, #be123c)'
                : 'linear-gradient(135deg, #0284c7, #0369a1)',
              iconColor: '#fff',
            }
          }),
        ]
      }
    }

    // In-App STT Whisper download & status
    const downloadingInApp = ref(false)
    const inAppProgress = ref(0)
    const inAppStatusDetail = ref('')
    const inAppStatus = ref<{ ok?: boolean; message?: string } | null>(null)
    const inAppDownloaded = ref(false)

    // Groq Cloud Whisper Models & Status
    const groqModels = ref<string[]>([
      'whisper-large-v3-turbo',
      'whisper-large-v3',
      'distil-whisper-large-v3-en',
    ])
    const fetchingGroq = ref(false)
    const groqStatus = ref<{ ok?: boolean; message?: string } | null>(null)
    const isLiveGroq = ref(false)

    async function fetchGroqModels(autoSelect = false) {
      const key = props.config.stt.groqApiKey || ''
      if (!key.trim()) {
        groqStatus.value = { ok: false, message: 'Please enter a valid Groq API key first.' }
        return
      }
      fetchingGroq.value = true
      groqStatus.value = { message: 'Connecting to Groq API...' }
      try {
        const res = await api.settings.fetchGroqModels.mutate({ apiKey: key.trim() })
        if (res.ok && res.whisperModels && res.whisperModels.length > 0) {
          groqModels.value = res.whisperModels
          isLiveGroq.value = !!res.isLive
          groqStatus.value = {
            ok: true,
            message: `Connected! Found ${res.whisperModels.length} Groq Whisper model(s)`,
          }
          if (autoSelect || !props.config.stt.whisperModel || !res.whisperModels.includes(props.config.stt.whisperModel)) {
            const selectedModel = res.whisperModels[0] || 'whisper-large-v3-turbo'
            emit('update', 'stt', { ...props.config.stt, whisperModel: selectedModel })
          }
        } else if ('error' in res && (res as any).error) {
          groqStatus.value = { ok: false, message: String((res as any).error) }
        } else {
          groqStatus.value = { ok: true, message: 'Default Groq Whisper models ready' }
        }
      } catch (err: any) {
        groqStatus.value = { ok: false, message: err?.message || 'Failed to connect to Groq' }
      } finally {
        fetchingGroq.value = false
      }
    }

    const groqModelOptions = computed((): SelectOption[] => {
      return groqModels.value.map((m) => {
        const isTurbo = m.includes('turbo')
        const isDistil = m.includes('distil')
        return {
          value: m,
          label: m,
          sublabel: isTurbo
            ? 'Ultra-Fast ~90ms LPU (Recommended)'
            : isDistil
            ? 'Distilled English'
            : 'Cloud High-Precision',
          icon: isTurbo ? 'bolt' : isDistil ? 'speed' : 'rocket_launch',
          iconBg: isTurbo
            ? 'linear-gradient(135deg, #f59e0b, #d97706)'
            : 'linear-gradient(135deg, #f97316, #ea580c)',
          iconColor: '#fff',
        }
      })
    })

    // Kokoro TTS download & status
    const downloadingKokoro = ref(false)
    const kokoroProgress = ref(0)
    const kokoroStatusDetail = ref('')
    const kokoroDownloaded = ref(false)
    const speechPreviewNotice = ref('')

    async function checkOfflineModelStatuses() {
      try {
        const kRes = await api.audio.getKokoroStatus.query()
        kokoroDownloaded.value = !!kRes.downloaded
      } catch (err) {
        console.warn('Failed to query Kokoro status:', err)
      }
      try {
        const targetModel = props.config.stt.inAppWhisperModel || 'Xenova/whisper-base.en'
        const sRes = await api.audio.getInAppSTTStatus.query({ model: targetModel })
        inAppDownloaded.value = !!sRes.downloaded
        if (sRes.downloaded) {
          inAppStatus.value = { ok: true, message: 'Ready on disk' }
        }
      } catch (err) {
        console.warn('Failed to query in-app STT status:', err)
      }
    }

    async function testOrDownloadInAppModel(targetModel?: string) {
      const model = targetModel || props.config.stt.inAppWhisperModel || 'Xenova/whisper-base.en'
      if (model.includes('groq') || model.includes('faster') || model.includes('handy')) return

      downloadingInApp.value = true
      inAppProgress.value = 5
      inAppStatusDetail.value = `Starting download for ${model.replace('Xenova/', '')}...`
      inAppStatus.value = null

      try {
        const res = await api.audio.testWhisper.mutate({
          endpoint: 'in-app',
          model: model,
        })
        inAppStatus.value = res as { ok?: boolean; message?: string }
        if (res.ok) {
          inAppDownloaded.value = true
          inAppProgress.value = 100
          inAppStatusDetail.value = 'Model Ready & Verified'
        } else {
          inAppStatusDetail.value = res.error || 'Verification Failed'
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        inAppStatus.value = { ok: false, message: msg }
        inAppStatusDetail.value = msg
      } finally {
        downloadingInApp.value = false
      }
    }

    async function startKokoroDownload() {
      downloadingKokoro.value = true
      kokoroProgress.value = 5
      kokoroStatusDetail.value = 'Connecting to Hugging Face...'
      try {
        const res = await api.audio.downloadKokoroModel.mutate()
        if (res.ok) {
          kokoroDownloaded.value = true
          kokoroProgress.value = 100
          kokoroStatusDetail.value = 'Kokoro 82M Ready & Cached'
        } else {
          kokoroStatusDetail.value = res.error || 'Download failed'
        }
      } catch (err: unknown) {
        kokoroStatusDetail.value = (err as Error)?.message || 'Download failed'
      } finally {
        downloadingKokoro.value = false
      }
    }

    async function cancelKokoro() {
      try {
        await api.audio.cancelKokoroDownload.mutate()
      } catch (err) {
        console.warn('Failed to cancel Kokoro:', err)
      }
      downloadingKokoro.value = false
      kokoroStatusDetail.value = 'Download cancelled'
    }

    async function cancelInAppSTT() {
      try {
        await api.audio.cancelInAppSTTDownload.mutate()
      } catch (err) {
        console.warn('Failed to cancel In-App STT:', err)
      }
      downloadingInApp.value = false
      inAppStatusDetail.value = 'Download cancelled'
    }

    // Kokoro TTS testing & status
    const testingKokoro = ref(false)
    const kokoroStatus = ref<{ ok?: boolean; message?: string } | null>(null)

    async function testKokoroVoice() {
      if (!kokoroDownloaded.value) {
        kokoroStatus.value = { ok: false, message: 'Kokoro model is not downloaded yet. Please download it first.' }
        return
      }
      testingKokoro.value = true
      kokoroStatus.value = { message: 'Synthesizing voice test with Kokoro...' }
      try {
        await api.audio.speak.mutate({
          text: 'EVA-01 speech synthesis online. All systems synchronized and operational.',
        })
        kokoroStatus.value = { ok: true, message: 'Speech playback started successfully' }
      } catch (err: any) {
        kokoroStatus.value = { ok: false, message: err?.message || 'Failed to synthesize speech' }
      } finally {
        testingKokoro.value = false
      }
    }

    const wakeLanguageOptions = computed((): SelectOption[] => {
      return [...languages.value]
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((l) => ({
          value: l.code,
          label: l.label,
          downloaded: l.code === props.config.stt.language ? modelStatus.value.downloaded : undefined,
        }))
    })

    async function loadAudioDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const mics = devices
          .filter((d) => d.kind === 'audioinput')
          .map((d, index) => ({
            value: d.deviceId,
            label: d.label || `Microphone ${index + 1}`,
          }))
        micDevices.value = [{ value: '', label: 'Default System Microphone' }, ...mics]

        const speakers = devices
          .filter((d) => d.kind === 'audiooutput')
          .map((d, index) => ({
            value: d.deviceId,
            label: d.label || `Speaker / Output ${index + 1}`,
          }))
        speakerDevices.value = [{ value: '', label: 'Default System Speaker' }, ...speakers]
      } catch (err) {
        console.warn('Failed to enumerate audio devices:', err)
      }
    }

    async function downloadWakeModel() {
      downloadingWake.value = true
      downloadWakeError.value = ''
      downloadWakeProgress.value = 0
      try {
        await api.audio.downloadSTTModel.mutate({ language: props.config.stt.language })
        modelStatus.value.downloaded = true
      } catch (err: unknown) {
        downloadWakeError.value = (err as Error).message || 'Download failed'
      } finally {
        downloadingWake.value = false
      }
    }

    async function refreshWakeModelStatus() {
      try {
        const status = await api.audio.getSTTModelStatus.query({ language: props.config.stt.language })
        modelStatus.value = status as { downloaded: boolean; path: string }
      } catch (err) {
        console.error('Failed to refresh Wake model status:', err)
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

      checkOfflineModelStatuses()

      if (props.config.stt.provider === 'groq-whisper' && props.config.stt.groqApiKey) {
        fetchGroqModels(false)
      }

      api.audio.onSTTModelStatus.subscribe(undefined, {
        onData(data: { downloaded: boolean; progress?: number; error?: string }) {
          if (data.downloaded) {
            modelStatus.value.downloaded = true
            downloadingWake.value = false
            downloadWakeProgress.value = 100
          }
          if (data.error) {
            downloadWakeError.value = data.error
            downloadingWake.value = false
          }
        },
      })

      api.audio.onInAppModelProgress.subscribe(undefined, {
        onData(data: any) {
          if (data.type === 'tts' || (data.model && String(data.model).toLowerCase().includes('kokoro'))) {
            downloadingKokoro.value = data.status !== 'ready' && data.status !== 'error' && data.status !== 'cancelled'
            if (data.progress !== undefined) kokoroProgress.value = data.progress
            if (data.file || data.status) kokoroStatusDetail.value = data.file || data.status || ''
            if (data.status === 'ready' || data.progress === 100) {
              kokoroDownloaded.value = true
              downloadingKokoro.value = false
              kokoroProgress.value = 100
              kokoroStatusDetail.value = 'Kokoro 82M Ready & Cached'
            } else if (data.status === 'error' || data.status === 'cancelled') {
              downloadingKokoro.value = false
            }
          } else {
            downloadingInApp.value = data.status !== 'done' && data.status !== 'error' && data.status !== 'cancelled'
            if (data.progress !== undefined) inAppProgress.value = data.progress
            if (data.file || data.status) inAppStatusDetail.value = data.file || data.status || ''
            if (data.status === 'done' || data.progress === 100) {
              inAppDownloaded.value = true
              downloadingInApp.value = false
              inAppProgress.value = 100
              inAppStatus.value = { ok: true, message: 'Model Ready' }
            } else if (data.status === 'error' || data.status === 'cancelled') {
              downloadingInApp.value = false
            }
          }
        },
      })
    })

    const recordingMicHotkey = ref(false)
    let recordingMicHandler: ((e: KeyboardEvent) => void) | null = null

    function stopRecordingMicHotkey() {
      if (recordingMicHandler) {
        window.removeEventListener('keydown', recordingMicHandler, true)
        recordingMicHandler = null
      }
      recordingMicHotkey.value = false
    }

    function startRecordingMicHotkey() {
      stopRecordingMicHotkey()
      recordingMicHotkey.value = true

      function handler(e: KeyboardEvent) {
        e.preventDefault()
        e.stopPropagation()
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return

        const parts: string[] = []
        if (e.ctrlKey) parts.push('Ctrl')
        if (e.altKey) parts.push('Alt')
        if (e.shiftKey) parts.push('Shift')
        if (e.metaKey) parts.push('Meta')

        let key = e.key
        if (key === ' ') key = 'Space'
        else if (key.length === 1) key = key.toUpperCase()
        parts.push(key)

        const shortcut = parts.join('+')
        stopRecordingMicHotkey()

        const nextStt = { ...props.config.stt, micHotkey: shortcut }
        emit('update', 'stt', nextStt)
        /* auto-saved via emit */
      }

      recordingMicHandler = handler
      window.addEventListener('keydown', handler, true)
    }

    onBeforeUnmount(() => {
      stopMicTest()
      stopRecordingMicHotkey()
    })

    async function toggleMicTest() {
      if (testingMic.value) {
        stopMicTest()
        return
      }
      testingMic.value = true
      try {
        const constraints: Record<string, unknown> = {
          audio: props.config.stt.micDeviceId ? { deviceId: { exact: props.config.stt.micDeviceId } } : true,
        }
        micStream = await navigator.mediaDevices.getUserMedia(constraints)
        micAudioCtx = new AudioContext()
        const source = micAudioCtx.createMediaStreamSource(micStream)
        const analyser = micAudioCtx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        const data = new Uint8Array(analyser.frequencyBinCount)

        const updateMeter = () => {
          if (!testingMic.value) return
          analyser.getByteFrequencyData(data)
          let sum = 0
          for (let i = 0; i < data.length; i++) sum += data[i]
          const avg = sum / data.length
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

    const { speaking: isSpeaking, stop: stopAudio } = useTTS()

    function testSpeechOutput() {
      const tts = props.config.tts
      if (isSpeaking.value) {
        stopAudio()
        return
      }
      speechPreviewNotice.value = ''

      if (tts.provider === 'kokoro' && !kokoroDownloaded.value) {
        speechPreviewNotice.value = 'Kokoro model is not downloaded yet. Please click "Download Model" below first.'
        return
      }

      if (tts.provider === 'web-speech') {
        playWebSpeech('EVA-01 speech synthesis online. All systems operational.', {
          voice: tts.voiceId,
          rate: tts.rate ?? 1.0,
          pitch: tts.pitch ?? 1.0,
        })
      } else {
        api.audio.speak.mutate({
          text: 'EVA-01 speech synthesis online. All systems operational.',
        }).catch((err) => {
          console.error('[VoiceTab] speech synthesis error:', err)
        })
      }
    }

    return {
      isSpeaking,
      stopAudio,
      modelStatus,
      downloadingWake,
      downloadWakeProgress,
      downloadWakeError,
      wakeLanguageOptions,
      downloadWakeModel,
      refreshWakeModelStatus,
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
      downloadingInApp,
      inAppProgress,
      inAppStatusDetail,
      inAppStatus,
      inAppDownloaded,
      testOrDownloadInAppModel,
      cancelInAppSTT,
      downloadingKokoro,
      kokoroProgress,
      kokoroStatusDetail,
      kokoroDownloaded,
      startKokoroDownload,
      cancelKokoro,
      testingKokoro,
      kokoroStatus,
      testKokoroVoice,
      speechPreviewNotice,
      groqModels,
      fetchingGroq,
      groqStatus,
      isLiveGroq,
      fetchGroqModels,
      groqModelOptions,
    }
  },

  render() {
    const tts = this.config.tts
    const stt = this.config.stt

    // Resolve current in-app model selection or mapped provider
    const currentSTTModel =
      stt.provider === 'groq-whisper'
        ? 'groq-whisper'
        : stt.provider === 'faster-whisper'
        ? 'faster-whisper'
        : stt.provider === 'handy'
        ? 'handy'
        : stt.inAppWhisperModel || 'Xenova/whisper-base.en'

    function handleSTTModelChange(val: string) {
      if (val === 'groq-whisper') {
        stt.provider = 'groq-whisper'
        if (!stt.whisperModel) stt.whisperModel = 'whisper-large-v3-turbo'
      } else if (val === 'faster-whisper') {
        stt.provider = 'faster-whisper'
      } else if (val === 'handy') {
        stt.provider = 'handy'
      } else {
        stt.inAppWhisperModel = val
        if (stt.provider !== 'hybrid') {
          stt.provider = 'in-app-whisper'
        }
      }
    }

    return (
      <div class="settings-tab">
        <h2 class="settings-tab__title">Voice & Audio</h2>
        <p class="settings-tab__subtitle">Audio hardware, speech recognition models, and text-to-speech</p>

        {/* --- 1. Audio Devices (Microphone & Speaker) --- */}
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
                <div style="flex: 1; height: 8px; background: rgba(255,255,255,0.08); border-radius: 4px; overflow: hidden;">
                  <div style={{
                    width: `${this.micLevel}%`,
                    height: '100%',
                    background: this.micLevel > 70 ? '#34d399' : '#38bdf8',
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

            {/* Mic Shortcut */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Mic Shortcut</span>
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
                    {this.recordingMicHotkey ? 'Press keys...' : 'Change'}
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

        {/* --- 2. Speech-to-Text Architecture --- */}
        <div class="settings-section">
          <div class="settings-section__title">Speech-to-Text Architecture</div>
          <div class="settings-section__card">
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Enable Speech-to-Text</span>
                <span class="settings-row__hint">Voice input recognition</span>
              </div>
              <div class="settings-row__control">
                <input
                  type="checkbox"
                  class="settings-field__toggle"
                  checked={stt.enabled}
                  onChange={(e: Event) => { stt.enabled = (e.target as HTMLInputElement).checked }}
                />
              </div>
            </div>

            {/* Wake Word Input */}
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Wake Word</span>
                <span class="settings-row__hint">Phrase spoken to activate listening</span>
              </div>
              <div class="settings-row__control" style="min-width: 220px;">
                <input
                  type="text"
                  class="settings-field__input"
                  value={stt.wakeWord || 'eva-01'}
                  placeholder="e.g. eva-01, eva, jarvis"
                  onInput={(e: Event) => { stt.wakeWord = (e.target as HTMLInputElement).value }}
                />
              </div>
            </div>

            {/* Dual Model Pipeline Block */}
            <div class="ios-pipeline-block">
              <div class="ios-pipeline-header">
                <div class="ios-pipeline-header__title">Speech Recognition Pipeline</div>
                <div class="ios-pipeline-header__desc">Acoustic wake detection paired with local or cloud speech recognition</div>
              </div>

              <div class="ios-pipeline-grid">
                {/* Left Card: Wake Word Acoustic Model */}
                <div class="ios-model-card">
                  <div class="ios-model-card__header">
                    <span class="ios-model-card__tag">Wake Detection</span>
                    <span class={['ios-model-card__status', this.modelStatus.downloaded && 'ios-model-card__status--ready']}>
                      {this.modelStatus.downloaded ? 'Ready' : (this.downloadingWake ? `${this.downloadWakeProgress}%` : 'Not Downloaded')}
                    </span>
                  </div>
                  <CustomSelect
                    modelValue={stt.language || 'en'}
                    onUpdate:modelValue={(v: string) => { stt.language = v; this.refreshWakeModelStatus() }}
                    options={this.wakeLanguageOptions}
                  />
                  {!this.modelStatus.downloaded ? (
                    this.downloadingWake ? (
                      <div class="ios-progress-bar">
                        <div class="ios-progress-bar__fill" style={{ width: `${this.downloadWakeProgress}%` }} />
                      </div>
                    ) : (
                      <button
                        type="button"
                        class="ios-download-btn"
                        onClick={this.downloadWakeModel}
                      >
                        <span class="custom-select__download-icon" style="font-size: 14px;">download</span>
                        Download Wake Model
                      </button>
                    )
                  ) : (
                    <div class="ios-model-card__caption">
                      Installed in local app storage
                    </div>
                  )}
                </div>

                {/* Connecting Plus Badge */}
                <div class="ios-pipeline-connector">
                  <div class="ios-pipeline-plus">+</div>
                </div>

                {/* Right Card: In-App STT Model */}
                <div class="ios-model-card">
                  <div class="ios-model-card__header">
                    <span class="ios-model-card__tag">Speech Model</span>
                    <span class={['ios-model-card__status', this.inAppStatus?.ok && 'ios-model-card__status--ready']}>
                      {this.downloadingInApp ? `Downloading ${this.inAppProgress}%` : (this.inAppStatus?.ok ? 'Ready' : 'Local ONNX')}
                    </span>
                  </div>
                  <CustomSelect
                    modelValue={currentSTTModel}
                    onUpdate:modelValue={(v: string) => {
                      handleSTTModelChange(v)
                      if (!v.includes('groq') && !v.includes('faster') && !v.includes('handy')) {
                        this.testOrDownloadInAppModel(v)
                      }
                    }}
                    options={sttModelOptions}
                  />

                  {this.downloadingInApp ? (
                    <div class="ios-model-download-box">
                      <div class="ios-model-download-info">
                        <span class="ios-model-download-text">{this.inAppStatusDetail || 'Downloading ONNX weights...'}</span>
                        <div style="display: flex; align-items: center; gap: 6px;">
                          <span class="ios-model-download-pct">{this.inAppProgress}%</span>
                          <button
                            type="button"
                            class="ios-cancel-btn"
                            onClick={() => this.cancelInAppSTT()}
                            title="Cancel download"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                      <div class="ios-progress-bar">
                        <div class="ios-progress-bar__fill" style={{ width: `${Math.max(5, this.inAppProgress)}%` }} />
                      </div>
                      <div class="ios-model-download-target">
                        Destination: local app cache (~/.cache/huggingface/hub)
                      </div>
                    </div>
                  ) : (
                    !currentSTTModel.includes('groq') && !currentSTTModel.includes('faster') && !currentSTTModel.includes('handy') ? (
                      <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
                        <button
                          type="button"
                          class="ios-download-btn"
                          onClick={() => this.testOrDownloadInAppModel(stt.inAppWhisperModel || 'Xenova/whisper-base.en')}
                        >
                          <span class="custom-select__download-icon" style="font-size: 14px;">
                            {this.inAppStatus?.ok ? 'verified' : 'download'}
                          </span>
                          {this.inAppStatus?.ok ? 'Verify / Reload Model' : 'Download Model'}
                        </button>
                        <div class="ios-model-card__caption">
                          {this.inAppStatusDetail || 'Destination: local app cache (~/.cache/huggingface/hub)'}
                        </div>
                      </div>
                    ) : (
                      <div class="ios-model-card__caption">
                        {currentSTTModel.includes('groq') ? 'Cloud LPU ~90ms' : (currentSTTModel.includes('faster') ? 'Local GPU server' : 'Handy v0.9.7 offline')}
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>

            {/* Groq Cloud Whisper Settings */}
            {stt.provider === 'groq-whisper' && (
              <div style="margin-top: 14px; padding: 14px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 10px; display: flex; flex-direction: column; gap: 12px;">
                <div style="display: flex; gap: 8px; align-items: flex-end;">
                  <div style="flex: 1;">
                    <label class="settings-field" style="margin-bottom: 0;">
                      <span class="settings-field__label">Groq API Key (Free)</span>
                      <input
                        type="password"
                        class="settings-field__input"
                        value={stt.groqApiKey || ''}
                        placeholder="gsk_..."
                        onInput={(e: Event) => {
                          stt.groqApiKey = (e.target as HTMLInputElement).value
                        }}
                        onChange={() => {
                          if (stt.groqApiKey) this.fetchGroqModels(false)
                        }}
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    class="settings-field__button"
                    style="margin-bottom: 2px; height: 38px; white-space: nowrap;"
                    disabled={this.fetchingGroq || !stt.groqApiKey}
                    onClick={() => this.fetchGroqModels(false)}
                  >
                    <span class="settings-field__button-icon">
                      {this.fetchingGroq ? 'sync' : 'refresh'}
                    </span>
                    {this.fetchingGroq ? 'Fetching...' : 'Fetch Models'}
                  </button>
                </div>

                {/* Groq Model Selector */}
                <div>
                  <label class="settings-field" style="margin-bottom: 0;">
                    <span class="settings-field__label">Groq Whisper Model</span>
                    <CustomSelect
                      modelValue={stt.whisperModel || 'whisper-large-v3-turbo'}
                      onUpdate:modelValue={(v: string) => { stt.whisperModel = v }}
                      options={this.groqModelOptions}
                    />
                    <span class="settings-field__hint">
                      Select cloud transcription model running on Groq LPUs. `whisper-large-v3-turbo` achieves ~90ms latency.
                    </span>
                  </label>
                </div>

                {/* Groq Status Feedback */}
                {this.groqStatus && (
                  <div style={{
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    color: this.groqStatus.ok ? '#34d399' : (this.groqStatus.ok === false ? '#f87171' : '#94a3b8'),
                  }}>
                    <span class="custom-select__download-icon" style="font-size: 14px;">
                      {this.groqStatus.ok ? 'check_circle' : (this.groqStatus.ok === false ? 'error' : 'hourglass_top')}
                    </span>
                    <span>{this.groqStatus.message}</span>
                  </div>
                )}

                <span class="settings-field__hint" style="margin-top: 0;">
                  Get a free API key at <a href="https://console.groq.com/keys" target="_blank" style="color: #38bdf8; text-decoration: underline;">console.groq.com</a>. Free tier includes ultra-fast cloud Whisper transcription.
                </span>
              </div>
            )}

            {/* Faster-Whisper Server Endpoint */}
            {stt.provider === 'faster-whisper' && (
              <div style="margin-top: 10px;">
                <label class="settings-field">
                  <span class="settings-field__label">Faster-Whisper Server Endpoint</span>
                  <input
                    type="text"
                    class="settings-field__input"
                    value={stt.whisperEndpoint || 'http://localhost:8080/v1'}
                    placeholder="http://localhost:8080/v1"
                    onInput={(e: Event) => { stt.whisperEndpoint = (e.target as HTMLInputElement).value }}
                  />
                  <span class="settings-field__hint">
                    Points to local GPU faster-whisper-server (port 8080).
                  </span>
                </label>
              </div>
            )}

            {/* Handy Integration Endpoint */}
            {stt.provider === 'handy' && (
              <div style="margin-top: 10px;">
                <label class="settings-field">
                  <span class="settings-field__label">Handy Server Endpoint</span>
                  <input
                    type="text"
                    class="settings-field__input"
                    value={stt.handyEndpoint || 'http://localhost:8000/v1'}
                    placeholder="http://localhost:8000/v1"
                    onInput={(e: Event) => { stt.handyEndpoint = (e.target as HTMLInputElement).value }}
                  />
                  <span class="settings-field__hint">
                    Connects to <a href="https://github.com/cjpais/Handy/releases/tag/v0.9.7" target="_blank" style="color: #38bdf8; text-decoration: underline;">Handy v0.9.7</a> offline transcription service.
                  </span>
                </label>
              </div>
            )}
          </div>
        </div>

        {/* --- 3. Text-to-Speech Architecture --- */}
        <div class="settings-section">
          <div class="settings-section__title">Text-to-Speech</div>
          <div class="settings-section__card">
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">Enable TTS</span>
                <span class="settings-row__hint">Voice output for agent responses</span>
              </div>
              <div class="settings-row__control">
                <input
                  type="checkbox"
                  class="settings-field__toggle"
                  checked={tts.enabled}
                  onChange={(e: Event) => { tts.enabled = (e.target as HTMLInputElement).checked }}
                />
              </div>
            </div>

            {/* Dual TTS Pipeline Block */}
            <div class="ios-pipeline-block">
              <div class="ios-pipeline-header">
                <div class="ios-pipeline-header__title">Voice Synthesis & Character</div>
                <div class="ios-pipeline-header__desc">Select speech synthesis engine paired with your character voice</div>
              </div>

              <div class="ios-pipeline-grid">
                {/* Left Card: TTS Engine Provider */}
                <div class="ios-model-card">
                  <div class="ios-model-card__header">
                    <span class="ios-model-card__tag">Synthesis Engine</span>
                    <span class={['ios-model-card__status', (tts.provider !== 'kokoro' || this.kokoroDownloaded) && 'ios-model-card__status--ready']}>
                      {tts.provider === 'kokoro'
                        ? (this.downloadingKokoro ? `Downloading ${this.kokoroProgress}%` : (this.kokoroDownloaded ? '✓ Ready (350MB)' : 'Not Downloaded'))
                        : (tts.provider === 'web-speech' ? 'System Native' : 'Active')}
                    </span>
                  </div>
                  <CustomSelect
                    modelValue={tts.provider || 'kokoro'}
                    onUpdate:modelValue={(v: string) => { tts.provider = v }}
                    options={ttsEngineOptions}
                  />

                  {tts.provider === 'kokoro' && (
                    this.downloadingKokoro ? (
                      <div class="ios-model-download-box">
                        <div class="ios-model-download-info">
                          <span class="ios-model-download-text">{this.kokoroStatusDetail || 'Downloading Kokoro 82M weights...'}</span>
                          <div style="display: flex; align-items: center; gap: 6px;">
                            <span class="ios-model-download-pct">{this.kokoroProgress}%</span>
                            <button
                              type="button"
                              class="ios-cancel-btn"
                              onClick={() => this.cancelKokoro()}
                              title="Cancel download"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                        <div class="ios-progress-bar">
                          <div class="ios-progress-bar__fill" style={{ width: `${Math.max(5, this.kokoroProgress)}%`, background: '#10b981' }} />
                        </div>
                        <div class="ios-model-download-target">
                          Destination: local app cache (~/.cache/huggingface/hub)
                        </div>
                      </div>
                    ) : (
                      !this.kokoroDownloaded ? (
                        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
                          <button
                            type="button"
                            class="ios-download-btn"
                            onClick={() => this.startKokoroDownload()}
                          >
                            <span class="custom-select__download-icon" style="font-size: 14px;">download</span>
                            Download Model (350 MB)
                          </button>
                          <div class="ios-model-card__caption">
                            {this.kokoroStatusDetail || 'Kokoro 82M offline weights required (~350 MB)'}
                          </div>
                        </div>
                      ) : (
                        <div class="ios-model-card__caption" style="color: #34d399;">
                          ✓ Model Installed • ~/.cache/huggingface/hub
                        </div>
                      )
                    )
                  )}
                  {tts.provider !== 'kokoro' && (
                    <div class="ios-model-card__caption">
                      {tts.provider === 'web-speech' ? 'Zero latency system voice' : 'Cloud synthesized'}
                    </div>
                  )}
                </div>

                {/* Connecting Plus Badge */}
                <div class="ios-pipeline-connector">
                  <div class="ios-pipeline-plus">+</div>
                </div>

                {/* Right Card: Voice Character / Model */}
                <div class="ios-model-card">
                  <div class="ios-model-card__header">
                    <span class="ios-model-card__tag">Voice Character</span>
                    <span class="ios-model-card__status ios-model-card__status--ready">
                      {tts.provider === 'kokoro' ? (tts.kokoroVoice || 'af_heart') : 'Selected'}
                    </span>
                  </div>

                  {/* Kokoro Voices */}
                  {tts.provider === 'kokoro' && (
                    <CustomSelect
                      modelValue={tts.kokoroVoice || 'af_heart'}
                      onUpdate:modelValue={(v: string) => { tts.kokoroVoice = v }}
                      options={kokoroVoiceOptions}
                    />
                  )}

                  {/* Web Speech System Voices */}
                  {tts.provider === 'web-speech' && (
                    <CustomSelect
                      modelValue={tts.voiceId || ''}
                      onUpdate:modelValue={(v: string) => { tts.voiceId = v }}
                      options={this.systemVoices}
                    />
                  )}

                  {/* ElevenLabs / Other Voice input fallback */}
                  {tts.provider !== 'kokoro' && tts.provider !== 'web-speech' && (
                    <input
                      type="text"
                      class="settings-field__input"
                      style="height: 34px; font-size: 13px;"
                      value={tts.voiceId || 'Default Voice'}
                      placeholder="Voice ID or name..."
                      onInput={(e: Event) => { tts.voiceId = (e.target as HTMLInputElement).value }}
                    />
                  )}

                  <div class="ios-model-card__caption">
                    {tts.provider === 'kokoro' ? '24kHz natural neural audio' : (tts.provider === 'web-speech' ? 'Samantha & OS voices' : 'Custom voice persona')}
                  </div>
                </div>
              </div>

              {/* Dedicated Voice Preview & Action Row */}
              <div class="ios-voice-preview-bar">
                <button
                  type="button"
                  class={['ios-voice-preview-btn', this.isSpeaking && 'ios-voice-preview-btn--active']}
                  onClick={() => this.testSpeechOutput()}
                >
                  <span class="custom-select__download-icon" style="font-size: 16px;">
                    {this.isSpeaking ? 'stop' : 'volume_up'}
                  </span>
                  <span>{this.isSpeaking ? 'Stop Audio' : 'Play Voice Preview'}</span>
                </button>
                <span class="ios-voice-preview-hint" style={{ color: this.speechPreviewNotice ? '#f59e0b' : undefined }}>
                  {this.speechPreviewNotice || (this.isSpeaking ? 'Playing sample audio...' : 'Tests speech with current engine & voice')}
                </span>
              </div>
            </div>

            {/* ElevenLabs API Key field */}
            {tts.provider === 'elevenlabs' && (
              <div style="margin-top: 10px;">
                <label class="settings-field">
                  <span class="settings-field__label">ElevenLabs API Key</span>
                  <input
                    type="password"
                    class="settings-field__input"
                    value={tts.apiKey || ''}
                    placeholder="Enter ElevenLabs API key..."
                    onInput={(e: Event) => { tts.apiKey = (e.target as HTMLInputElement).value }}
                  />
                </label>
              </div>
            )}

            {/* Speech Rate & Pitch sliders - Clean Apple Inset Rows */}
            <div class="ios-sliders-panel">
              <div class="ios-slider-row">
                <div class="ios-slider-row__header">
                  <span class="ios-slider-row__label">Speech Rate</span>
                  <span class="ios-slider-row__value">{Number(tts.rate ?? 1.0).toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  class="ios-slider-input"
                  min="0.8"
                  max="1.4"
                  step="0.05"
                  value={tts.rate ?? 1.0}
                  onInput={(e: Event) => { tts.rate = parseFloat((e.target as HTMLInputElement).value) }}
                />
              </div>

              <div class="ios-slider-row">
                <div class="ios-slider-row__header">
                  <span class="ios-slider-row__label">Voice Pitch</span>
                  <span class="ios-slider-row__value">{Number(tts.pitch ?? 1.0).toFixed(2)}x</span>
                </div>
                <input
                  type="range"
                  class="ios-slider-input"
                  min="0.8"
                  max="1.2"
                  step="0.05"
                  value={tts.pitch ?? 1.0}
                  onInput={(e: Event) => { tts.pitch = parseFloat((e.target as HTMLInputElement).value) }}
                />
              </div>
            </div>

          </div>
        </div>
      </div>
    )
  },
})
