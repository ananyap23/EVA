import { defineComponent, ref, nextTick, onMounted } from 'vue'
import { PlusIcon, CloseIcon } from '@/components/core/AppleIcons'
import './InputBar.css'

/**
 * Minimalist Apple Liquid Glass Input Capsule
 * - [+ Ask AI] stadium pill text input
 * - [✕] circular frosted glass dismiss button
 */
export default defineComponent({
  name: 'InputBar',

  props: {
    visible: {
      type: Boolean,
      default: true,
    },
  },

  emits: ['submit', 'close'],

  setup(props, { emit }) {
    const inputText = ref('')
    const inputRef = ref<HTMLInputElement | null>(null)

    function onSubmit() {
      if (inputText.value.trim()) {
        emit('submit', inputText.value.trim())
        inputText.value = ''
      }
      emit('close')
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        inputText.value = ''
        emit('close')
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        onSubmit()
      }
    }

    function focusInput() {
      nextTick(() => {
        inputRef.value?.focus()
      })
    }

    onMounted(focusInput)

    return {
      inputText,
      inputRef,
      onSubmit,
      onKeydown,
      focusInput,
    }
  },

  render() {
    return (
      <div
        class={[
          'apple-input-cluster',
          this.visible ? 'animate-slide-up' : 'animate-slide-down',
        ]}
      >
        {/* [+ Ask AI] Main Stadium Capsule Pill */}
        <div class="apple-glass-pill apple-ask-pill">
          <span class="apple-ask-pill__plus">
            <PlusIcon size={17} color="rgba(255, 255, 255, 0.7)" />
          </span>
          <input
            ref="inputRef"
            type="text"
            class="apple-ask-pill__input"
            placeholder="Ask AI or type command..."
            value={this.inputText}
            onInput={(e: any) => (this.inputText = e.target.value)}
            onKeydown={this.onKeydown}
          />
          {this.inputText.trim().length > 0 && (
            <button
              type="button"
              class="apple-ask-pill__send-btn"
              onClick={this.onSubmit}
              title="Submit command (Enter)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          )}
        </div>

        {/* [✕] Circular Glass Close Button */}
        <button
          type="button"
          class="apple-glass-circle"
          title="Dismiss input (Escape)"
          onClick={() => this.$emit('close')}
        >
          <CloseIcon size={15} color="rgba(255, 255, 255, 0.78)" />
        </button>
      </div>
    )
  },
})
