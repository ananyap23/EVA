import screenshot from 'screenshot-desktop'
import { nativeImage } from 'electron'
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
 * Captures at native resolution, then resizes to MAX_WIDTH and
 * compresses to JPEG for efficient LLM API usage.
 * 2560x1440 PNG (~3MB) → 1280x720 JPEG (~150-300KB)
 */
export class ScreenCapture {
  /**
   * Capture the display the Atlas window is on, optimized for LLM.
   *
   * @param format — 'jpeg' (default, smaller) or 'png' (required by Computer Use API)
   * @returns Resized buffer in the requested format.
   */
  async captureFullScreen(format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
    log.debug('Capturing full screen...')

    // Determine which screenshot-desktop display matches the Atlas window
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
   * Match the Atlas window's display to a screenshot-desktop display ID.
   * Returns the display ID string (e.g. `\\.\DISPLAY2`) or undefined to use default.
   */
  private async resolveDisplayId(): Promise<string | undefined> {
    try {
      const windowDisplay = getWindowDisplay()
      const displays: any[] = await screenshot.listDisplays()

      if (!displays || displays.length <= 1) return undefined

      // Match by bounds: screenshot-desktop provides left/top for each display
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
   * Resize + compress a screenshot for LLM consumption.
   *
   * Uses Electron's nativeImage (no extra dependencies):
   * 1. Resize to MAX_WIDTH (aspect ratio preserved)
   * 2. Encode as JPEG at JPEG_QUALITY
   */
  private optimize(pngBuffer: Buffer): Buffer {
    const image = nativeImage.createFromBuffer(pngBuffer)
    const { width, height } = image.getSize()
    const { screenshotMaxWidth, screenshotQuality } = getConfig().agent

    if (width <= screenshotMaxWidth) {
      // Already small enough — just compress to JPEG
      return image.toJPEG(screenshotQuality)
    }

    // Resize maintaining aspect ratio
    const scale = screenshotMaxWidth / width
    const newWidth = screenshotMaxWidth
    const newHeight = Math.round(height * scale)

    const resized = image.resize({ width: newWidth, height: newHeight, quality: 'good' })
    return resized.toJPEG(screenshotQuality)
  }

  /**
   * Resize a screenshot but keep PNG format.
   *
   * Required by the Gemini Computer Use API which mandates `image/png`
   * in function response inline_data. Larger than JPEG but API-compliant.
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
