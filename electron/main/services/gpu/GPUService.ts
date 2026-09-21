import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { BaseService } from '@electron/services/base/BaseService'

const execAsync = promisify(exec)

export interface GPUInfoItem {
  name: string
  adapterRAM?: number
  vramMB?: number
  driverVersion?: string
  vendor?: string
  isDedicated?: boolean
}

export interface GPUReport {
  gpus: GPUInfoItem[]
  activeGPU: string
  isAccelerated: boolean
  vramTotalMB: number
  recommendedLocalLLM: string
  features: Record<string, string>
}

/**
 * GPUService — detects graphics hardware, monitors VRAM, and optimizes local AI inference.
 * Optimized with fast direct nvidia-smi probing to eliminate PowerShell CIM timeouts.
 */
export class GPUService extends BaseService {
  private cachedReport: GPUReport | null = null
  private lastQueried = 0
  private readonly CACHE_TTL_MS = 30_000 // 30s cache

  async init(): Promise<void> {
    this.log.info('GPUService initializing...')
    await this.detectGPU()
    this.log.info(`Active GPU: ${this.cachedReport?.activeGPU || 'Integrated/CPU'} (${this.cachedReport?.vramTotalMB || 0} MB VRAM)`)
  }

  async dispose(): Promise<void> {
    this.cachedReport = null
    this.log.info('GPUService disposed')
  }

  /**
   * Returns complete GPU report (cached with TTL).
   */
  async getGPUReport(): Promise<GPUReport> {
    if (this.cachedReport && Date.now() - this.lastQueried < this.CACHE_TTL_MS) {
      return this.cachedReport
    }
    return this.detectGPU()
  }

  /**
   * Fast real-time VRAM probe for telemetry and diagnostics.
   */
  async getRealtimeVRAM(): Promise<{ totalMB: number; usedMB: number; freeMB: number }> {
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync(
          'nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader,nounits',
          { timeout: 1500 }
        )
        const parts = stdout.trim().split(',').map((p) => parseInt(p.trim(), 10))
        if (parts.length >= 3 && !isNaN(parts[0])) {
          return {
            totalMB: parts[0],
            usedMB: parts[1],
            freeMB: parts[2],
          }
        }
      } catch {
        // Ignored
      }
    }

    const total = this.cachedReport?.vramTotalMB || 4096
    return { totalMB: total, usedMB: 0, freeMB: total }
  }

  private async detectGPU(): Promise<GPUReport> {
    const gpus: GPUInfoItem[] = []
    let activeGPU = 'Default Graphics'
    let vramTotalMB = 0
    let detectedViaNvidiaSmi = false

    // 1. Fast path: Direct nvidia-smi probe on Windows / Linux (50-100ms, avoids PowerShell timeout)
    try {
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits',
        { timeout: 2000 }
      )
      const lines = stdout.trim().split('\n').filter(Boolean)
      for (const line of lines) {
        const [name, memStr, driver] = line.split(',').map((s) => s.trim())
        const vram = parseInt(memStr, 10) || 0
        if (name) {
          gpus.push({
            name,
            vramMB: vram,
            driverVersion: driver || '',
            vendor: 'NVIDIA',
            isDedicated: true,
          })
          if (vram > vramTotalMB) {
            vramTotalMB = vram
            activeGPU = name
          }
          detectedViaNvidiaSmi = true
        }
      }
    } catch {
      // nvidia-smi not present or not an NVIDIA system
    }

    // 2. Fallback: Query Windows CIM / WMI if nvidia-smi was not available
    if (!detectedViaNvidiaSmi && process.platform === 'win32') {
      try {
        const { stdout } = await execAsync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion | ConvertTo-Json"',
          { timeout: 8000 }
        )
        const parsed = JSON.parse(stdout.trim())
        const controllers = Array.isArray(parsed) ? parsed : [parsed]

        for (const c of controllers) {
          if (!c.Name) continue
          const rawRam = Number(c.AdapterRAM) || 0
          const vramMB = rawRam > 0 ? Math.round(rawRam / (1024 * 1024)) : 0
          const isDedicated = /nvidia|geforce|rtx|gtx|radeon|rx\s|arc\s/i.test(c.Name)

          gpus.push({
            name: c.Name,
            adapterRAM: rawRam,
            vramMB,
            driverVersion: c.DriverVersion || '',
            vendor: /nvidia/i.test(c.Name) ? 'NVIDIA' : /amd|radeon/i.test(c.Name) ? 'AMD' : /intel/i.test(c.Name) ? 'Intel' : 'Unknown',
            isDedicated,
          })

          if (isDedicated && vramMB > vramTotalMB) {
            vramTotalMB = vramMB
            activeGPU = c.Name
          }
        }
      } catch (err) {
        this.log.debug('CIM query skipped or failed, falling back to Electron GPU info:', err)
      }
    }

    // 3. Query Electron GPU feature status
    let features: Record<string, string> = {}
    let isAccelerated = true
    try {
      features = (app.getGPUFeatureStatus() as unknown) as Record<string, string>
      isAccelerated = features['gpu_compositing'] === 'enabled' || features['2d_canvas'] === 'enabled'
    } catch {
      // Ignored
    }

    // 4. Fallback to Electron getGPUInfo if still empty
    if (gpus.length === 0) {
      try {
        const info = (await app.getGPUInfo('basic')) as {
          gpuDevice?: Array<{ deviceName?: string; vendorId?: number }>
        }
        if (info.gpuDevice && Array.isArray(info.gpuDevice)) {
          for (const dev of info.gpuDevice) {
            if (dev.deviceName) {
              gpus.push({
                name: dev.deviceName,
                isDedicated: /nvidia|geforce|radeon/i.test(dev.deviceName),
              })
              if (!activeGPU || activeGPU === 'Default Graphics') {
                activeGPU = dev.deviceName
              }
            }
          }
        }
      } catch {
        // Ignored
      }
    }

    if (gpus.length > 0 && activeGPU === 'Default Graphics') {
      const dedicated = gpus.find((g) => g.isDedicated)
      activeGPU = dedicated ? dedicated.name : gpus[0].name
      if (dedicated?.vramMB) vramTotalMB = dedicated.vramMB
    }

    // Calculate local LLM recommendation specifically tailored for hardware
    let recommendedLocalLLM = 'CPU Mode: 1B - 3B quantized models (e.g. qwen2.5:1.5b)'
    if (vramTotalMB >= 16000) {
      recommendedLocalLLM = 'High-End GPU: Full offload up to 14B - 32B Q4 models'
    } else if (vramTotalMB >= 8000) {
      recommendedLocalLLM = 'Fast GPU: Full offload for 7B - 8B Q4 models (e.g. qwen2.5vl:7b)'
    } else if (vramTotalMB >= 3500) {
      recommendedLocalLLM = 'Dedicated 4GB GPU: Recommended for 3B - 4B Q4 multimodal models (e.g. qwen2.5vl:3b)'
    } else if (vramTotalMB >= 2000) {
      recommendedLocalLLM = 'Entry GPU: Recommended for 1B - 2B models with partial offload'
    }

    this.cachedReport = {
      gpus,
      activeGPU,
      isAccelerated,
      vramTotalMB,
      recommendedLocalLLM,
      features,
    }
    this.lastQueried = Date.now()
    return this.cachedReport
  }
}
