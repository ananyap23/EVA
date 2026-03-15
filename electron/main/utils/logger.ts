/**
 * createLogger — structured scoped logger for the main process.
 *
 * Features:
 * - ISO-8601 timestamps on every line
 * - Log level filtering via `LOG_LEVEL` env var (debug | info | warn | error)
 * - Format: `[TIMESTAMP] [LEVEL] [Scope] message`
 * - Persistent file logging to `{userData}/Log`
 * - Auto-cleanup: keeps last ~1 MB when file exceeds 5 MB (checked once on startup)
 * - Same `Logger` interface — zero changes for consumers
 *
 * @example
 * const log = createLogger('AgentService')
 * log.info('Initialized')    // → [2026-03-12T03:00:00.000Z] [INFO] [AgentService] Initialized
 * log.error('Boom', err)     // → [2026-03-12T03:00:00.000Z] [ERROR] [AgentService] Boom Error: ...
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type LogFn = (...args: unknown[]) => void

export interface Logger {
  info: LogFn
  warn: LogFn
  error: LogFn
  debug: LogFn
}

// ── Log Level Filtering ──

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getMinLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase()
  if (env && env in LEVEL_PRIORITY) return env as LogLevel
  // Default: debug in dev, info in production
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinLevel()]
}

// ── File Transport ──

const MAX_LOG_SIZE = 5 * 1024 * 1024   // 5 MB
const KEEP_TAIL    = 1 * 1024 * 1024   // keep last ~1 MB on cleanup

let _logFilePath: string | null = null
let _logFileReady = false

function getLogFilePath(): string {
  if (!_logFilePath) {
    _logFilePath = path.join(app.getPath('userData'), 'Log')
  }
  return _logFilePath
}

/**
 * On first write, check file size and truncate if it exceeds MAX_LOG_SIZE.
 * Keeps the last KEEP_TAIL bytes so recent context is preserved.
 */
function ensureLogFile(): void {
  if (_logFileReady) return
  _logFileReady = true

  const filePath = getLogFilePath()

  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath)

      if (stats.size > MAX_LOG_SIZE) {
        // Read last KEEP_TAIL bytes
        const buf = Buffer.alloc(KEEP_TAIL)
        const fd = fs.openSync(filePath, 'r')
        const readFrom = stats.size - KEEP_TAIL
        fs.readSync(fd, buf, 0, KEEP_TAIL, readFrom)
        fs.closeSync(fd)

        // Find the first newline so we don't start mid-line
        const nlIndex = buf.indexOf(0x0A) // '\n'
        const clean = nlIndex >= 0 ? buf.subarray(nlIndex + 1) : buf

        fs.writeFileSync(filePath, clean)
      }
    }
  } catch {
    // If cleanup fails, just continue — logging should never crash the app
  }
}

/** Serialize args the same way console does, then append to file */
function writeToFile(prefix: string, args: unknown[]): void {
  try {
    ensureLogFile()

    const parts = args.map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`
      if (typeof a === 'object') {
        try { return JSON.stringify(a) } catch { return String(a) }
      }
      return String(a)
    })

    const line = `${prefix} ${parts.join(' ')}\n`
    fs.appendFileSync(getLogFilePath(), line, 'utf-8')
  } catch {
    // Never crash the app because of file logging
  }
}

/** Write a session-start banner to the log file */
export function logSessionStart(command: string): void {
  try {
    ensureLogFile()
    const ts = new Date().toISOString()
    const banner =
      `\n` +
      `════════════════════════════════════════════════════════════════\n` +
      `  ▶ SESSION START  ${ts}\n` +
      `  ▶ Command: "${command}"\n` +
      `════════════════════════════════════════════════════════════════\n`
    fs.appendFileSync(getLogFilePath(), banner, 'utf-8')
  } catch {
    // Never crash the app because of file logging
  }
}

/** Write a session-end banner to the log file */
export function logSessionEnd(): void {
  try {
    ensureLogFile()
    const ts = new Date().toISOString()
    const banner =
      `────────────────────────────────────────────────────────────────\n` +
      `  ■ SESSION END    ${ts}\n` +
      `────────────────────────────────────────────────────────────────\n\n`
    fs.appendFileSync(getLogFilePath(), banner, 'utf-8')
  } catch {
    // Never crash the app because of file logging
  }
}

/** Open the log file in a text editor */
export async function openLogFile(): Promise<void> {
  const filePath = getLogFilePath()
  if (!fs.existsSync(filePath)) return

  const { exec } = await import('node:child_process')
  if (process.platform === 'win32') {
    exec(`notepad "${filePath}"`)
  } else if (process.platform === 'darwin') {
    exec(`open -t "${filePath}"`)
  } else {
    exec(`xdg-open "${filePath}"`)
  }
}

// ── Logger Factory ──

export function createLogger(scope: string): Logger {
  function format(level: string): string {
    return `[${new Date().toISOString()}] [${level}] [${scope}]`
  }

  return {
    info: (...args) => {
      if (!shouldLog('info')) return
      const prefix = format('INFO')
      console.log(prefix, ...args)
      writeToFile(prefix, args)
    },
    warn: (...args) => {
      if (!shouldLog('warn')) return
      const prefix = format('WARN')
      console.warn(prefix, ...args)
      writeToFile(prefix, args)
    },
    error: (...args) => {
      if (!shouldLog('error')) return
      const prefix = format('ERROR')
      console.error(prefix, ...args)
      writeToFile(prefix, args)
    },
    debug: (...args) => {
      if (!shouldLog('debug')) return
      const prefix = format('DEBUG')
      console.debug(prefix, ...args)
      writeToFile(prefix, args)
    },
  }
}
