import { defineComponent, ref, onMounted, type PropType } from 'vue'
import { api } from '@/api'
import logoUrl from '@/assets/icon.png'

/**
 * AboutTab — centered hero with logo, version info, runtime details, and links.
 */
export default defineComponent({
  name: 'AboutTab',

  props: {
    onClose: {
      type: Function as PropType<() => void>,
      required: true,
    },
  },

  setup(props) {
    const info = ref<{ version: string; name: string; electron: string; chrome: string; node: string } | null>(null)

    onMounted(async () => {
      try {
        info.value = await api.settings.getAppVersion.query()
      } catch (err) {
        console.error('[AboutTab] Failed to load app info:', err)
      }
    })

    function openExternal(url: string) {
      props.onClose()
      api.system.openExternal.mutate({ url })
    }

    return () => (
      <div class="about-page">
        {/* Hero section */}
        <div class="about-page__hero">
          <img class="about-page__logo" src={logoUrl} alt="EVA-01" />
          <div class="about-page__name">EVA-01</div>
          <div class="about-page__version">v{info.value?.version ?? '0.2.3'}</div>
          <div class="about-page__tagline">Autonomous AI Desktop Agent</div>

          {/* Runtime pills inline */}
          <div class="about-page__runtime">
            <span class="about-page__runtime-pill">
              Electron {info.value?.electron ?? '34.x'}
            </span>
            <span class="about-page__runtime-pill">
              Chromium {info.value?.chrome ?? '132.x'}
            </span>
            <span class="about-page__runtime-pill">
              Node {info.value?.node ?? '20.x'}
            </span>
          </div>
        </div>

        {/* Links row */}
        <div class="about-page__links">
          <button class="about-page__link" onClick={() => openExternal('https://github.com/dortanes/atlas')}>
            <span class="about-page__link-icon">code</span>
            Source Code
          </button>
          <button class="about-page__link" onClick={() => openExternal('https://github.com/dortanes/atlas/issues')}>
            <span class="about-page__link-icon">bug_report</span>
            Report Bug
          </button>
          <button class="about-page__link" onClick={() => openExternal('https://github.com/dortanes/atlas/releases')}>
            <span class="about-page__link-icon">new_releases</span>
            Releases
          </button>
        </div>
      </div>
    )
  },
})
