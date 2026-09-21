/* eslint-disable vue/one-component-per-file */
import { defineComponent, type PropType } from 'vue'

export const SparklesIcon = defineComponent({
  name: 'SparklesIcon',
  props: {
    size: { type: Number, default: 20 },
    color: { type: String, default: 'currentColor' },
  },
  render() {
    return (
      <svg
        width={this.size}
        height={this.size}
        viewBox="0 0 24 24"
        fill={this.color}
        style="display: block;"
      >
        {/* Primary 4-point star */}
        <path d="M12 2C12.4 6.8 15.2 9.6 20 10C15.2 10.4 12.4 13.2 12 18C11.6 13.2 8.8 10.4 4 10C8.8 9.6 11.6 6.8 12 2Z" />
        {/* Secondary baby star */}
        <path
          d="M18.5 14.5C18.7 16.6 19.9 17.8 22 18C19.9 18.2 18.7 19.4 18.5 21.5C18.3 19.4 17.1 18.2 15 18C17.1 17.8 18.3 16.6 18.5 14.5Z"
          opacity="0.85"
        />
      </svg>
    )
  },
})

export const MicIcon = defineComponent({
  name: 'MicIcon',
  props: {
    size: { type: Number, default: 18 },
    color: { type: String, default: 'currentColor' },
  },
  render() {
    return (
      <svg
        width={this.size}
        height={this.size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={this.color}
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="display: block;"
      >
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="17" x2="12" y2="21" />
        <line x1="8" y1="21" x2="16" y2="21" />
      </svg>
    )
  },
})

export const WaveformIcon = defineComponent({
  name: 'WaveformIcon',
  props: {
    size: { type: Number, default: 18 },
    color: { type: String, default: 'currentColor' },
    heights: {
      type: Array as PropType<number[]>,
      default: () => [6, 12, 16, 10, 6],
    },
  },
  render() {
    const h = this.heights
    return (
      <svg
        width={this.size}
        height={this.size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={this.color}
        stroke-width="2.2"
        stroke-linecap="round"
        style="display: block;"
      >
        <line x1="4" y1={12 - (h[0] || 6) / 2} x2="4" y2={12 + (h[0] || 6) / 2} />
        <line x1="8" y1={12 - (h[1] || 12) / 2} x2="8" y2={12 + (h[1] || 12) / 2} />
        <line x1="12" y1={12 - (h[2] || 16) / 2} x2="12" y2={12 + (h[2] || 16) / 2} />
        <line x1="16" y1={12 - (h[3] || 10) / 2} x2="16" y2={12 + (h[3] || 10) / 2} />
        <line x1="20" y1={12 - (h[4] || 6) / 2} x2="20" y2={12 + (h[4] || 6) / 2} />
      </svg>
    )
  },
})

export const CloseIcon = defineComponent({
  name: 'CloseIcon',
  props: {
    size: { type: Number, default: 16 },
    color: { type: String, default: 'currentColor' },
  },
  render() {
    return (
      <svg
        width={this.size}
        height={this.size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={this.color}
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="display: block;"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    )
  },
})

export const PlusIcon = defineComponent({
  name: 'PlusIcon',
  props: {
    size: { type: Number, default: 18 },
    color: { type: String, default: 'currentColor' },
  },
  render() {
    return (
      <svg
        width={this.size}
        height={this.size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={this.color}
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="display: block;"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    )
  },
})

export const InsightsIcon = defineComponent({
  name: 'InsightsIcon',
  props: {
    size: { type: Number, default: 18 },
    color: { type: String, default: 'currentColor' },
  },
  render() {
    return (
      <svg
        width={this.size}
        height={this.size}
        viewBox="0 0 24 24"
        fill={this.color}
        style="display: block;"
      >
        <path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.87-3.13-7-7-7zm-1 10.5V11h2v1.5l1.8-2.7c.33-.5.17-1.18-.33-1.5-.15-.1-.32-.15-.47-.15h-2V7h-2v1.5l-1.8 2.7c-.33.5-.17 1.18.33 1.5.15.1.32.15.47.15H11zM9 20c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1z" />
      </svg>
    )
  },
})

export const DashboardIcon = defineComponent({
  name: 'DashboardIcon',
  props: {
    size: { type: Number, default: 18 },
    color: { type: String, default: 'currentColor' },
  },
  render() {
    return (
      <svg
        width={this.size}
        height={this.size}
        viewBox="0 0 24 24"
        fill={this.color}
        style="display: block;"
      >
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 4.07c2.61.46 4.7 2.33 5.4 4.83L14 12.15V6.07zM11 6.07v6.08L6.6 13.9c-.39-.59-.6-1.28-.6-2 0-3.04 2.22-5.57 5-5.83zm1 13.93c-4.41 0-8-3.59-8-8 0-.49.06-.97.16-1.43L13 13.83v6.17z" />
      </svg>
    )
  },
})

export const HealthIcon = defineComponent({
  name: 'HealthIcon',
  props: {
    size: { type: Number, default: 18 },
    color: { type: String, default: 'currentColor' },
  },
  render() {
    return (
      <svg
        width={this.size}
        height={this.size}
        viewBox="0 0 24 24"
        fill={this.color}
        style="display: block;"
      >
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35zm-2.2-11.85h-1.6l-1 2.3-1.2-4.1-1.3 2.8H3.5v1.6h2.2l1.1-2.4 1.2 4.1 1.4-3.3h1.8v-1z" />
      </svg>
    )
  },
})
