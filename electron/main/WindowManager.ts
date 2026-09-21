import { BrowserWindow, shell, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIPCHandler } from 'electron-trpc/main'
import { router } from './api'
import { getConfig } from './utils/config'
import { createLogger } from './utils/logger'
import { mainEventBus } from './utils/eventBus'
import { preload, indexHtml, VITE_DEV_SERVER_URL } from './utils/paths'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * WindowManager — Electron window creation and visibility management.
 *
 * Handles:
 * - BrowserWindow creation (transparent overlay)
 * - Active-monitor positioning (cursor-based)
 * - Show/hide toggle with animation coordination
 * - Ensures window is visible when settings are opened from tray
 */

const log = createLogger('WindowManager')

let win: BrowserWindow | null = null
let isAgentVisible = false
let settingsActive = false

export function isSettingsActive(): boolean {
  return settingsActive
}

export function setSettingsActive(active: boolean): void {
  settingsActive = active
  log.info(`Settings active state changed to: ${active}`)
}

let lastToggleTime = 0

// ── Multi-Monitor Positioning ──

/** Returns work-area bounds (excludes taskbar) for the display under the cursor. */
function getActiveDisplayBounds() {
  const cursor = screen.getCursorScreenPoint()
  return screen.getDisplayNearestPoint(cursor).workArea
}

// ── Window Creation ──

