import { app } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as https from 'node:https'
import * as http from 'node:http'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createLogger } from '@electron/utils/logger'
import { mainEventBus } from '@electron/utils/eventBus'

const log = createLogger('ModelManager')

/**
 * Vosk model URLs by language code.
 * Small models (~40–70 MB) optimized for real-time recognition.
 */
const MODEL_URLS: Record<string, string> = {
  en: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
  'en-in': 'https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip',
  ru: 'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip',
  cn: 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip',
  de: 'https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip',
  fr: 'https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip',
  es: 'https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip',
  pt: 'https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip',
  tr: 'https://alphacephei.com/vosk/models/vosk-model-small-tr-0.3.zip',
  vn: 'https://alphacephei.com/vosk/models/vosk-model-small-vn-0.4.zip',
  it: 'https://alphacephei.com/vosk/models/vosk-model-small-it-0.22.zip',
  nl: 'https://alphacephei.com/vosk/models/vosk-model-small-nl-0.22.zip',
  ca: 'https://alphacephei.com/vosk/models/vosk-model-small-ca-0.4.zip',
  uk: 'https://alphacephei.com/vosk/models/vosk-model-small-uk-v3-small.zip',
  kz: 'https://alphacephei.com/vosk/models/vosk-model-small-kz-0.42.zip',
  sv: 'https://alphacephei.com/vosk/models/vosk-model-small-sv-rhasspy-0.15.zip',
  ja: 'https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip',
  eo: 'https://alphacephei.com/vosk/models/vosk-model-small-eo-0.42.zip',
  hi: 'https://alphacephei.com/vosk/models/vosk-model-small-hi-0.22.zip',
  cs: 'https://alphacephei.com/vosk/models/vosk-model-small-cs-0.4-rhasspy.zip',
  pl: 'https://alphacephei.com/vosk/models/vosk-model-small-pl-0.22.zip',
  uz: 'https://alphacephei.com/vosk/models/vosk-model-small-uz-0.22.zip',
  ko: 'https://alphacephei.com/vosk/models/vosk-model-small-ko-0.22.zip',
  fa: 'https://alphacephei.com/vosk/models/vosk-model-small-fa-0.5.zip',
  gu: 'https://alphacephei.com/vosk/models/vosk-model-small-gu-0.42.zip',
  tg: 'https://alphacephei.com/vosk/models/vosk-model-small-tg-0.22.zip',
  te: 'https://alphacephei.com/vosk/models/vosk-model-small-te-0.42.zip',
  ky: 'https://alphacephei.com/vosk/models/vosk-model-small-ky-0.42.zip',
  ar: 'https://alphacephei.com/vosk/models/vosk-model-small-ar-tn-0.1-linto.zip',
}

const MODEL_FALLBACK_URLS: Record<string, string> = {
  en: 'https://huggingface.co/rhasspy/vosk-models/resolve/main/en/vosk-model-small-en-us-0.15.zip',
  'en-in': 'https://huggingface.co/rhasspy/vosk-models/resolve/main/en-in/vosk-model-small-en-in-0.4.zip',
  hi: 'https://huggingface.co/rhasspy/vosk-models/resolve/main/hi/vosk-model-small-hi-0.22.zip',
  de: 'https://huggingface.co/rhasspy/vosk-models/resolve/main/de/vosk-model-small-de-0.15.zip',
  fr: 'https://huggingface.co/rhasspy/vosk-models/resolve/main/fr/vosk-model-small-fr-0.22.zip',
  es: 'https://huggingface.co/rhasspy/vosk-models/resolve/main/es/vosk-model-small-es-0.42.zip',
  ru: 'https://huggingface.co/rhasspy/vosk-models/resolve/main/ru/vosk-model-small-ru-0.22.zip',
  it: 'https://huggingface.co/rhasspy/vosk-models/resolve/main/it/vosk-model-small-it-0.22.zip',
  nl: 'https://huggingface.co/rhasspy/vosk-models/resolve/main/nl/vosk-model-small-nl-0.22.zip',
  pt: 'https://huggingface.co/rhasspy/vosk-models/resolve/main/pt/vosk-model-small-pt-0.3.zip',
}

/** Root directory for STT models */
function modelsRoot(): string {
  return path.join(app.getPath('userData'), 'Models', 'stt')
}

/** Path to a specific language model directory */
export function modelPath(language: string): string {
  return path.join(modelsRoot(), language)
}

/** Path to the model archive (served to renderer via protocol) */
export function modelArchivePath(language: string): string {
  return path.join(modelsRoot(), `${language}.zip`)
}

/** Check if a model is downloaded for the given language */
export function isModelDownloaded(language: string): boolean {
  const p = modelArchivePath(language)
  if (!fs.existsSync(p)) return false
  try {
    const stat = fs.statSync(p)
    return stat.size > 10 * 1024 * 1024 // Model zip must be at least 10MB
  } catch {
    return false
  }
}

/** Get model status for a language */
export function getModelStatus(language: string): { downloaded: boolean; path: string } {
  return {
    downloaded: isModelDownloaded(language),
    path: modelPath(language),
  }
}

/**
 * Download and extract a Vosk model for the given language.
 * Emits progress via mainEventBus.
 */
