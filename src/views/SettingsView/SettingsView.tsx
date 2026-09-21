import { defineComponent, ref, onMounted, type PropType } from 'vue'
import './SettingsView.css'
import { useSettings, type AppConfig } from '@/composables/useSettings'
import GeneralTab from './tabs/GeneralTab'
import LLMTab from './tabs/LLMTab'
import VoiceTab from './tabs/VoiceTab'
import AgentTab from './tabs/AgentTab'
import PersonasTab from './tabs/PersonasTab'
import AboutTab from './tabs/AboutTab'

type TabId = 'general' | 'intelligence' | 'voice' | 'agent' | 'personas' | 'about'

interface TabDef {
  id: TabId
  label: string
  icon: string
  gradient: string
  shadow: string
}

const TABS: TabDef[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'tune',
    gradient: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
    shadow: 'rgba(59, 130, 246, 0.45)',
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    icon: 'neurology',
    gradient: 'linear-gradient(135deg, #a855f7, #7e22ce)',
    shadow: 'rgba(168, 85, 247, 0.45)',
  },
  {
    id: 'voice',
    label: 'Voice & Audio',
    icon: 'graphic_eq',
    gradient: 'linear-gradient(135deg, #06b6d4, #0891b2)',
    shadow: 'rgba(6, 182, 212, 0.45)',
  },
  {
    id: 'agent',
    label: 'Agent & Tasks',
    icon: 'smart_toy',
    gradient: 'linear-gradient(135deg, #10b981, #059669)',
    shadow: 'rgba(16, 185, 129, 0.45)',
  },
  {
    id: 'personas',
    label: 'Personas',
    icon: 'badge',
    gradient: 'linear-gradient(135deg, #f59e0b, #d97706)',
    shadow: 'rgba(245, 158, 11, 0.45)',
  },
  {
    id: 'about',
    label: 'About EVA-01',
    icon: 'info',
    gradient: 'linear-gradient(135deg, #6366f1, #4338ca)',
    shadow: 'rgba(99, 102, 241, 0.45)',
  },
]

/**
 * SettingsView — full-page settings panel.
 * Full-page layout with sidebar navigation, 6 tabs.
 * Auto-saves on change (debounced 1000ms).
 */
export default defineComponent({
  name: 'SettingsView',

  props: {
    onClose: {
      type: Function as PropType<() => void>,
      required: true,
    },
  },

  setup(props) {
    const activeTab = ref<TabId>('general')

    const {
      config,
      loading,
      saving,
      saved,
      loadConfig,
    } = useSettings()

    onMounted(async () => {
      await loadConfig()
    })

    function onUpdate(key: keyof AppConfig, value: unknown) {
      ;(config as Record<string, unknown>)[key] = value
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        props.onClose()
      }
    }

    return () => (
      <div class="settings-page" onKeydown={onKeydown} tabindex="-1">
        {/* Sidebar */}
        <nav class="settings-nav">
          <button type="button" class="settings-nav__back" onClick={() => props.onClose()}>
            <span class="settings-nav__back-icon">arrow_back</span>
            <span>Settings</span>
          </button>

          <div class="settings-nav__tabs">
            {TABS.map((tab) => {
              const isActive = activeTab.value === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  class={[
                    'settings-nav__tab',
                    isActive && 'settings-nav__tab--active',
                  ]}
                  onClick={() => {
                    activeTab.value = tab.id
                  }}
                >
                  <span
                    class="settings-nav__tab-badge"
                    style={{
                      background: tab.gradient,
                      boxShadow: `0 2px 8px ${tab.shadow}`,
                    }}
                  >
                    <span class="settings-nav__tab-icon">{tab.icon}</span>
                  </span>
                  <span class="settings-nav__tab-label">{tab.label}</span>
                </button>
              )
            })}
          </div>

          {/* Footer: auto-save status */}
          <div class="settings-nav__footer">
            {loading.value && (
              <span class="settings-nav__status" style="color: oklch(0.6 0 0);">
                <span class="settings-nav__status-icon" style="animation: settings-spin 1s linear infinite;">sync</span>
                Loading…
              </span>
            )}
            {!loading.value && saving.value && (
              <span class="settings-nav__status settings-nav__status--saving">
                <span class="settings-nav__status-icon">sync</span>
                Saving…
              </span>
            )}
            {!loading.value && saved.value && (
              <span class="settings-nav__status settings-nav__status--saved">
                <span class="settings-nav__status-icon">check_circle</span>
                Saved
              </span>
            )}
          </div>
        </nav>

        {/* Content */}
        <main class="settings-main">
          {activeTab.value === 'general' && (
            <GeneralTab config={config} onUpdate={onUpdate} onClose={props.onClose} />
          )}
          {activeTab.value === 'intelligence' && (
            <LLMTab config={config} onUpdate={onUpdate} />
          )}
          {activeTab.value === 'voice' && (
            <VoiceTab config={config} onUpdate={onUpdate} />
          )}
          {activeTab.value === 'agent' && (
            <AgentTab config={config} onUpdate={onUpdate} />
          )}
          {activeTab.value === 'personas' && (
            <PersonasTab />
          )}
          {activeTab.value === 'about' && (
            <AboutTab onClose={props.onClose} />
          )}
        </main>
      </div>
    )
  },
})
