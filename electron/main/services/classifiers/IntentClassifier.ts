import * as z from 'zod'
import { BaseClassifier } from './BaseClassifier'
import { IntelligenceService } from '@electron/services/intelligence/IntelligenceService'
import { PromptLoader } from '@electron/services/intelligence/PromptLoader'
import { IntentClassificationSchema } from '@electron/services/agent/schemas'
import { createLogger } from '@electron/utils/logger'

const log = createLogger('IntentClassifier')

/** Pre-computed JSON schema for structured output */
const intentJsonSchema = z.toJSONSchema(IntentClassificationSchema) as Record<string, unknown>

export interface IntentInput {
  command: string
  /** Recent conversation history for context-aware classification */
  recentHistory?: Array<{ role: string; text: string }>
}

/** Intent classification result */
export type IntentResult = 'chat' | 'direct' | 'action'

/**
 * IntentClassifier — determines how to handle a user command.
 *
 * Three categories:
 * - `chat`   — conversational, no OS interaction needed
 * - `direct` — simple OS action via shell command or hotkey (no screenshot needed)
 * - `action` — needs screen interaction (clicking, reading, navigating GUI)
 *
 * Uses structured output with `IntentClassificationSchema` for reliable 3-way
 * classification in a single LLM call.
 */
export class IntentClassifier extends BaseClassifier<IntentInput, IntentResult> {
  readonly name = 'intent'

  private intelligence: IntelligenceService
  private promptLoader: PromptLoader

  constructor(intelligence: IntelligenceService, promptLoader: PromptLoader) {
    super()
    this.intelligence = intelligence
    this.promptLoader = promptLoader
  }

  /**
   * Classify the user command into one of three categories.
   *
   * Fast-path heuristics run first (0ms latency).
   * Falls back to structured LLM classification with a safety timeout.
   */
  async classify(input: IntentInput): Promise<IntentResult> {
    const cmd = input.command.toLowerCase().trim()

    // ── 1. Fast-Path Heuristics (0ms instant classification) ──

    // Desktop perception queries & structured state (0ms fast path → DIRECT)
    const desktopStatePatterns = [
      /^(?:what|which)\s+(?:windows|apps|applications)\s+(?:are\s+)?(?:currently\s+)?(?:open|running)/i,
      /^(?:list|show|get)\s+(?:all\s+)?(?:open\s+)?(?:windows|apps|applications)/i,
      /^(?:what|which)\s+(?:is\s+)?(?:the\s+)?(?:active|foreground|current)\s+(?:window|app|application)/i,
      /^(?:what|which)\s+(?:apps|items|icons)\s+(?:are\s+)?(?:on\s+)?(?:the\s+|my\s+)?taskbar/i,
      /^(?:what(?:'s| is)|show)\s+(?:on\s+)?(?:the\s+|my\s+)?taskbar/i,
      /^(?:tell me about|what(?:'s| is) on|describe|overview of)\s+(?:my\s+|the\s+)?screen/i,
      /^(?:please\s+)?(?:click|open|launch|focus|switch to)\s+.+\s+(?:on|from)\s+(?:the\s+)?taskbar/i,
      /^(?:please\s+)?(?:switch to|focus|bring up)\s+/i,
    ]
    if (desktopStatePatterns.some((pattern) => pattern.test(cmd))) {
      log.info(`"${input.command}" → DIRECT (desktop-state fast-path 0ms)`)
      return 'direct'
    }

    // Obvious direct OS & search actions
    const directPatterns = [
      /^(?:please\s+)?(?:open|launch|start|run)\s+/i,
      /^(?:please\s+)?(?:search|google|look up|find)\s+/i,
      /^(?:please\s+)?(?:close|quit|exit|kill|stop)\s+/i,
      /^(?:please\s+)?(?:mute|unmute|volume\s*(?:up|down|\d+)?)/i,
      /^(?:please\s+)?(?:minimize|maximize|restore|show desktop)/i,
      /^(?:please\s+)?(?:what(?:'s| is) the time|what time is it|time now)/i,
      /^(?:please\s+)?(?:what(?:'s| is) the weather|weather in)/i,
      /^(?:please\s+)?(?:create folder|delete file|remove file|copy file|make directory)/i,
    ]
    if (directPatterns.some((pattern) => pattern.test(cmd))) {
      log.info(`"${input.command}" → DIRECT (fast-path 0ms)`)
      return 'direct'
    }

    // Obvious GUI & screen-interaction actions
    const actionPatterns = [
      /^(?:please\s+)?(?:click|double[- ]click|right[- ]click)\b/i,
      /^(?:please\s+)?(?:scroll\s+(?:down|up|left|right))\b/i,
      /^(?:please\s+)?(?:read|check|inspect)\s+(?:the\s+)?screen\b/i,
      /^(?:please\s+)?(?:type|write)\s+.+\s+(?:in|into|on)\s+/i,
    ]
    if (actionPatterns.some((pattern) => pattern.test(cmd))) {
      log.info(`"${input.command}" → ACTION (fast-path 0ms)`)
      return 'action'
    }

    // Obvious greetings & basic conversational banter
    const chatPatterns = [
      /^(?:hi|hello|hey|yo|howdy|good morning|good evening|good afternoon)\b/i,
      /^(?:how are you|how's it going|who are you|what are you|what is your name)\b/i,
      /^(?:thank you|thanks|thanks a lot|bye|goodbye|see you)\b/i,
    ]
    if (chatPatterns.some((pattern) => pattern.test(cmd))) {
      log.info(`"${input.command}" → CHAT (fast-path 0ms)`)
      return 'chat'
    }

    // ── 2. LLM Classification with 6-second timeout ──
    try {
      // Build context from recent history (last 4 messages)
      let contextBlock = ''
      if (input.recentHistory && input.recentHistory.length > 0) {
        const recent = input.recentHistory.slice(-4)
        const lines = recent.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 200)}`)
        contextBlock = `\n\nRecent conversation:\n${lines.join('\n')}\n`
      }

      const prompt = this.promptLoader.load('intent_classifier', {
        context: contextBlock,
        command: input.command,
      })

      // Timeout wrapper to prevent local LLMs from hanging the UI
      const classificationPromise = this.intelligence.classifyStructured(
        prompt,
        intentJsonSchema,
      )

      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Classification timeout (6000ms)')), 6000)
      )

      const response = await Promise.race([classificationPromise, timeoutPromise])
      const parsed = IntentClassificationSchema.parse(JSON.parse(response))
      const result = parsed.intent
      log.info(`"${input.command}" → ${result.toUpperCase()} (LLM evaluated)`)
      return result
    } catch (err) {
      log.warn('LLM classification slow or failed, falling back to direct mode:', err)
      // When unsure, default to direct mode to handle OS commands
      return 'direct'
    }
  }
}
