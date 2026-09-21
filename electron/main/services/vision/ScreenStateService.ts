/**
 * ScreenStateService — Hierarchical Screen State Engine for EVA-01.
 *
 * Continuously gathers and maintains structured desktop perception:
 * 1. Screen geometry & DPI scaling
 * 2. Active foreground window (with fallback for EVA overlay)
 * 3. Open top-level visible application windows
 * 4. Interactive UI Automation controls with exact click coordinates
 * 5. Taskbar applications, launchers, and system tray items
 * 6. Cursor position
 *
 * Gives LLMs and Agent loops semantic perception before falling back to vision models.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { screen, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { createLogger } from '@electron/utils/logger'

const execFileAsync = promisify(execFile)
const log = createLogger('ScreenStateService')

export interface WindowInfo {
  title: string
  process: string
  pid: number
  hwnd: string
  x: number
  y: number
  width: number
  height: number
  isForeground: boolean
}

export interface UIAControl {
  id: number
  name: string
  type: string
  x: number
  y: number
  width: number
  height: number
  automationId: string
  enabled: boolean
  value?: string
}

export interface TaskbarItem {
  id: number
  name: string
  type: string
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenState {
  screen: {
    width: number
    height: number
    scale: number
  }
  cursor: {
    x: number
    y: number
  }
  foregroundWindow: WindowInfo | null
  windows: WindowInfo[]
  elements: UIAControl[]
  taskbar: TaskbarItem[]
  timestamp: number
}

export class ScreenStateService {
  private static instance: ScreenStateService
  private lastState: ScreenState | null = null
  private lastFetchTime = 0

  static getInstance(): ScreenStateService {
    if (!ScreenStateService.instance) {
      ScreenStateService.instance = new ScreenStateService()
    }
    return ScreenStateService.instance
  }

  private resolveScriptPath(): string {
    const candidates = [
      path.join(__dirname, 'get_screen_state.ps1'),
      path.join(app?.getAppPath?.() || process.cwd(), 'electron/main/services/vision/get_screen_state.ps1'),
      path.join(process.cwd(), 'electron/main/services/vision/get_screen_state.ps1'),
      path.join(__dirname, '../../electron/main/services/vision/get_screen_state.ps1'),
    ]

    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    return candidates[0]
  }

  /**
   * Captures the complete structured state of the desktop.
   * Caches for 1000ms to avoid redundant PowerShell invocations in rapid loops.
   */
  async getScreenState(forceRefresh = false): Promise<ScreenState> {
    const now = Date.now()
    if (!forceRefresh && this.lastState && now - this.lastFetchTime < 1000) {
      return this.lastState
    }

    let screenGeometry = { width: 1920, height: 1080, scale: 1.0 }
    let cursor = { x: 0, y: 0 }

    try {
      const primaryDisplay = screen.getPrimaryDisplay()
      screenGeometry = {
        width: primaryDisplay.size.width,
        height: primaryDisplay.size.height,
        scale: primaryDisplay.scaleFactor || 1.0,
      }
      cursor = screen.getCursorScreenPoint()
    } catch {
      // Fallback in headless / test contexts
    }

    if (process.platform !== 'win32') {
      const fallbackState: ScreenState = {
        screen: screenGeometry,
        cursor,
        foregroundWindow: null,
        windows: [],
        elements: [],
        taskbar: [],
        timestamp: now,
      }
      this.lastState = fallbackState
      return fallbackState
    }

    const scriptPath = this.resolveScriptPath()

    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: 4500 },
      )

      const clean = stdout.trim()
      if (!clean) throw new Error('Empty PowerShell output')

      const parsed = JSON.parse(clean)

      const rawWindows = parsed.Windows || parsed.windows || []
      const windows: WindowInfo[] = (Array.isArray(rawWindows) ? rawWindows : [rawWindows]).map((w: any) => ({
        title: w.Title || w.title || '',
        process: w.ProcessName || w.process || '',
        pid: w.ProcessId || w.pid || 0,
        hwnd: String(w.Hwnd || w.hwnd || ''),
        x: w.X ?? w.x ?? 0,
        y: w.Y ?? w.y ?? 0,
        width: w.Width ?? w.width ?? 0,
        height: w.Height ?? w.height ?? 0,
        isForeground: Boolean(w.IsForeground ?? w.isForeground),
      }))

      const rawElements = parsed.Elements || parsed.elements || []
      const elements: UIAControl[] = (Array.isArray(rawElements) ? rawElements : [rawElements]).map((e: any) => ({
        id: e.Id ?? e.id ?? 0,
        name: e.Name || e.name || '',
        type: e.Role || e.type || 'Custom',
        x: e.X ?? e.x ?? 0,
        y: e.Y ?? e.y ?? 0,
        width: e.Width ?? e.width ?? 0,
        height: e.Height ?? e.height ?? 0,
        automationId: e.AutomationId || e.automationId || '',
        enabled: Boolean(e.IsEnabled ?? e.enabled ?? true),
        value: e.Value || e.value || undefined,
      }))

      const rawTaskbar = parsed.Taskbar || parsed.taskbar || []
      const taskbar: TaskbarItem[] = (Array.isArray(rawTaskbar) ? rawTaskbar : [rawTaskbar]).map((t: any) => ({
        id: t.Id ?? t.id ?? 0,
        name: t.Name || t.name || '',
        type: t.Role || t.type || 'Button',
        x: t.X ?? t.x ?? 0,
        y: t.Y ?? t.y ?? 0,
        width: t.Width ?? t.width ?? 0,
        height: t.Height ?? t.height ?? 0,
      }))

      const rawFg = parsed.Foreground || parsed.foreground
      const foregroundWindow: WindowInfo | null = rawFg && (rawFg.Title || rawFg.title)
        ? {
            title: rawFg.Title || rawFg.title || '',
            process: rawFg.ProcessName || rawFg.process || '',
            pid: rawFg.ProcessId || rawFg.pid || 0,
            hwnd: String(rawFg.Hwnd || rawFg.hwnd || ''),
            x: rawFg.X ?? rawFg.x ?? 0,
            y: rawFg.Y ?? rawFg.y ?? 0,
            width: rawFg.Width ?? rawFg.width ?? 0,
            height: rawFg.Height ?? rawFg.height ?? 0,
            isForeground: true,
          }
        : (windows.find((w) => w.isForeground) || null)

      const state: ScreenState = {
        screen: screenGeometry,
        cursor: parsed.Cursor ? { x: parsed.Cursor.X, y: parsed.Cursor.Y } : (parsed.cursor || cursor),
        foregroundWindow,
        windows,
        elements,
        taskbar,
        timestamp: now,
      }

      this.lastState = state
      this.lastFetchTime = now
      log.debug(
        `Desktop State: ${windows.length} windows, ${elements.length} controls, ${taskbar.length} taskbar items (Active: "${state.foregroundWindow?.title || 'None'}")`,
      )
      return state
    } catch (err) {
      log.warn(`ScreenState query failed: ${err}`)
      const fallbackState: ScreenState = {
        screen: screenGeometry,
        cursor,
        foregroundWindow: null,
        windows: [],
        elements: [],
        taskbar: [],
        timestamp: now,
      }
      this.lastState = fallbackState
      return fallbackState
    }
  }

  /**
   * Formats the hierarchical desktop state into a compact LLM prompt context block.
   */
  formatStateForPrompt(state: ScreenState): string {
    const lines: string[] = []
    lines.push('=== CURRENT DESKTOP STATE ===')
    lines.push(
      `Screen: ${state.screen.width}x${state.screen.height} @ ${state.screen.scale}x | Cursor: (${state.cursor.x}, ${state.cursor.y})`,
    )

    if (state.foregroundWindow) {
      lines.push(
        `\nACTIVE FOREGROUND WINDOW:\n"${state.foregroundWindow.title}" (${state.foregroundWindow.process}.exe) [Bounds: ${state.foregroundWindow.x}, ${state.foregroundWindow.y}, ${state.foregroundWindow.width}x${state.foregroundWindow.height}]`,
      )
    }

    if (state.windows.length > 0) {
      lines.push('\nOPEN APPLICATION WINDOWS:')
      for (const w of state.windows.slice(0, 10)) {
        const isFgTag = w.isForeground ? ' [Active]' : ''
        lines.push(`- "${w.title}" (${w.process}.exe)${isFgTag}`)
      }
    }

    if (state.elements.length > 0) {
      lines.push('\nINTERACTIVE UI CONTROLS (Active Window Click Coordinates):')
      for (const el of state.elements.slice(0, 35)) {
        const val = el.value ? ` = "${el.value}"` : ''
        lines.push(`[${el.id}] [${el.type}] "${el.name}"${val} @ (${el.x}, ${el.y})`)
      }
    }

    if (state.taskbar.length > 0) {
      lines.push('\nTASKBAR APPS & LAUNCHERS (Exact Click Coordinates):')
      for (const tb of state.taskbar) {
        lines.push(`[Taskbar] "${tb.name}" @ (${tb.x}, ${tb.y})`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Generates a direct natural language response for "what windows are open".
   */
  describeOpenWindows(state: ScreenState): string {
    if (!state.windows || state.windows.length === 0) {
      return 'No open application windows were detected on your screen.'
    }

    const nonSystem = state.windows.filter(w => !w.process.match(/^(electron|eva|atlas)$/i))
    const list = nonSystem.length > 0 ? nonSystem : state.windows
    const names = list.map(w => `• **${w.title}** (${w.process}.exe)${w.isForeground ? ' *(Active)*' : ''}`).join('\n')
    
    const activeNote = state.foregroundWindow 
      ? `\n\nCurrently, the active foreground window is **${state.foregroundWindow.title}**.`
      : ''

    return `Here are the open windows currently on your desktop (${list.length} detected):\n\n${names}${activeNote}`
  }

  /**
   * Generates a direct natural language response for "what is the active window".
   */
  describeForegroundWindow(state: ScreenState): string {
    if (state.foregroundWindow) {
      return `The active foreground window is **${state.foregroundWindow.title}** (${state.foregroundWindow.process}.exe).`
    }
    return 'There is currently no active foreground application window detected.'
  }

  /**
   * Generates a direct natural language response for "what apps are on my taskbar".
   */
  describeTaskbar(state: ScreenState): string {
    if (!state.taskbar || state.taskbar.length === 0) {
      return 'No taskbar apps or items were detected.'
    }

    const items = state.taskbar.map(t => `• ${t.name}`).join('\n')
    return `Here are the applications and items on your taskbar (${state.taskbar.length} items):\n\n${items}`
  }

  /**
   * Generates a direct natural language response for "tell me about my screen".
   */
  describeCompleteDesktop(state: ScreenState): string {
    const parts: string[] = []
    
    if (state.foregroundWindow) {
      parts.push(`You are currently in **${state.foregroundWindow.title}** (${state.foregroundWindow.process}.exe).`)
    }

    if (state.elements.length > 0) {
      const topControls = state.elements.slice(0, 8).map(e => `\`${e.name}\` (${e.type})`).join(', ')
      parts.push(`In the active window, I can see interactive controls including: ${topControls}.`)
    }

    if (state.windows.length > 1) {
      const other = state.windows.filter(w => !w.isForeground).slice(0, 5).map(w => w.process).join(', ')
      parts.push(`Other open applications include: ${other}.`)
    }

    if (state.taskbar.length > 0) {
      const tbList = state.taskbar.slice(0, 6).map(t => t.name).join(', ')
      parts.push(`Your taskbar has shortcuts for: ${tbList}, and more.`)
    }

    return parts.join('\n\n') || 'Desktop perception is active and ready.'
  }

  /**
   * Fuzzy matches a target name / role to an extracted UIA element or Taskbar launcher.
   * Returns exact coordinate or null if not found.
   */
  resolveElementCoordinates(query: string, state?: ScreenState): { x: number; y: number; name: string; type: 'element' | 'taskbar' | 'window' } | null {
    const targetState = state || this.lastState
    if (!targetState) return null

    const q = query.toLowerCase().trim()
    const cleanQuery = q.replace(/^(?:the\s+)?(?:on\s+)?(?:the\s+)?taskbar\b/i, '').replace(/^(?:click|open|launch|focus|switch to)\s+/i, '').trim()

    // 1. Check Taskbar items if query specifically mentions taskbar or matches a pinned/running app
    if (q.includes('taskbar')) {
      const tbMatch = targetState.taskbar.find((tb) => {
        const tbLower = tb.name.toLowerCase()
        return tbLower.includes(cleanQuery) || cleanQuery.includes(tbLower)
      })
      if (tbMatch) {
        return { x: tbMatch.x, y: tbMatch.y, name: tbMatch.name, type: 'taskbar' }
      }
    }

    // 2. Check window controls (exact match on name or automationId)
    let match = targetState.elements.find(
      (e) => e.name.toLowerCase() === cleanQuery || e.automationId?.toLowerCase() === cleanQuery,
    )

    // 3. Check window controls (substring match)
    if (!match) {
      match = targetState.elements.find(
        (e) => e.name.toLowerCase().includes(cleanQuery) || cleanQuery.includes(e.name.toLowerCase()),
      )
    }

    if (match) {
      return { x: match.x, y: match.y, name: match.name, type: 'element' }
    }

    // 4. Check Taskbar items (general fallback)
    const tbMatch = targetState.taskbar.find((tb) => {
      const tbLower = tb.name.toLowerCase()
      return tbLower.includes(cleanQuery) || cleanQuery.includes(tbLower)
    })
    if (tbMatch) {
      return { x: tbMatch.x, y: tbMatch.y, name: tbMatch.name, type: 'taskbar' }
    }

    // 5. Check open windows (center of window)
    const winMatch = targetState.windows.find(
      (w) => w.title.toLowerCase().includes(cleanQuery) || w.process.toLowerCase().includes(cleanQuery),
    )
    if (winMatch) {
      return {
        x: Math.round(winMatch.x + winMatch.width / 2),
        y: Math.round(winMatch.y + Math.min(30, winMatch.height / 2)),
        name: winMatch.title,
        type: 'window',
      }
    }

    return null
  }
}
