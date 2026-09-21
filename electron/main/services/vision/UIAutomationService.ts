/**
 * UIAutomationService — Windows UI Automation (UIA) for EVA-01.
 *
 * Extracts real interactive controls (buttons, inputs, menus, tabs)
 * from the active foreground application using native Windows UI Automation.
 *
 * Benefits:
 * - 100% exact click coordinates (zero coordinate guessing or hallucination)
 * - Zero VRAM cost (plain text tokens instead of heavy image embeddings)
 * - Drastically faster decision loop for local models (moondream, qwen2.5-vl)
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from '@electron/utils/logger'
import { ScreenStateService } from './ScreenStateService'

const execFileAsync = promisify(execFile)
const log = createLogger('UIAutomationService')

export interface UIAElement {
  id: number
  name: string
  type: string
  x: number
  y: number
  width: number
  height: number
  automationId: string
}

export class UIAutomationService {
  private static instance: UIAutomationService
  private cache: UIAElement[] = []
  private cacheTime = 0
  private lastActiveApp = ''

  static getInstance(): UIAutomationService {
    if (!UIAutomationService.instance) {
      UIAutomationService.instance = new UIAutomationService()
    }
    return UIAutomationService.instance
  }

  /**
   * Queries the foreground window using native Windows UIAutomation
   * and returns a list of interactive controls with exact center coordinates.
   */
  async getInteractiveElements(_limit = 35): Promise<UIAElement[]> {
    try {
      const state = await ScreenStateService.getInstance().getScreenState()
      this.lastActiveApp = state.foregroundWindow?.title || state.foregroundWindow?.process || 'Desktop'
      this.cache = state.elements.map(e => ({
        id: e.id,
        name: e.name,
        type: e.type,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        automationId: e.automationId,
      }))
      this.cacheTime = Date.now()
      return this.cache
    } catch (err) {
      log.warn(`UIAutomation probe error: ${err}`)
      return []
    }
  }

  /**
   * Formats extracted elements into a compact text block for LLM prompts.
   */
  formatElementsForPrompt(elements: UIAElement[]): string {
    if (!elements || elements.length === 0) {
      return ''
    }

    const lines = [
      `### Active Window UI Elements ("${this.lastActiveApp}"):`,
      'The following interactive UI elements are currently visible. You can target them by ID or coordinate:',
    ]

    for (const el of elements.slice(0, 30)) {
      lines.push(`[${el.id}] ${el.type} "${el.name}" at coordinate (${el.x}, ${el.y})`)
    }

    return lines.join('\n')
  }

  /**
   * Fuzzy-searches for a UI element by query (e.g. "address bar", "file", "close").
   */
  findElement(query: string, elements?: UIAElement[]): UIAElement | null {
    const list = elements || this.cache
    if (!list || list.length === 0) return null

    const q = query.toLowerCase().trim()

    // 1. Exact name match
    for (const el of list) {
      if (el.name.toLowerCase() === q || el.automationId.toLowerCase() === q) {
        return el
      }
    }

    // 2. Contains match
    for (const el of list) {
      const n = el.name.toLowerCase()
      const a = el.automationId.toLowerCase()
      if (n.includes(q) || a.includes(q) || q.includes(n)) {
        return el
      }
    }

    return null
  }
}