export async function downloadModel(language: string): Promise<void> {
  const primaryUrl = MODEL_URLS[language]
  const fallbackUrl = MODEL_FALLBACK_URLS[language]
  if (!primaryUrl && !fallbackUrl) {
    throw new Error(`No Vosk model available for language: ${language}`)
  }

  const root = modelsRoot()
  fs.mkdirSync(root, { recursive: true })

  const zipPath = path.join(root, `${language}.zip`)
  const tmpPath = path.join(root, `${language}.zip.tmp`)

  mainEventBus.emit('stt:model-status', { downloaded: false, progress: 0 })

  const tryDownload = async (url: string) => {
    log.info(`Downloading Vosk model for '${language}' from ${url}`)
    await downloadFile(url, tmpPath, (progress) => {
      mainEventBus.emit('stt:model-status', { downloaded: false, progress })
    })
  }

  try {
    try {
      await tryDownload(primaryUrl || fallbackUrl!)
    } catch (primaryErr) {
      if (fallbackUrl && fallbackUrl !== primaryUrl) {
        log.warn(`Primary download failed for '${language}', attempting fallback mirror:`, primaryErr)
        await tryDownload(fallbackUrl)
      } else {
        throw primaryErr
      }
    }

    // Verify downloaded size
    const stat = fs.statSync(tmpPath)
    if (stat.size < 10 * 1024 * 1024) {
      throw new Error(`Downloaded model file is too small or incomplete (${stat.size} bytes)`)
    }

    // Atomically replace target zip
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath)
    }
    fs.renameSync(tmpPath, zipPath)

    // Extract zip (for local directory usage if needed)
    try {
      log.info('Extracting model...')
      mainEventBus.emit('stt:model-status', { downloaded: false, progress: 95 })
      await extractZip(zipPath, root, language)
    } catch (extractErr) {
      log.warn('Folder extraction skipped or failed (vosk-browser loads zip directly):', extractErr)
    }

    mainEventBus.emit('stt:model-status', { downloaded: true, progress: 100 })
    log.info(`Model for '${language}' ready at ${zipPath}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    mainEventBus.emit('stt:model-status', { downloaded: false, error: message })
    throw err
  }
}

/**
 * Human-readable language labels.
 */
const LANG_LABELS: Record<string, string> = {
  en: 'English', 'en-in': 'English (India)',
  ru: 'Russian', cn: 'Chinese', de: 'German', fr: 'French',
  es: 'Spanish', pt: 'Portuguese', tr: 'Turkish', vn: 'Vietnamese',
  it: 'Italian', nl: 'Dutch', ca: 'Catalan', uk: 'Ukrainian',
  kz: 'Kazakh', sv: 'Swedish', ja: 'Japanese', eo: 'Esperanto',
  hi: 'Hindi', cs: 'Czech', pl: 'Polish', uz: 'Uzbek',
  ko: 'Korean', fa: 'Persian', gu: 'Gujarati', tg: 'Tajik',
  te: 'Telugu', ky: 'Kyrgyz', ar: 'Arabic',
}

/** Available languages with labels */
export function availableLanguages(): { code: string; label: string }[] {
  return Object.keys(MODEL_URLS).map((code) => ({
    code,
    label: LANG_LABELS[code] || code.toUpperCase(),
  }))
}

// ── Helpers ──

function downloadFile(
  url: string,
  dest: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let redirectCount = 0
    const maxRedirects = 5

    const doRequest = (reqUrl: string) => {
      let existingSize = 0
      if (fs.existsSync(dest)) {
        try {
          existingSize = fs.statSync(dest).size
        } catch {
          existingSize = 0
        }
      }

      const parsedUrl = new URL(reqUrl)
      const client = parsedUrl.protocol === 'https:' ? https : http

      const headers: Record<string, string> = {
        'User-Agent': 'EVA-01-ModelManager/1.0',
      }
      if (existingSize > 0) {
        headers['Range'] = `bytes=${existingSize}-`
      }

      const req = client.get(reqUrl, { headers }, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (++redirectCount > maxRedirects) {
            reject(new Error('Too many redirects'))
            return
          }
          const nextUrl = new URL(res.headers.location, reqUrl).toString()
          doRequest(nextUrl)
          return
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`))
          return
        }

        const isPartial = res.statusCode === 206
        const total = isPartial
          ? (parseInt(res.headers['content-range']?.split('/')[1] || '0', 10) || (parseInt(res.headers['content-length'] || '0', 10) + existingSize))
          : parseInt(res.headers['content-length'] || '0', 10)

        let received = isPartial ? existingSize : 0
        const file = createWriteStream(dest, { flags: isPartial ? 'a' : 'w' })

        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (total > 0) {
            onProgress(Math.round((received / total) * 90)) // 0–90% for download
          }
        })

        pipeline(res, file).then(resolve).catch(reject)
      })

      req.on('error', reject)
    }

    doRequest(url)
  })
}

async function extractZip(zipPath: string, destDir: string, language: string): Promise<void> {
  // Use Node.js built-in zlib + tar-like extraction via `adm-zip` or child_process
  // For simplicity, use the `extract-zip` approach via child_process (available on all platforms)
  const { exec } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execAsync = promisify(exec)

  const targetDir = path.join(destDir, language)
  fs.mkdirSync(targetDir, { recursive: true })

  if (process.platform === 'win32') {
    // PowerShell Expand-Archive
    await execAsync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force"`,
    )
  } else {
    await execAsync(`unzip -o "${zipPath}" -d "${targetDir}"`)
  }

  // Vosk archives often have a nested directory — flatten if needed
  const entries = fs.readdirSync(targetDir)
  if (entries.length === 1) {
    const nested = path.join(targetDir, entries[0])
    if (fs.statSync(nested).isDirectory()) {
      // Move contents up
      for (const item of fs.readdirSync(nested)) {
        fs.renameSync(path.join(nested, item), path.join(targetDir, item))
      }
      fs.rmdirSync(nested)
    }
  }
}
