import screenshot from 'screenshot-desktop'
import { nativeImage, screen, BrowserWindow, app } from 'electron'
import { createLogger } from '@electron/utils/logger'
import { getConfig } from '@electron/utils/config'
import { getWindowDisplay } from '@electron/WindowManager'

const log = createLogger('ScreenCapture')

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * ScreenCapture — wraps `screenshot-desktop` to capture the screen.
 *
 * Optimized for low-resource machines (4GB VRAM):
 * - Captures at native resolution, then resizes to MAX_WIDTH and compresses
 *   to JPEG for efficient local model token usage.
 * - Perceptual hash change detection avoids redundant vision analysis when
 *   the screen content has not changed.
 * - Active-window cropping captures only the relevant region for local inference.
 */
export class ScreenCapture {
  private lastHashHex: string | null = null
  private lastAnalysisResult: string | null = null
  private lastHashTimestampMs = 0

  /** Max age for a cached screen analysis to be reused (ms). */
  private readonly CACHE_MAX_AGE_MS = 3000

  /**
   * Capture the display the Atlas window is on, optimized for LLM.
   *
   * @param format — 'jpeg' (default, smaller) or 'png' (required by Computer Use API)
   * @returns Resized buffer in the requested format.
   */
  async captureFullScreen(format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
    log.debug('Capturing full screen...')

    const screenId = await this.resolveDisplayId()

    let img: Buffer | string
    if (screenId) {
      log.debug(`Targeting display: ${screenId}`)
      img = await screenshot({ format: 'png', screen: screenId })
    } else {
      img = await screenshot({ format: 'png' })
    }

    const raw = Buffer.isBuffer(img) ? img : Buffer.from(img)
    log.debug(`Raw screenshot: ${raw.length} bytes`)

    const optimized = format === 'png' ? this.optimizePng(raw) : this.optimize(raw)
    log.info(`Screenshot captured: ${raw.length} → ${optimized.length} bytes (${Math.round(optimized.length / 1024)}KB)`)
    return optimized
  }

  /**
   * Capture with perceptual change detection.
   *
   * Returns { buffer, changed, cached } where:
   * - `changed = false` means screen content is visually identical to last capture
   * - `cached` contains the previous analysis result if available and fresh
   */
  async captureWithChangeDetection(): Promise<{
    buffer: Buffer
    changed: boolean
    cachedAnalysis: string | null
  }> {
    const raw = await this.captureRaw()
    const hashHex = this.computePerceptualHash(raw)

    const isSame = this.lastHashHex === hashHex
    const isStale = Date.now() - this.lastHashTimestampMs > this.CACHE_MAX_AGE_MS

    if (isSame && !isStale && this.lastAnalysisResult) {
      log.debug('Screen unchanged (perceptual hash match) — reusing cached analysis')
      return {
        buffer: this.optimize(raw),
        changed: false,
        cachedAnalysis: this.lastAnalysisResult,
      }
    }

    this.lastHashHex = hashHex
    this.lastHashTimestampMs = Date.now()
    this.lastAnalysisResult = null

    return {
      buffer: this.optimize(raw),
      changed: true,
      cachedAnalysis: null,
    }
  }

  /**
   * Cache the result of a vision analysis so it can be reused for identical screens.
   */
  cacheAnalysisResult(result: string): void {
    this.lastAnalysisResult = result
    this.lastHashTimestampMs = Date.now()
  }

  /**
   * Capture only the active/focused window region for more targeted local inference.
   * Falls back to full screen if no focused window is detected.
   */
  async captureActiveWindow(): Promise<Buffer> {
    try {
      // Get the position of the focused (foreground) window via Electron
      const windows = BrowserWindow.getAllWindows()
      const focusedWindow = windows.find((w) => w.isFocused())
      if (focusedWindow) {
        const bounds = focusedWindow.getBounds()
        return this.captureRegion(bounds)
      }
    } catch (err: any) {
      log.debug('Could not get focused window bounds, falling back to full screen:', err?.message)
    }
    return this.captureFullScreen()
  }

  /**
   * Capture a specific screen region (x, y, width, height).
   * Useful for cropping to the relevant application window area.
   */
  async captureRegion(rect: Rect): Promise<Buffer> {
    const raw = await this.captureRaw()
    const image = nativeImage.createFromBuffer(raw)
    const { width: fullW, height: fullH } = image.getSize()

    // Clamp rect to screen bounds
    const x = Math.max(0, Math.min(rect.x, fullW))
    const y = Math.max(0, Math.min(rect.y, fullH))
    const w = Math.min(rect.width, fullW - x)
    const h = Math.min(rect.height, fullH - y)

    if (w <= 0 || h <= 0) {
      return this.optimize(raw)
    }

    const cropped = image.crop({ x, y, width: w, height: h })
    const croppedPng = cropped.toPNG()
    return this.optimize(croppedPng)
  }

