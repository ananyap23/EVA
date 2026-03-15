import { defineComponent, ref, watch, type PropType, nextTick } from 'vue'
import GlassPanel from '@/components/core/GlassPanel'
import './ListeningIsland.css'

/**
 * ListeningIsland — displays live speech transcript with word-by-word animation.
 *
 * Mirrors ResponseIsland's chunk-based reveal animation.
 * Shows a pulsing mic indicator while actively listening.
 */
export default defineComponent({
  name: 'ListeningIsland',

  props: {
    chunks: {
      type: Array as PropType<string[]>,
      required: true,
    },
    transcript: {
      type: String,
      default: '',
    },
  },

  setup(props) {
    const scrollRef = ref<HTMLElement | null>(null)

    watch(
      () => props.chunks.length,
      () => {
        nextTick(() => {
          if (scrollRef.value) {
            scrollRef.value.scrollTop = scrollRef.value.scrollHeight
          }
        })
      },
    )

    return { scrollRef }
  },

  render() {
    const hasText = this.chunks.length > 0 || this.transcript

    return (
      <GlassPanel class="island island--listening">
        <div class="island__header island__header--listening">
          <span class="island__icon listening__mic-icon">mic</span>
          <span class="island__title">Listening...</span>
        </div>

        <div class="listening__scroll" ref="scrollRef">
          <div class="island__label listening__text">
            {/* Committed chunks — static */}
            {this.chunks.map((chunk, i) => (
              <span key={`c-${i}`} class="response__chunk">
                {i > 0 ? ' ' : ''}{chunk}
              </span>
            ))}

            {/* Current partial transcript — animated */}
            {this.transcript && (
              <span class="response__chunk">
                {this.transcript.split(/(\s+)/).map((word, wi) => (
                  <span
                    key={`w-${wi}`}
                    class="response__word response__word--reveal"
                    style={`--word-delay: ${Math.min(wi * 35, 250)}ms`}
                  >
                    {word}
                  </span>
                ))}
              </span>
            )}

            {/* Blinking cursor when no text yet */}
            {!hasText && (
              <span class="listening__cursor">|</span>
            )}
          </div>
        </div>
      </GlassPanel>
    )
  },
})
