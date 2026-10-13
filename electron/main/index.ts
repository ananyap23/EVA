import * as path from 'node:path'
import { app, BrowserWindow, protocol, net } from 'electron'
import { ServiceRegistry } from './services/ServiceRegistry'
import { IntelligenceService } from './services/intelligence/IntelligenceService'
import { TTSService } from './services/tts/TTSService'
import { AgentService } from './services/agent/AgentService'
import { HotkeyService } from './services/hotkey/HotkeyService'
import { PersonaService } from './services/persona/PersonaService'
import { MemoryService } from './services/memory/MemoryService'
import { FactService } from './services/memory/FactService'
import { VisionService } from './services/vision/VisionService'
import { MotorService } from './services/motor/MotorService'
import { SearchService } from './services/search/SearchService'
import { STTService } from './services/stt/STTService'
import { GPUService } from './services/gpu/GPUService'
import { setPersonaService } from './api/routers/personas.router'
import { setMemoryService } from './api/routers/memory.router'
import { setFactService } from './api/routers/facts.router'
import { setAgentService } from './api/routers/agent.router'
import { setSTTService } from './api/routers/audio.router'
import { setGPUService } from './api/routers/system.router'
import { createLogger } from './utils/logger'
import { loadConfig } from './utils/config'
import { mainEventBus } from './utils/eventBus'
import { createWindow, toggleWindow, clearWindow, isSettingsActive } from './WindowManager'
import { createTray } from './TrayManager'

// Side-effect: sets process.env paths on import
import './utils/paths'

const log = createLogger('Main')

// ── Hardware Acceleration & GPU Flags ──
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

// ── Platform Setup ──

if (process.platform === 'win32') app.setAppUserModelId('com.dortanes.eva01')

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

import * as fs from 'node:fs'
import { pathToFileURL } from 'node:url'

// Register custom protocol for serving STT model files to renderer
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'stt-model',
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

// ── Service Registry ──

const services = new ServiceRegistry()

// ── App Lifecycle ──

app.whenReady().then(async () => {
  log.info('EVA-01 starting...')

  loadConfig()

  // Serve STT model files to renderer via custom protocol (file:// is blocked)
  // URL format: stt-model://en.zip → {userData}/Models/stt/en.zip
  const sttModelsDir = path.join(app.getPath('userData'), 'Models', 'stt')
  protocol.handle('stt-model', async (req) => {
    let relative = ''
    try {
      const parsed = new URL(req.url)
      relative = decodeURIComponent(parsed.pathname ? parsed.pathname.replace(/^\/+/, '') : parsed.host)
      if (!relative || relative === '/') {
        relative = decodeURIComponent(parsed.host)
      }
    } catch {
      relative = decodeURIComponent(req.url.replace(/^stt-model:\/\//, '').replace(/^\/+/, ''))
    }

    const filePath = path.join(sttModelsDir, relative)
    log.info(`[stt-model] Handling request for: ${req.url} -> ${filePath}`)
    if (!fs.existsSync(filePath)) {
      log.warn(`[stt-model] Model file not found on disk: ${filePath}`)
      return new Response('STT Model file not found', {
        status: 404,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      })
    }

    try {
      const res = await net.fetch(pathToFileURL(filePath).toString())
      const headers = new Headers(res.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      headers.set('Access-Control-Allow-Headers', '*')
      headers.set('Access-Control-Expose-Headers', '*')
      headers.set('Content-Type', 'application/zip')
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    } catch (fetchErr) {
      log.warn(`[stt-model] net.fetch fallback to file stream for ${filePath}:`, fetchErr)
      const fileBuffer = fs.readFileSync(filePath)
      return new Response(fileBuffer, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Expose-Headers': '*',
          'Content-Type': 'application/zip',
          'Content-Length': String(fileBuffer.length),
        },
      })
    }
  })

  // Register services (order matters: dependencies first)
  const intelligence = new IntelligenceService()
  const persona = new PersonaService()
  const memory = new MemoryService()
  const facts = new FactService()
  const tts = new TTSService()
  const vision = new VisionService(intelligence)
  const motor = new MotorService()
  const searchService = new SearchService()
  const stt = new STTService()

  // Wire cross-service dependencies
  persona.setMemoryService(memory)
  persona.setFactService(facts)
  tts.setPersonaService(persona)

  services.register('intelligence', intelligence)
  services.register('tts', tts)
  services.register('persona', persona)
  services.register('memory', memory)
  services.register('facts', facts)
  services.register('vision', vision)
  services.register('motor', motor)
  services.register('search', searchService)
  const gpuService = new GPUService()
  services.register('gpu', gpuService)
  setGPUService(gpuService)

  const agent = new AgentService(intelligence, persona, memory, facts, vision, motor, searchService)
  services.register('agent', agent)
  services.register('hotkey', new HotkeyService())

  // Wire services into tRPC routers
  setPersonaService(persona)
  setMemoryService(memory)
  setFactService(facts)
  setAgentService(agent)
  setSTTService(stt)

  await services.initAll()
  await createWindow()
  createTray(persona)

  // Defer STT pre-warm so main thread & initial tRPC IPC boot with 0 delay
  setTimeout(() => {
    stt.prewarm().catch((err) => log.warn('STT pre-warm warning:', err))
  }, 8000)

  // Global hotkey → toggle window visibility
  mainEventBus.on('hotkey:toggle-eva-01', () => { if (!isSettingsActive()) toggleWindow() })

  log.info('EVA-01 ready')
})

app.on('window-all-closed', () => {
  clearWindow()
  if (process.platform !== 'darwin') app.quit()
})

app.on('second-instance', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    const main = allWindows[0]
    if (main.isMinimized()) main.restore()
    main.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

app.on('before-quit', async () => {
  log.info('Shutting down services...')
  await services.disposeAll()
})