  /**
   * List available displays (for multi-monitor setups).
   */
  async listDisplays(): Promise<Array<{ id: string; name: string }>> {
    const displays = await screenshot.listDisplays()
    return displays.map((d: { id: string | number; name?: string }) => ({
      id: String(d.id),
      name: d.name ?? `Display ${d.id}`,
    }))
  }

  /**
   * Capture a specific display by ID (optimized).
   */
  async captureDisplay(displayId: string): Promise<Buffer> {
    log.debug(`Capturing display: ${displayId}`)
    const img = await screenshot({ screen: displayId, format: 'png' })
    const raw = Buffer.isBuffer(img) ? img : Buffer.from(img)
    const optimized = this.optimize(raw)
    log.info(`Display ${displayId}: ${raw.length} → ${optimized.length} bytes`)
    return optimized
  }

  /**
   * Capture raw PNG (no optimization applied).
   */
  private async captureRaw(): Promise<Buffer> {
    const screenId = await this.resolveDisplayId()
    let img: Buffer | string
    if (screenId) {
      img = await screenshot({ format: 'png', screen: screenId })
    } else {
      img = await screenshot({ format: 'png' })
    }
    return Buffer.isBuffer(img) ? img : Buffer.from(img)
  }

  /**
   * Compute a simple perceptual hash from a PNG buffer.
   * Downsamples to 8x8 luminance grid and encodes as 64-bit hex string.
   * Fast enough to run on every capture (~1ms).
   */
  private computePerceptualHash(pngBuffer: Buffer): string {
    try {
      const image = nativeImage.createFromBuffer(pngBuffer)
      // Downsample to 8x8 for hash
      const small = image.resize({ width: 8, height: 8 })
      const data = small.getBitmap()

      // Convert to grayscale and threshold against mean
      const grays: number[] = []
      for (let i = 0; i < data.length; i += 4) {
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        grays.push(lum)
      }
      const mean = grays.reduce((a, b) => a + b, 0) / grays.length
      const bits = grays.map((g) => (g >= mean ? 1 : 0))

      // Pack bits into hex
      let hex = ''
      for (let i = 0; i < bits.length; i += 4) {
        const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]
        hex += nibble.toString(16)
      }
      return hex
    } catch {
      return Date.now().toString(16)
    }
  }

  /**
   * Match the Atlas window's display to a screenshot-desktop display ID.
   */
  private async resolveDisplayId(): Promise<string | undefined> {
    try {
      const windowDisplay = getWindowDisplay()
      const displays: any[] = await screenshot.listDisplays()

      if (!displays || displays.length <= 1) return undefined

      const matched = displays.find(
        (d) => d.left === windowDisplay.bounds.x && d.top === windowDisplay.bounds.y,
      )

      if (matched) return String(matched.id)

      log.warn('Could not match window display to screenshot display, using default')
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Resize + compress a screenshot for LLM consumption.
   * For local Ollama models: uses a more conservative 1024px width to reduce
   * vision encoder token count from ~1500 to ~300, saving significant VRAM.
   */
  private optimize(pngBuffer: Buffer): Buffer {
    const image = nativeImage.createFromBuffer(pngBuffer)
    const { width, height } = image.getSize()
    const config = getConfig()
    const isOllamaProvider = config.llm.provider === 'ollama'

    // Smaller default for local inference to reduce vision token load
    const maxWidth = isOllamaProvider
      ? Math.min(config.agent.screenshotMaxWidth, 1024)
      : config.agent.screenshotMaxWidth

    // Lower quality for local models — still clearly legible at 70-75%
    const quality = isOllamaProvider
      ? Math.min(config.agent.screenshotQuality, 75)
      : config.agent.screenshotQuality

    if (width <= maxWidth) {
      return image.toJPEG(quality)
    }

    const scale = maxWidth / width
    const newWidth = maxWidth
    const newHeight = Math.round(height * scale)

    const resized = image.resize({ width: newWidth, height: newHeight, quality: 'good' })
    return resized.toJPEG(quality)
  }

  /**
   * Resize a screenshot but keep PNG format (required by Computer Use API).
   */
  private optimizePng(pngBuffer: Buffer): Buffer {
    const image = nativeImage.createFromBuffer(pngBuffer)
    const { width, height } = image.getSize()
    const { screenshotMaxWidth } = getConfig().agent

    if (width <= screenshotMaxWidth) {
      return image.toPNG()
    }

    const scale = screenshotMaxWidth / width
    const newWidth = screenshotMaxWidth
    const newHeight = Math.round(height * scale)

    const resized = image.resize({ width: newWidth, height: newHeight, quality: 'good' })
    return resized.toPNG()
  }
}
