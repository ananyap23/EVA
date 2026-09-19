import { defineComponent, ref, onMounted, type PropType } from 'vue'
import type { AppConfig } from '@/composables/useSettings'
import { api } from '@/api'
import CustomSelect from '../components/CustomSelect'

/**
 * LLMTab — Intelligence settings.
 *
 * Basic: Provider, API Key, Models (compact grid).
 * Advanced (collapsible): Generation Parameters.
 */
export default defineComponent({
  name: 'LLMTab',

  props: {
    config: { type: Object as PropType<AppConfig>, required: true },
  },

  emits: ['update'],

  setup(props, { emit }) {
    const showAdvanced = ref(false)
    const resetting = ref(false)
    const testingLocal = ref(false)
    const localStatus = ref<{ ok?: boolean; message?: string; models?: string[] } | null>(null)
    const gpuInfo = ref<{
      activeGPU: string
      vramTotalMB: number
      isAccelerated: boolean
      recommendedLocalLLM: string
    } | null>(null)

    onMounted(async () => {
      try {
        const info = await api.system.getGPUInfo.query()
        gpuInfo.value = info
      } catch (err) {
        console.warn('Failed to query GPU info:', err)
      }
    })

    async function testConnection() {
      testingLocal.value = true
      localStatus.value = null
      try {
        const result = await api.settings.testLocalLLM.mutate({
          baseURL: props.config.llm.baseURL,
          apiKey: props.config.llm.apiKey,
        })
        if (result.ok) {
          localStatus.value = {
            ok: true,
            message: `Connected! Found ${result.models.length} local model(s)`,
            models: result.models,
          }
          if (result.models.length > 0 && !props.config.llm.textModel) {
            emit('update', 'llm', { ...props.config.llm, textModel: result.models[0] })
          }
        } else {
          localStatus.value = {
            ok: false,
            message: ('error' in result ? (result.error as string) : undefined) || 'Connection failed',
          }
        }
      } catch (err: unknown) {
        localStatus.value = {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        }
      } finally {
        testingLocal.value = false
      }
    }

    function setPreset(url: string) {
      emit('update', 'llm', { ...props.config.llm, baseURL: url })
      localStatus.value = null
    }

    function handleProviderChange(val: string) {
      const updated = { ...props.config.llm, provider: val }
      if (val === 'ollama' && (!updated.baseURL || updated.baseURL.includes('1234') || updated.baseURL.includes('8000'))) {
        updated.baseURL = 'http://localhost:11434/v1'
      } else if (val === 'lm-studio' && (!updated.baseURL || updated.baseURL.includes('11434') || updated.baseURL.includes('8000'))) {
        updated.baseURL = 'http://localhost:1234/v1'
      } else if (val === 'openai' && !updated.baseURL) {
        updated.baseURL = 'http://localhost:11434/v1'
      }
      emit('update', 'llm', updated)
    }

    return { showAdvanced, resetting, testingLocal, localStatus, gpuInfo, testConnection, setPreset, handleProviderChange }
  },

  render() {
    const llm = this.config.llm
    const gen = this.config.generation
    const isLocalProvider = llm.provider === 'ollama' || llm.provider === 'lm-studio' || llm.provider === 'openai'

    return (
      <div class="settings-tab">
        <h2 class="settings-tab__title">Intelligence & Local Models</h2>
        <p class="settings-tab__subtitle">AI provider, GPU acceleration, and local model runner configuration</p>

        {/* ── GPU Acceleration Status ── */}
        {this.gpuInfo && (
          <div style={{
            margin: '0 0 16px 0',
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '12px',
            backgroundColor: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.07)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}>
            <div style="display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 20px;">⚡</span>
              <div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span style="font-weight: 600; font-size: 13px;">
                    {this.gpuInfo.activeGPU}
                  </span>
                  {this.gpuInfo.vramTotalMB > 0 && (
                    <span style="opacity: 0.8; font-size: 11px; background: rgba(255,255,255,0.08); padding: 1px 6px; border-radius: 4px;">
                      {Math.round(this.gpuInfo.vramTotalMB / 1024)}GB VRAM
                    </span>
                  )}
                </div>
                <span style="opacity: 0.65; font-size: 11px; display: block; margin-top: 2px;">
                  {this.gpuInfo.recommendedLocalLLM}
                </span>
              </div>
            </div>
            <span style={{
              fontSize: '11px',
              padding: '3px 8px',
              borderRadius: '4px',
              backgroundColor: this.gpuInfo.isAccelerated ? 'oklch(0.3 0.1 140 / 0.4)' : 'rgba(255,255,255,0.08)',
              color: this.gpuInfo.isAccelerated ? 'oklch(0.85 0.15 140)' : 'inherit',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}>
              {this.gpuInfo.isAccelerated ? 'GPU Accelerated' : 'CPU Mode'}
            </span>
          </div>
        )}

        {/* ── Provider ── */}
        <div class="settings-section">
          <div class="settings-section__title">Provider</div>
          <div class="settings-section__card">
            <div class="settings-row">
              <div class="settings-row__info">
                <span class="settings-row__label">AI Provider</span>
                <span class="settings-row__hint">Choose local model runner or cloud service</span>
              </div>
              <div class="settings-row__control" style="min-width: 260px;">
                <CustomSelect
                  modelValue={llm.provider}
                  onUpdate:modelValue={(v: string) => this.handleProviderChange(v)}
                  options={[
                    { value: 'ollama', label: '🦙 Ollama (Local AI · Port 11434)' },
                    { value: 'lm-studio', label: '🧪 LM Studio (Local AI · Port 1234)' },
                    { value: 'openai', label: '💻 Custom Local / OpenAI-Compatible' },
                    { value: 'gemini', label: '✨ Google Gemini (Cloud)' },
                  ]}
                />
              </div>
            </div>
          </div>

          <div style="margin-top: 12px;">
            {isLocalProvider && (
              <div>
                <div style="margin-bottom: 8px;">
                  <span class="settings-field__label" style="display: block; margin-bottom: 6px;">Local LLM Quick Presets</span>
                  <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    <button
                      type="button"
                      class="settings-field__button"
                      style={{ padding: '6px 12px', fontSize: '12px', opacity: llm.baseURL === 'http://localhost:11434/v1' ? '1' : '0.8' }}
                      onClick={() => this.setPreset('http://localhost:11434/v1')}
                    >
                      🦙 Ollama (11434)
                    </button>
                    <button
                      type="button"
                      class="settings-field__button"
                      style={{ padding: '6px 12px', fontSize: '12px', opacity: llm.baseURL === 'http://localhost:1234/v1' ? '1' : '0.8' }}
                      onClick={() => this.setPreset('http://localhost:1234/v1')}
                    >
                      🧪 LM Studio (1234)
                    </button>
                    <button
                      type="button"
                      class="settings-field__button"
                      style={{ padding: '6px 12px', fontSize: '12px', opacity: llm.baseURL === 'http://localhost:8000/v1' ? '1' : '0.8' }}
                      onClick={() => this.setPreset('http://localhost:8000/v1')}
                    >
                      ⚡ vLLM / llama.cpp (8000)
                    </button>
                  </div>
                </div>

                <label class="settings-field">
                  <span class="settings-field__label">Base URL</span>
                  <span class="settings-field__hint">API endpoint · e.g. http://localhost:11434/v1 or http://localhost:1234/v1</span>
                  <div style="display: flex; gap: 8px; align-items: center;">
                    <input type="text" class="settings-field__input" value={llm.baseURL}
                      style="flex: 1;"
                      placeholder="http://localhost:11434/v1"
                      onInput={(e: Event) => { llm.baseURL = (e.target as HTMLInputElement).value }} />
                    <button
                      type="button"
                      class="settings-field__button"
                      style="white-space: nowrap;"
                      onClick={() => this.testConnection()}
                      disabled={this.testingLocal}
                    >
                      <span class="settings-field__button-icon">sensors</span>
                      {this.testingLocal ? 'Connecting…' : 'Test & Fetch Models'}
                    </button>
                  </div>
                </label>

                {this.localStatus && (
                  <div style={{
                    marginTop: '8px',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    fontSize: '12px',
                    backgroundColor: this.localStatus.ok ? 'oklch(0.3 0.08 140 / 0.3)' : 'oklch(0.3 0.1 25 / 0.3)',
                    color: this.localStatus.ok ? 'oklch(0.85 0.15 140)' : 'oklch(0.85 0.15 25)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}>
                    <div style="display: flex; align-items: center; gap: 6px;">
                      <span>{this.localStatus.ok ? '✓' : '⚠'}</span>
                      <span>{this.localStatus.message}</span>
                    </div>
                    {this.localStatus.models && this.localStatus.models.length > 0 && (
                      <div style="margin-top: 6px;">
                        <span style="opacity: 0.8; margin-bottom: 4px; display: block;">Quick-select model:</span>
                        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                          {this.localStatus.models.map((m) => (
                            <button
                              type="button"
                              key={m}
                              class="settings-field__button"
                              style={{ padding: '2px 8px', fontSize: '11px' }}
                              onClick={() => {
                                if (llm.separateVisionModel && /vision|llava|vl|moondream|florence/i.test(m)) {
                                  llm.visionModel = m
                                } else {
                                  llm.textModel = m
                                  if (!llm.separateVisionModel) llm.visionModel = m
                                  if (!llm.classifierModel) llm.classifierModel = m
                                }
                              }}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <label class="settings-field">
              <span class="settings-field__label">API Key</span>
              <input type="password" class="settings-field__input" value={llm.apiKey}
                placeholder={isLocalProvider ? 'Optional for local models (leave blank for Ollama / LM Studio)...' : 'Enter your Gemini API key...'}
                onInput={(e: Event) => { llm.apiKey = (e.target as HTMLInputElement).value }} />
            </label>
          </div>
        </div>

        {/* ── Models (Text & Vision Routing) ── */}
        <div class="settings-section">
          <div class="settings-section__title">Models & Vision Routing</div>

          {/* Toggle for Separate Vision Model */}
          <div style={{
            margin: '0 0 14px 0',
            padding: '12px 14px',
            borderRadius: '8px',
            backgroundColor: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}>
            <label style="display: flex; align-items: flex-start; gap: 12px; cursor: pointer;">
              <input
                type="checkbox"
                class="settings-field__toggle"
                style="margin-top: 2px;"
                checked={Boolean(llm.separateVisionModel)}
                onChange={(e: Event) => {
                  llm.separateVisionModel = (e.target as HTMLInputElement).checked
                }}
              />
              <div style="flex: 1;">
                <span style="font-weight: 600; font-size: 13px; display: block; color: var(--color-text, #fff);">
                  Use a separate Vision Model for desktop screenshots & screen analysis
                </span>
                <span style="font-size: 11px; opacity: 0.7; display: block; margin-top: 2px; line-height: 1.4;">
                  {llm.separateVisionModel
                    ? '✨ Split Mode: Text queries & actions go to your Text Model, while desktop screenshots are sent to your dedicated Vision Model (e.g. llama3.2-vision, llava, or qwen2.5-vl).'
                    : '⚡ Unified Mode: Your Text Model handles both text prompts and desktop screenshots (ideal if you are running a single multimodal model or text-only commands).'}
                </span>
              </div>
            </label>
          </div>

          <div class="settings-models-grid" style={{ display: 'grid', gridTemplateColumns: llm.separateVisionModel ? '1fr 1fr 1fr' : '1fr 1fr', gap: '12px' }}>
            <label class="settings-field" style="margin-bottom: 0;">
              <span class="settings-field__label">{llm.separateVisionModel ? '💬 Text Model (Chat & Commands)' : '💬 Primary Model (Text & Vision)'}</span>
              <input type="text" class="settings-field__input" value={llm.textModel}
                placeholder={isLocalProvider ? 'e.g. llama3.2, mistral, or qwen2.5-coder' : 'e.g. gemini-3.1-flash-lite-preview'}
                onInput={(e: Event) => { llm.textModel = (e.target as HTMLInputElement).value }} />
              <span style="font-size: 11px; opacity: 0.55; margin-top: 4px; display: block;">
                {llm.separateVisionModel ? 'Conversations, shell execution, & intent analysis' : 'Multimodal model handles both conversations and screen vision'}
              </span>
            </label>

            {llm.separateVisionModel && (
              <label class="settings-field" style="margin-bottom: 0;">
                <span class="settings-field__label">👁️ Vision Model (Screen Analysis)</span>
                <input type="text" class="settings-field__input" value={llm.visionModel}
                  placeholder={isLocalProvider ? 'e.g. llama3.2-vision, llava, or qwen2.5-vl' : 'e.g. gemini-2.5-flash'}
                  onInput={(e: Event) => { llm.visionModel = (e.target as HTMLInputElement).value }} />
                <span style="font-size: 11px; opacity: 0.55; margin-top: 4px; display: block;">
                  Receives desktop screenshots when visual perception is required
                </span>
              </label>
            )}

            <label class="settings-field" style="margin-bottom: 0;">
              <span class="settings-field__label">🏷️ Classifier Model (Optional)</span>
              <input type="text" class="settings-field__input" value={llm.classifierModel}
                placeholder="Same as Text"
                onInput={(e: Event) => { llm.classifierModel = (e.target as HTMLInputElement).value }} />
              <span style="font-size: 11px; opacity: 0.55; margin-top: 4px; display: block;">
                Fast intent classifier (defaults to Text Model if blank)
              </span>
            </label>
          </div>
        </div>

        {/* ── Advanced: Generation ── */}
        <div class="settings-advanced">
          <button class="settings-advanced__toggle"
            onClick={() => { this.showAdvanced = !this.showAdvanced }}>
            <span class={['settings-advanced__chevron', this.showAdvanced && 'settings-advanced__chevron--open']}>expand_more</span>
            Generation Parameters
          </button>

          {this.showAdvanced && (
            <div class="settings-advanced__content">
              <label class="settings-field">
                <span class="settings-field__label">Chat Temperature</span>
                <div style="display: flex; align-items: center; gap: 12px;">
                  <input type="range" class="settings-field__range" min="0" max="2" step="0.1"
                    value={gen.chatTemperature}
                    onInput={(e: Event) => { gen.chatTemperature = parseFloat((e.target as HTMLInputElement).value) }} />
                  <span class="settings-field__value">{gen.chatTemperature}</span>
                </div>
              </label>
              <label class="settings-field">
                <span class="settings-field__label">Chat Top P</span>
                <div style="display: flex; align-items: center; gap: 12px;">
                  <input type="range" class="settings-field__range" min="0" max="1" step="0.05"
                    value={gen.chatTopP}
                    onInput={(e: Event) => { gen.chatTopP = parseFloat((e.target as HTMLInputElement).value) }} />
                  <span class="settings-field__value">{gen.chatTopP}</span>
                </div>
              </label>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <label class="settings-field">
                  <span class="settings-field__label">Top K</span>
                  <input type="number" class="settings-field__input" value={gen.chatTopK} min="1"
                    onInput={(e: Event) => { gen.chatTopK = parseInt((e.target as HTMLInputElement).value) || 1 }} />
                </label>
                <label class="settings-field">
                  <span class="settings-field__label">Max Tokens</span>
                  <input type="number" class="settings-field__input" value={gen.chatMaxTokens} min="1"
                    onInput={(e: Event) => { gen.chatMaxTokens = parseInt((e.target as HTMLInputElement).value) || 1 }} />
                </label>
              </div>
              <label class="settings-field">
                <span class="settings-field__label">Vision Temperature</span>
                <div style="display: flex; align-items: center; gap: 12px;">
                  <input type="range" class="settings-field__range" min="0" max="2" step="0.1"
                    value={gen.visionTemperature}
                    onInput={(e: Event) => { gen.visionTemperature = parseFloat((e.target as HTMLInputElement).value) }} />
                  <span class="settings-field__value">{gen.visionTemperature}</span>
                </div>
              </label>
              <label class="settings-field">
                <span class="settings-field__label">Vision Max Tokens</span>
                <input type="number" class="settings-field__input settings-field__input--short" value={gen.visionMaxTokens} min="1"
                  onInput={(e: Event) => { gen.visionMaxTokens = parseInt((e.target as HTMLInputElement).value) || 1 }} />
              </label>
            </div>
          )}
        </div>
        <button class="settings-reset-btn" onClick={async () => {
          this.resetting = true
          try {
            const u1 = await api.settings.resetSection.mutate({ section: 'llm' })
            this.$emit('update', 'llm', u1.llm)
            const u2 = await api.settings.resetSection.mutate({ section: 'generation' })
            this.$emit('update', 'generation', u2.generation)
          } finally { this.resetting = false }
        }} disabled={this.resetting}>
          <span class="settings-reset-btn__icon">restart_alt</span>
          {this.resetting ? 'Resetting…' : 'Reset Intelligence to Defaults'}
        </button>
      </div>
    )
  },
})
