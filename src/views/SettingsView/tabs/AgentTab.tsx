import { defineComponent, ref, type PropType } from 'vue'
import type { AppConfig } from '@/composables/useSettings'
import { api } from '@/api'

/**
 * AgentTab — agent loop parameters.
 * Basic: Max Iterations, Max Consecutive Failures.
 * Advanced (collapsible): Delays, Context, Screenshots.
 */
export default defineComponent({
  name: 'AgentTab',

  props: {
    config: {
      type: Object as PropType<AppConfig>,
      required: true,
    },
  },

  emits: ['update'],

  setup(props, { emit }) {
    const showAdvanced = ref(false)
    const resetting = ref(false)

    return () => {
      // Safe fallback ensuring all properties exist
      const agent = props.config?.agent || {
        maxIterations: 15,
        maxConsecutiveFailures: 3,
        preActionDelay: 200,
        postActionDelay: 800,
        maxContextMessages: 40,
        commandTimeout: 30000,
        screenshotMaxWidth: 1280,
        screenshotQuality: 80,
      }

      return (
        <div class="settings-tab">
          <h2 class="settings-tab__title">Agent</h2>
          <p class="settings-tab__subtitle">Action loop and automation parameters</p>

          {/* Execution Section */}
          <div class="settings-section">
            <div class="settings-section__title">Execution</div>
            <div class="settings-section__card">
              <div class="settings-row">
                <div class="settings-row__info">
                  <span class="settings-row__label">Max Iterations</span>
                  <span class="settings-row__hint">Maximum actions per command • Default: 15</span>
                </div>
                <div class="settings-row__control">
                  <input
                    type="number"
                    class="settings-field__input"
                    style="width: 80px; text-align: center;"
                    value={agent.maxIterations ?? 15}
                    min="1"
                    max="100"
                    onInput={(e: Event) => {
                      agent.maxIterations = parseInt((e.target as HTMLInputElement).value) || 1
                      emit('update', 'agent', { ...agent })
                    }}
                  />
                </div>
              </div>

              <div class="settings-row">
                <div class="settings-row__info">
                  <span class="settings-row__label">Max Consecutive Failures</span>
                  <span class="settings-row__hint">Failures in a row before aborting • Default: 3</span>
                </div>
                <div class="settings-row__control">
                  <input
                    type="number"
                    class="settings-field__input"
                    style="width: 80px; text-align: center;"
                    value={agent.maxConsecutiveFailures ?? 3}
                    min="1"
                    max="20"
                    onInput={(e: Event) => {
                      agent.maxConsecutiveFailures = parseInt((e.target as HTMLInputElement).value) || 1
                      emit('update', 'agent', { ...agent })
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Advanced Collapsible */}
          <div class="settings-advanced">
            <button
              type="button"
              class="settings-advanced__toggle"
              onClick={() => {
                showAdvanced.value = !showAdvanced.value
              }}
            >
              <span class={['settings-advanced__chevron', showAdvanced.value && 'settings-advanced__chevron--open']}>
                expand_more
              </span>
              Advanced Settings
            </button>

            {showAdvanced.value && (
              <div class="settings-advanced__content">
                {/* Timing */}
                <div class="settings-section">
                  <div class="settings-section__title">Timing</div>

                  <label class="settings-field">
                    <span class="settings-field__label">Pre-Action Delay (ms)</span>
                    <span class="settings-field__hint">Cooldown before each action • Default: 200</span>
                    <input
                      type="number"
                      class="settings-field__input settings-field__input--short"
                      value={agent.preActionDelay ?? 200}
                      min="0"
                      max="5000"
                      step="50"
                      onInput={(e: Event) => {
                        agent.preActionDelay = parseInt((e.target as HTMLInputElement).value) || 0
                        emit('update', 'agent', { ...agent })
                      }}
                    />
                  </label>

                  <label class="settings-field">
                    <span class="settings-field__label">Post-Action Delay (ms)</span>
                    <span class="settings-field__hint">Wait after click before verification • Default: 800</span>
                    <input
                      type="number"
                      class="settings-field__input settings-field__input--short"
                      value={agent.postActionDelay ?? 800}
                      min="0"
                      max="5000"
                      step="50"
                      onInput={(e: Event) => {
                        agent.postActionDelay = parseInt((e.target as HTMLInputElement).value) || 0
                        emit('update', 'agent', { ...agent })
                      }}
                    />
                  </label>
                </div>

                {/* Context */}
                <div class="settings-section">
                  <div class="settings-section__title">Context & Limits</div>

                  <label class="settings-field">
                    <span class="settings-field__label">Max Context Messages</span>
                    <span class="settings-field__hint">Messages sent to LLM from history • Default: 40</span>
                    <input
                      type="number"
                      class="settings-field__input settings-field__input--short"
                      value={agent.maxContextMessages ?? 40}
                      min="1"
                      max="200"
                      onInput={(e: Event) => {
                        agent.maxContextMessages = parseInt((e.target as HTMLInputElement).value) || 1
                        emit('update', 'agent', { ...agent })
                      }}
                    />
                  </label>

                  <label class="settings-field">
                    <span class="settings-field__label">Command Timeout (ms)</span>
                    <span class="settings-field__hint">Max time for shell commands • Default: 30000</span>
                    <input
                      type="number"
                      class="settings-field__input settings-field__input--short"
                      value={agent.commandTimeout ?? 30000}
                      min="1000"
                      max="300000"
                      step="1000"
                      onInput={(e: Event) => {
                        agent.commandTimeout = parseInt((e.target as HTMLInputElement).value) || 1000
                        emit('update', 'agent', { ...agent })
                      }}
                    />
                  </label>
                </div>

                {/* Screenshots */}
                <div class="settings-section">
                  <div class="settings-section__title">Screenshots</div>

                  <label class="settings-field">
                    <span class="settings-field__label">Max Width (px)</span>
                    <span class="settings-field__hint">Resize for LLM (1280 = optimal) • Default: 1280</span>
                    <input
                      type="number"
                      class="settings-field__input settings-field__input--short"
                      value={agent.screenshotMaxWidth ?? 1280}
                      min="640"
                      max="3840"
                      step="64"
                      onInput={(e: Event) => {
                        agent.screenshotMaxWidth = parseInt((e.target as HTMLInputElement).value) || 640
                        emit('update', 'agent', { ...agent })
                      }}
                    />
                  </label>

                  <label class="settings-field">
                    <span class="settings-field__label">Quality</span>
                    <span class="settings-field__hint">JPEG quality (1–100) • Default: 80</span>
                    <div style="display: flex; align-items: center; gap: 12px;">
                      <input
                        type="range"
                        class="settings-field__range"
                        min="1"
                        max="100"
                        step="1"
                        value={agent.screenshotQuality ?? 80}
                        onInput={(e: Event) => {
                          agent.screenshotQuality = parseInt((e.target as HTMLInputElement).value) || 80
                          emit('update', 'agent', { ...agent })
                        }}
                      />
                      <span class="settings-field__value">{agent.screenshotQuality ?? 80}</span>
                    </div>
                  </label>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            class="settings-reset-btn"
            onClick={async () => {
              resetting.value = true
              try {
                const u = await api.settings.resetSection.mutate({ section: 'agent' })
                emit('update', 'agent', u.agent)
              } finally {
                resetting.value = false
              }
            }}
            disabled={resetting.value}
          >
            <span class="settings-reset-btn__icon">restart_alt</span>
            {resetting.value ? 'Resetting…' : 'Reset Agent to Defaults'}
          </button>
        </div>
      )
    }
  },
})