export async function createWindow(): Promise<BrowserWindow> {
  const { x, y, width, height } = getActiveDisplayBounds()

  win = new BrowserWindow({
    title: 'EVA-01',
    icon: `${process.env.VITE_PUBLIC}/favicon.ico`,
    width,
    height,
    x,
    y,

    // Transparent frameless overlay
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: false, // set after creation via setAlwaysOnTop(true, 'screen-saver')
    skipTaskbar: true,

    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
    },

    // macOS: native vibrancy blur
    ...(process.platform === 'darwin' && {
      vibrancy: 'fullscreen-ui' as const,
      visualEffectState: 'active' as const,
    }),
  })

  // Load content
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    if (process.env.OPEN_DEVTOOLS === 'true') {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    win.loadFile(indexHtml)
  }

  // Enable click-through by default with forward mode
  // Clicks pass through to the desktop; hover detection still works
  win.setIgnoreMouseEvents(true, { forward: true })

  // Clean renderer console forwarding
  win.webContents.on('console-message', (_event, level, message) => {
    // 0 = verbose/debug, 1 = info, 2 = warning, 3 = error
    if (level === 0) return
    if (/\[useSTT\] (Manually|Deactivated|AudioWorklet|Dropping|Linear)/i.test(message)) return
    if (/\[useTTS\] (Playback failed|stop|Blob)/i.test(message)) return
    if (/Electron Security Warning/i.test(message)) return

    const time = new Date().toTimeString().split(' ')[0]
    const clean = message.replace(/https?:\/\/[^\s)]+/g, '').trim()
    if (!clean) return

    if (level >= 3) {
      console.error(`[${time}] [ERROR] [UI] ${clean}`)
    } else if (level === 2) {
      console.warn(`[${time}] [WARN] [UI] ${clean}`)
    } else if (/Auto-submit|sendCommand|Voice recognized/i.test(clean)) {
      console.log(`[${time}] [INFO] [UI] ${clean}`)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // tRPC IPC bridge
  createIPCHandler({ router, windows: [win] })

  // When settings is requested from tray, ensure window is visible first
  mainEventBus.on('system:open-settings', () => {
    showWindowForSettings()
  })

  // Always-on-top with 'screen-saver' level — the highest z-order on Windows.
  const initialKeepOnTop = getConfig().ui.alwaysOnTop ?? true
  if (initialKeepOnTop) {
    win.setAlwaysOnTop(true, 'screen-saver')
  }

  // Listen for config changes to dynamically adjust alwaysOnTop
  let lastAlwaysOnTop: boolean | undefined = undefined
  mainEventBus.on('config:changed', (cfg) => {
    if (win && cfg.ui?.alwaysOnTop !== undefined) {
      if (cfg.ui.alwaysOnTop !== lastAlwaysOnTop) {
        lastAlwaysOnTop = cfg.ui.alwaysOnTop
        if (cfg.ui.alwaysOnTop) {
          win.setAlwaysOnTop(true, 'screen-saver')
          win.moveTop()
        } else {
          win.setAlwaysOnTop(false)
        }
      }
    }
  })

  // Start hidden — user reveals via tray icon or wake word
  win.setOpacity(0)

  log.info('Window created (hidden)')

  return win
}

// ── Show Window ──

/** Make the window visible, reposition to active monitor, bring always on top (keeps click-through). */
export function showWindow(): void {
  if (!win) return
  if (settingsActive) {
    log.debug('showWindow ignored: settings is active')
    return
  }

  const cfg = getConfig()
  const keepOnTop = cfg.ui.alwaysOnTop ?? true

  const { x, y, width, height } = getActiveDisplayBounds()
  win.setBounds({ x, y, width, height })
  win.setOpacity(1)
  win.setIgnoreMouseEvents(true, { forward: true })

  if (keepOnTop) {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
  }
  win.show()
  win.focus()

  isAgentVisible = true
  mainEventBus.emit('agent-visibility', true)
  log.info('Agent shown on top')
}

/** Show window AND disable click-through (for settings overlay). Does NOT activate the agent. */
export function showWindowForSettings(): void {
  if (!win) return
  setSettingsActive(true)
  // Make window visible on active monitor WITHOUT emitting agent-visibility
  const { x, y, width, height } = getActiveDisplayBounds()
  win.setBounds({ x, y, width, height })
  win.setOpacity(1)
  win.setIgnoreMouseEvents(false)

  const cfg = getConfig()
  if (cfg.ui.alwaysOnTop ?? true) {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
  }
  win.show()
  win.focus()
  log.info('Window shown on top for settings (agent not activated)')
}

// ── Visibility Toggle ──

export function toggleWindow(): void {
  if (!win) return
  if (settingsActive) {
    log.debug('toggleWindow ignored: settings is active')
    return
  }
  const now = Date.now()
  if (now - lastToggleTime < 400) {
    log.debug('toggleWindow ignored due to rapid double trigger (debounce)')
    return
  }
  lastToggleTime = now

  const isActuallyVisible = isAgentVisible && win.getOpacity() > 0

  if (isActuallyVisible) {
    // Notify renderer so it can animate out
    mainEventBus.emit('agent-visibility', false)
    // Give renderer time to animate, then hide
    setTimeout(() => {
      win?.setIgnoreMouseEvents(true)
      win?.setOpacity(0)
      isAgentVisible = false
    }, 350)
  } else {
    // Reposition to the monitor where the cursor currently is
    const { x, y, width, height } = getActiveDisplayBounds()
    win.setBounds({ x, y, width, height })

    win.setOpacity(1)
    win.setIgnoreMouseEvents(true, { forward: true })

    const cfg = getConfig()
    if (cfg.ui.alwaysOnTop ?? true) {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    }
    win.show()
    win.focus()

    mainEventBus.emit('agent-visibility', true)
    isAgentVisible = true
  }

  log.info(`Agent ${isAgentVisible ? 'shown on top' : 'hidden'}`)
}

/** Unconditionally hide the window (used when closing settings without agent). */
export function forceHideWindow(): void {
  if (!win) return
  win.setIgnoreMouseEvents(true)
  win.setOpacity(0)
  settingsActive = false
  isAgentVisible = false
  log.info('Window force-hidden')
}



// ── Action Focus Management ──

/**
 * Blur the Atlas window before executing a motor action.
 *
 * This ensures that hotkeys (Win+E, Alt+F4) and clicks target
 * the real foreground application, not the Atlas overlay.
 */
export function blurForAction(): void {
  if (!win) return
  win.blur()
  // Temporarily make fully transparent to input so we don't intercept anything
  win.setIgnoreMouseEvents(true)
  log.debug('Window blurred for action')
}

/**
 * Restore the Atlas window state after a motor action completes.
 */
export function restoreAfterAction(): void {
  if (!win) return
  win.setIgnoreMouseEvents(true, { forward: true })

  // Re-apply alwaysOnTop — blur() drops the window behind other apps
  win.setAlwaysOnTop(true, 'screen-saver')

  log.debug('Window restored after action')
}

// ── Accessors ──

export function getWindow(): BrowserWindow | null {
  return win
}

export function clearWindow(): void {
  win = null
}



/** Get the Electron Display that the Atlas window currently occupies. */
export function getWindowDisplay() {
  if (win) {
    return screen.getDisplayMatching(win.getBounds())
  }
  return screen.getPrimaryDisplay()
}

// ── Multi-Monitor Display Targeting ──

/**
 * Move the Atlas overlay to a specific display (0-indexed).
 * Used to show the rainbow border on the monitor the agent is looking at.
 */
export function moveToDisplay(displayIndex: number): void {
  if (!win) return
  const allDisplays = screen.getAllDisplays()
  if (displayIndex < 0 || displayIndex >= allDisplays.length) {
    log.warn(`Invalid display index: ${displayIndex}, total: ${allDisplays.length}`)
    return
  }
  const target = allDisplays[displayIndex]
  const { x, y, width, height } = target.workArea
  win.setBounds({ x, y, width, height })
  log.debug(`Window moved to display ${displayIndex + 1} (${width}x${height} at ${x},${y})`)
}

/**
 * Move the Atlas overlay back to the display where the cursor is.
 */
export function moveToActiveDisplay(): void {
  if (!win) return
  const { x, y, width, height } = getActiveDisplayBounds()
  win.setBounds({ x, y, width, height })
  log.debug('Window moved back to active display')
}
