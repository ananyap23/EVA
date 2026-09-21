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
    const localStatus = ref<{ ok?: boolean; message?: string; models?: string[]; visionModels?: string[] } | null>(null)
    const ollamaDiagnostics = ref<{
      activeModel: string | null
      vramUsedMB: number
      vramTotalMB: number
      queueLength: number
      tokensPerSecond: number
    } | null>(null)
    
    const geminiModels = ref<string[]>([
      'gemini-3.1-flash-lite-preview',
      'gemini-3-flash',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
    ])
    const isLiveGemini = ref(false)
    const fetchingGemini = ref(false)
    const geminiError = ref('')

    async function fetchGeminiModels(autoSelectLatest = true) {
      if (!props.config.llm.apiKey) return
      fetchingGemini.value = true
      geminiError.value = ''
      try {
        const res = await api.settings.fetchGeminiModels.mutate({ apiKey: props.config.llm.apiKey })
        if (res.models && res.models.length > 0) {
          geminiModels.value = res.models
          isLiveGemini.value = !!res.isLive

          // Automatically select the latest model if current model is outdated or not set
          const latestModel = res.models[0]
          const current = props.config.llm.textModel || ''
          const isOutdated = current.includes('1.5') || !res.models.includes(current)

          if (autoSelectLatest || isOutdated) {
            emit('update', 'llm', {
              ...props.config.llm,
              textModel: latestModel,
              visionModel: props.config.llm.separateVisionModel ? props.config.llm.visionModel : latestModel,
            })
          }
        }
        if ('error' in res && (res as any).error) {
          geminiError.value = (res as any).error
        }
      } catch (err: any) {
        geminiError.value = err?.message || 'Failed to fetch Gemini models'
      } finally {
        fetchingGemini.value = false
      }
    }

    onMounted(() => {
      if (props.config.llm.provider === 'gemini' && props.config.llm.apiKey) {
        fetchGeminiModels()
      }
      // Poll Ollama diagnostics every 5s when in Ollama mode
      if (props.config.llm.provider === 'ollama') {
        const pollDiag = async () => {
          try {
            const diag = await (api.settings as any).getOllamaDiagnostics.query()
            ollamaDiagnostics.value = diag
          } catch { /* Ollama may not be running yet */ }
        }
        pollDiag()
        setInterval(pollDiag, 5000)
      }
    })

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

    async function testConnection(targetUrl?: string) {
      testingLocal.value = true
      localStatus.value = null
      const urlToTest = targetUrl || props.config.llm.baseURL || 'http://127.0.0.1:11434/v1'
      try {
        const result = await api.settings.testLocalLLM.mutate({
          baseURL: urlToTest,
          apiKey: props.config.llm.apiKey,
        })
        if (result.ok) {
          const models = (result.models || []) as string[]
          localStatus.value = {
            ok: true,
            message: ('message' in result && result.message) ? String(result.message) : `Connected! Found ${models.length} local model(s)`,
            models,
          }
          const visionModels = ((result as any).visionModels as string[] | undefined) || []
          localStatus.value = {
            ok: true,
            message: localStatus.value?.message || '',
            models,
            visionModels,
          }

          if (models.length > 0) {
            const updated = { ...props.config.llm, baseURL: urlToTest }
            const isOllamaProvider = updated.provider === 'ollama'

            if (isOllamaProvider && visionModels.length > 0) {
              // Auto-pick first vision model if nothing suitable set
              const currentOllama = (updated as any).ollamaModel || updated.textModel || ''
              if (!visionModels.includes(currentOllama)) {
                const preferred = visionModels[0]
                ;(updated as any).ollamaModel = preferred
                updated.textModel = preferred
                updated.visionModel = preferred
                updated.classifierModel = preferred
              }
            } else if (isOllamaProvider) {
              const chatModel = models.find((m) => !/embed|nomic/i.test(m)) || models[0]
              if (!(updated as any).ollamaModel) (updated as any).ollamaModel = chatModel
              if (!updated.textModel) updated.textModel = chatModel
            } else {
              // Non-Ollama providers
              const chatModel = models.find((m) => !/embed|nomic|moondream|vision|vl|llava/i.test(m)) || models.find((m) => !/embed|nomic/i.test(m)) || models[0]
              if (!updated.textModel || /embed|nomic/i.test(updated.textModel) || !models.includes(updated.textModel)) {
                updated.textModel = chatModel
              }
              if (!updated.classifierModel) {
                updated.classifierModel = chatModel
              }
              const visionModel = models.find((m) => /vl|vision|llava|moondream|florence/i.test(m))
              if (visionModel) {
                if (updated.separateVisionModel) {
                  updated.visionModel = visionModel
                } else if (!updated.textModel || /embed|nomic/i.test(updated.textModel)) {
                  updated.textModel = visionModel
                }
              }
            }
            emit('update', 'llm', updated)
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
      testConnection(url)
    }

    function handleProviderChange(val: string) {
      const updated = { ...props.config.llm, provider: val }
      if (val === 'ollama' && (!updated.baseURL || updated.baseURL.includes('1234') || updated.baseURL.includes('8000'))) {
        updated.baseURL = 'http://127.0.0.1:11434/v1'
      } else if (val === 'lm-studio' && (!updated.baseURL || updated.baseURL.includes('11434') || updated.baseURL.includes('8000'))) {
        updated.baseURL = 'http://localhost:1234/v1'
      } else if (val === 'openai' && !updated.baseURL) {
        updated.baseURL = 'http://localhost:11434/v1'
      }
      emit('update', 'llm', updated)
    }

    return { geminiModels, fetchingGemini, isLiveGemini, geminiError, fetchGeminiModels, showAdvanced, resetting, testingLocal, localStatus, ollamaDiagnostics, gpuInfo, testConnection, setPreset, handleProviderChange }
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
              <span class="settings-field__button-icon" style="font-size: 18px; opacity: 0.85;">memory</span>
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
                    { value: 'gemini', label: 'Google Gemini (Cloud)' },
                    { value: 'ollama', label: 'Ollama (Local Port 11434)' },
                    { value: 'lm-studio', label: 'LM Studio (Local Port 1234)' },
                    { value: 'openai', label: 'Custom Local / OpenAI-Compatible' },
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
                      onClick={() => this.setPreset('http://127.0.0.1:11434/v1')}
                    >
                      Ollama (11434)
                    </button>
                    <button
                      type="button"
                      class="settings-field__button"
                      style={{ padding: '6px 12px', fontSize: '12px', opacity: llm.baseURL === 'http://localhost:1234/v1' ? '1' : '0.8' }}
                      onClick={() => this.setPreset('http://127.0.0.1:1234/v1')}
                    >
                      LM Studio (1234)
                    </button>
                    <button
                      type="button"
                      class="settings-field__button"
                      style={{ padding: '6px 12px', fontSize: '12px', opacity: llm.baseURL === 'http://localhost:8000/v1' ? '1' : '0.8' }}
                      onClick={() => this.setPreset('http://127.0.0.1:8000/v1')}
                    >
                      vLLM / llama.cpp (8000)
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
                        <span style="opacity: 0.8; margin-bottom: 4px; display: block;">
                          Select model:
                        </span>
                        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                          {this.localStatus.models.map((m) => {
                            const isActiveM = (llm as any).ollamaModel === m || llm.textModel === m
                            return (
                              <button
                                type="button"
                                key={m}
                                class="settings-field__button"
                                style={{
                                  padding: '3px 10px',
                                  fontSize: '11px',
                                  background: isActiveM ? 'oklch(0.3 0.15 240 / 0.6)' : undefined,
                                  borderColor: isActiveM ? 'oklch(0.5 0.15 240)' : undefined,
                                  color: isActiveM ? 'oklch(0.9 0.1 240)' : undefined,
                                }}
                                onClick={() => {
                                  ;(llm as any).ollamaModel = m
                                  llm.textModel = m
                                  llm.visionModel = m
                                  llm.classifierModel = m
                                }}
                              >
                                {m}
                              </button>
                            )
                          })}
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
                onInput={(e: Event) => {
                const val = (e.target as HTMLInputElement).value
                llm.apiKey = val
                if (llm.provider === 'gemini' && val.trim().length > 15) {
                  this.fetchGeminiModels(true)
                }
              }} />
            </label>
          </div>
        </div>

        {/* ── Ollama Live Diagnostics ── */}
        {llm.provider === 'ollama' && this.ollamaDiagnostics && (
          <div style={{
            margin: '0 0 16px 0',
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '12px',
            backgroundColor: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style="font-size: 11px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;">
              Ollama Telemetry
            </div>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
              <div style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 6px;">
                <div style="font-size: 10px; opacity: 0.6; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em;">Loaded Model</div>
                <div style="font-size: 11px; font-weight: 600; color: oklch(0.85 0.1 240); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  {this.ollamaDiagnostics.activeModel || 'None (Idle)'}
                </div>
              </div>
              <div style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 6px;">
                <div style="font-size: 10px; opacity: 0.6; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em;">VRAM Allocation</div>
                <div style="font-size: 11px; font-weight: 600;">
                  {this.ollamaDiagnostics.vramUsedMB > 0
                    ? `${this.ollamaDiagnostics.vramUsedMB} / ${this.ollamaDiagnostics.vramTotalMB} MB`
                    : '0 MB'}
                </div>
              </div>
              <div style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 6px;">
                <div style="font-size: 10px; opacity: 0.6; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em;">Queue Status</div>
                <div style="font-size: 11px; font-weight: 600;">
                  {this.ollamaDiagnostics.queueLength === 0 ? 'Ready' : `${this.ollamaDiagnostics.queueLength} waiting`}
                </div>
              </div>
              <div style="background: rgba(255,255,255,0.03); padding: 8px; border-radius: 6px;">
                <div style="font-size: 10px; opacity: 0.6; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em;">Speed</div>
                <div style="font-size: 11px; font-weight: 600; color: oklch(0.85 0.1 120);">
                  {this.ollamaDiagnostics.tokensPerSecond > 0
                    ? `${this.ollamaDiagnostics.tokensPerSecond.toFixed(1)} tok/s`
                    : '—'}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Model Selection ── */}
        <div class="settings-section">
          <div class="settings-section__title">Model Selection</div>
          
          <div class="settings-models-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <label class="settings-field" style="margin-bottom: 0;">
              <span class="settings-field__label">Primary Model</span>
              {llm.provider === 'gemini' ? (
                <CustomSelect
                  modelValue={llm.textModel}
                  onUpdate:modelValue={(v: string) => {
                    llm.textModel = v
                    llm.visionModel = v
                  }}
                  options={this.geminiModels.map(m => ({ value: m, label: m }))}
                />
              ) : (
                <div>
                  <datalist id="local-models-list">
                    {this.localStatus?.models?.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <input
                    type="text"
                    class="settings-field__input"
                    list="local-models-list"
                    value={llm.textModel}
                    placeholder="e.g. gemini-2.5-flash or llama3.2"
                    onInput={(e: Event) => {
                      const val = (e.target as HTMLInputElement).value
                      llm.textModel = val
                      llm.visionModel = val
                      if ((llm as any).ollamaModel !== undefined) {
                        ;(llm as any).ollamaModel = val
                      }
                    }}
                  />
                </div>
              )}
              <span style="font-size: 11px; opacity: 0.55; margin-top: 4px; display: block;">
                Unified model handles conversations, system commands, and screen vision
              </span>
            </label>

            <label class="settings-field" style="margin-bottom: 0;">
              <span class="settings-field__label">Classifier Model (Optional)</span>
              <input
                type="text"
                class="settings-field__input"
                list="local-models-list"
                value={llm.classifierModel}
                placeholder="Same as Primary Model"
                onInput={(e: Event) => { llm.classifierModel = (e.target as HTMLInputElement).value }}
              />
              <span style="font-size: 11px; opacity: 0.55; margin-top: 4px; display: block;">
                Fast intent classifier (defaults to Primary Model if blank)
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
