import { defineComponent, ref, type PropType, onMounted } from 'vue'
import type { AppConfig } from '@/composables/useSettings'
import { api } from '@/api'

/**
 * STTTab — speech-to-text settings: enable/disable, language, model download.
 */
export default defineComponent({
  name: 'STTTab',

  props: {
    config: {
      type: Object as PropType<AppConfig>,
      required: true,
    },
  },

  emits: ['update'],

  setup(props) {
    const modelStatus = ref<{ downloaded: boolean; path: string }>({ downloaded: false, path: '' })
    const downloading = ref(false)
    const downloadProgress = ref(0)
    const downloadError = ref('')
    const languages = ref<{ code: string; label: string }[]>([])

    onMounted(async () => {
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

      // Subscribe to model download progress
      api.audio.onSTTModelStatus.subscribe(undefined, {
        onData(data: { downloaded: boolean; progress?: number; error?: string }) {
          if (data.downloaded) {
            modelStatus.value.downloaded = true
            downloading.value = false
            downloadProgress.value = 100
          }
          if (data.progress !== undefined) {
            downloadProgress.value = data.progress
          }
          if (data.error) {
            downloadError.value = data.error
            downloading.value = false
          }
        },
      })
    })

    async function downloadModel() {
      downloading.value = true
      downloadError.value = ''
      downloadProgress.value = 0
      try {
        await api.audio.downloadSTTModel.mutate({ language: props.config.stt.language })
        modelStatus.value.downloaded = true
      } catch (err: any) {
        downloadError.value = err.message || 'Download failed'
      } finally {
        downloading.value = false
      }
    }

    return {
      modelStatus,
      downloading,
      downloadProgress,
      downloadError,
      languages,
      downloadModel,
    }
  },

  render() {
    const stt = this.config.stt

    return (
      <div class="settings-tab">
        <h3 class="settings-tab__title">Speech-to-Text</h3>

        <label class="settings-field settings-field--row">
          <span class="settings-field__label">Enable STT</span>
          <input
            type="checkbox"
            class="settings-field__toggle"
            checked={stt.enabled}
            onChange={(e: Event) => { stt.enabled = (e.target as HTMLInputElement).checked }}
          />
        </label>

        <label class="settings-field">
          <span class="settings-field__label">Language</span>
          <select
            class="settings-field__select"
            value={stt.language}
            onChange={(e: Event) => { stt.language = (e.target as HTMLSelectElement).value }}
          >
            {this.languages.map((lang) => (
              <option key={lang.code} value={lang.code}>{lang.label}</option>
            ))}
          </select>
        </label>

        {/* Model status */}
        <div class="settings-field">
          <span class="settings-field__label">Model</span>
          {this.modelStatus.downloaded ? (
            <span class="settings-field__hint" style="color: var(--color-success, #4ade80)">
              ✓ Downloaded
            </span>
          ) : (
            <span class="settings-field__hint" style="color: var(--color-warning, #fbbf24)">
              Not downloaded
            </span>
          )}
        </div>

        {/* Download button / progress */}
        {!this.modelStatus.downloaded && (
          <div class="settings-field">
            {this.downloading ? (
              <div class="stt-download-progress">
                <div
                  class="stt-download-progress__bar"
                  style={{ width: `${this.downloadProgress}%` }}
                />
                <span class="stt-download-progress__text">{this.downloadProgress}%</span>
              </div>
            ) : (
              <button
                class="settings-footer__save"
                onClick={this.downloadModel}
              >
                Download Model (~50 MB)
              </button>
            )}
          </div>
        )}

        {this.downloadError && (
          <div class="settings-field" style="color: var(--color-error, #f87171)">
            {this.downloadError}
          </div>
        )}
      </div>
    )
  },
})
