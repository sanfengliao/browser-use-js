import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessageChunk, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { config } from 'dotenv'
import { RateLimitError } from 'openai'
import { Browser, BrowserContext, Page } from 'playwright'
import { z } from 'zod'

import { BrowserProfile } from '@/browser/profile'
import { BrowserSession, DEFAULT_BROWSER_PROFILE } from '@/browser/session'
import { BrowserStateHistory, BrowserStateSummary } from '@/browser/views'
import { ActionModel, ActionPayload, ExecuteActions } from '@/controller/registry/view'
import { Controller } from '@/controller/service'
import { HistoryTreeProcessor } from '@/dom/history_tree_processor/service'
import { DOMHistoryElement } from '@/dom/history_tree_processor/view'
import { LLMException } from '@/error'
import { Logger } from '@/logger'
import { ProductTelemetry } from '@/telemetry/service'
import { AgentTelemetryEvent } from '@/telemetry/view'
import { isSubset, SignalHandler, sleep, timeExecutionAsync } from '@/utils'
import { createHistoryGif } from './gif'
import { Memory } from './memory/service'
import { MemoryConfig } from './memory/views'
import { MessageManager } from './message_manager/service'
import { convertInputMessages, extractJsonFromModelOutput, isModelWithoutToolSupport, saveConversation } from './message_manager/utils'
import { AgentMessagePrompt, PlannerPrompt, SystemPrompt } from './prompt'
import { ActionResult, AgentBrain, AgentError, AgentHistory, AgentHistoryList, AgentOutput, AgentSettings, AgentState, AgentStepInfo, StepMetadata } from './views'

config()

export const SKIP_LLM_API_KEY_VERIFICATION = 'ty1'.includes((process.env.SKIP_LLM_API_KEY_VERIFICATION || 'false').charAt(0))

export type ToolCallingMethod = 'function_calling' | 'json_mode' | 'raw' | 'auto' | 'tools'
const logger = Logger.getLogger(import.meta.filename)

const REQUIRED_LLM_API_ENV_VARS = {
  ChatOpenAI: ['OPENAI_API_KEY'],
  AzureChatOpenAI: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY'],
  ChatBedrockConverse: ['ANTHROPIC_API_KEY'],
  ChatAnthropic: ['ANTHROPIC_API_KEY'],
  ChatGoogleGenerativeAI: ['GEMINI_API_KEY'],
  ChatDeepSeek: ['DEEPSEEK_API_KEY'],
  ChatOllama: [],
  ChatGrok: ['GROK_API_KEY'],
}

function logResponse(response: AgentOutput): void {
  let emoji = '🤷'

  if (response.currentState.evaluationPreviousGoal.includes('Success')) {
    emoji = '👍'
  } else if (response.currentState.evaluationPreviousGoal.includes('Failed')) {
    emoji = '⚠'
  }

  logger.info(`${emoji} Eval: ${response.currentState.evaluationPreviousGoal}`)
  logger.info(`🧠 Memory: ${response.currentState.memory}`)
  logger.info(`🎯 Next goal: ${response.currentState.nextGoal}`)

  for (let i = 0; i < response.action.length; i++) {
    logger.info(
      `🛠️  Action ${i + 1}/${response.action.length}: ${response.action[i].modelDumpJson({ excludeUnset: true })}`,
    )
  }
}

export type AgentHook = (agent: Agent) => Promise<void>

/**
 * Agent constructor parameters interface
 */
interface AgentParams<Context = any> {
  /** The task to be performed */
  task: string

  /** The language model to use */
  llm: BaseChatModel

  /** Optional browser instance */
  browser?: Browser

  /** Optional browser context */
  browserContext?: BrowserContext

  page?: Page
  browserProfile?: BrowserProfile

  browserSession?: BrowserSession

  /** Controller for browser actions */
  controller?: Controller<Context>

  /** Sensitive data to be used in browser operations */
  sensitiveData?: Record<string, string>

  /** Initial actions to execute before starting the agent */
  initialActions?: Array<Record<string, Record<string, any>>>

  /** Callback for registering new steps */
  registerNewStepCallback?: (
    state: BrowserStateSummary,
    output: AgentOutput,
    stepNumber: number
  ) => void | Promise<void>

  /** Callback when agent is done */
  registerDoneCallback?: (
    history: AgentHistoryList
  ) => void | Promise<void>

  /** Callback to check if agent should raise an error */
  registerExternalAgentStatusRaiseErrorCallback?: () => Promise<boolean>

  /** Whether to use vision capabilities */
  useVision?: boolean

  /** Whether to use vision for planner */
  useVisionForPlanner?: boolean

  /** Path to save conversation history */
  saveConversationPath?: string

  /** Encoding for saved conversations */
  saveConversationPathEncoding?: string

  /** Maximum number of allowed failures */
  maxFailures?: number

  /** Delay before retrying after a failure */
  retryDelay?: number

  /** Override the default system message */
  overrideSystemMessage?: string

  /** Text to extend the system message with */
  extendSystemMessage?: string

  /** Maximum number of input tokens */
  maxInputTokens?: number

  /** Whether to validate output */
  validateOutput?: boolean

  /** Additional message context */
  messageContext?: string

  /** Whether to generate a GIF of the browser session */
  generateGif?: boolean | string

  /** Available file paths for the agent to work with */
  availableFilePaths?: string[]

  /** Element attributes to include in descriptions */
  includeAttributes?: string[]

  /** Maximum number of actions per step */
  maxActionsPerStep?: number

  /** Method to use for tool calling */
  toolCallingMethod?: ToolCallingMethod

  /** Language model to use for page extraction */
  pageExtractionLlm?: BaseChatModel

  /** Language model to use for planning */
  plannerLlm?: BaseChatModel

  /** Interval between planner runs */
  plannerInterval?: number

  /** Whether planner should use reasoning */
  isPlannerReasoning?: boolean

  /** Text to extend the planner system message with */
  extendPlannerSystemMessage?: string

  /** Pre-initialized agent state */
  injectedAgentState?: AgentState

  /** Additional context to pass to controller */
  context?: Context

  /** Path to save generated Playwright script */
  savePlaywrightScriptPath?: string

  /** Whether to enable memory */
  enableMemory?: boolean

  /** Memory configuration */
  memoryConfig?: MemoryConfig

  /** Source of the agent for telemetry */
  source?: string
}

/**
 * Agent class for automating browser interactions using LLMs
 */
export class Agent<Context = any> {
  // Core components
  private task: string
  private llm: BaseChatModel
  private controller: Controller<Context>
  private sensitiveData?: Record<string, string>
  private settings: AgentSettings

  browserSession: BrowserSession

  // State management
  private state: AgentState
  private enableMemory: boolean
  private memoryConfig?: MemoryConfig
  private memory?: Memory

  // Action management
  private ActionModel!: typeof ActionModel // Type for dynamically created action model
  private AgentOutput!: typeof AgentOutput // Type for dynamically created output model
  private DoneActionModel!: typeof ActionModel
  private DoneAgentOutput!: typeof AgentOutput
  private unfilteredActions: string
  private initialActions: ExecuteActions[]

  // Model information
  private modelName!: string
  private plannerModelName?: string
  private chatModelLibrary!: string
  private toolCallingMethod?: ToolCallingMethod

  // Message management
  private messageManager!: MessageManager

  // Callbacks
  private registerNewStepCallback?: (
    state: BrowserStateSummary,
    output: AgentOutput,
    stepNumber: number
  ) => void | Promise<void>

  private registerDoneCallback?: (
    history: AgentHistoryList
  ) => void | Promise<void>

  private registerExternalAgentStatusRaiseErrorCallback?: () => Promise<boolean>

  // Context
  private context?: Context

  // Telemetry
  private telemetry: ProductTelemetry

  // Version information
  private version: string = '1.0.0'
  private source: string = 'browser-use'

  private isInitialized = false

  forceExitTelemetryLogged = false

  /**
   * Initialize an Agent instance
   * @param params Agent parameters
   */
  constructor(params: AgentParams<Context>) {
    const {
      task,
      llm,
      controller = new Controller(),
      sensitiveData,
      initialActions,
      registerNewStepCallback,
      registerDoneCallback,
      registerExternalAgentStatusRaiseErrorCallback,
      useVision = true,
      useVisionForPlanner = false,
      saveConversationPath,
      saveConversationPathEncoding = 'utf-8',
      maxFailures = 3,
      retryDelay = 10,
      overrideSystemMessage,
      extendSystemMessage,
      maxInputTokens = 128000,
      validateOutput = false,
      messageContext,
      generateGif = false,
      availableFilePaths,
      includeAttributes = [
        'title',
        'type',
        'name',
        'role',
        'aria-label',
        'placeholder',
        'value',
        'alt',
        'aria-expanded',
        'data-date-format',
      ],
      maxActionsPerStep = 10,
      toolCallingMethod = 'auto',
      pageExtractionLlm,
      plannerLlm,
      plannerInterval = 1,
      isPlannerReasoning = false,
      extendPlannerSystemMessage,
      injectedAgentState,
      context,
      savePlaywrightScriptPath,
      enableMemory = true,
      memoryConfig,
      source,
    } = params

    // Initialize page extraction LLM if not provided
    const finalPageExtractionLlm = pageExtractionLlm || llm
    // Core components
    this.task = task
    this.llm = llm
    this.controller = controller
    this.sensitiveData = sensitiveData

    // Agent settings
    this.settings = new AgentSettings({
      useVision,
      useVisionForPlanner,
      saveConversationPath,
      saveConversationPathEncoding,
      maxFailures,
      retryDelay,
      overrideSystemMessage,
      extendSystemMessage,
      maxInputTokens,
      validateOutput,
      messageContext,
      generateGif,
      availableFilePaths,
      includeAttributes,
      maxActionsPerStep,
      toolCallingMethod,
      pageExtractionLlm: finalPageExtractionLlm,
      plannerLlm,
      plannerInterval,
      isPlannerReasoning,
      savePlaywrightScriptPath,
      extendPlannerSystemMessage,
    })

    // Memory settings
    this.enableMemory = enableMemory
    this.memoryConfig = memoryConfig

    // Initialize state
    this.state = injectedAgentState || new AgentState()

    // Action setup
    this.setupActionModels()
    // this._setBrowserUseVersionAndSource(source)
    if (initialActions) {
      this.initialActions = this.convertInitialActions(initialActions)
    } else {
      this.initialActions = []
    }

    // Model setup
    this.setModelNames()

    // Handle models that don't support vision
    if (this.modelName.toLowerCase().includes('deepseek')) {
      logger.warn('⚠️ DeepSeek models do not support use_vision=True yet. Setting use_vision=False for now...')
      this.settings.useVision = false
    }
    if ((this.plannerModelName || '').toLowerCase().includes('deepseek')) {
      logger.warn('⚠️ DeepSeek models do not support use_vision=True yet. Setting use_vision_for_planner=False for now...')
      this.settings.useVisionForPlanner = false
    }
    if (this.modelName.toLowerCase().includes('grok')) {
      logger.warn('⚠️ XAI models do not support use_vision=True yet. Setting use_vision=False for now...')
      this.settings.useVision = false
    }
    if ((this.plannerModelName || '').toLowerCase().includes('grok')) {
      logger.warn('⚠️ XAI models do not support use_vision=True yet. Setting use_vision_for_planner=False for now...')
      this.settings.useVisionForPlanner = false
    }

    logger.info(
      `🧠 Starting an agent with main_model=${this.modelName}`
      + `${this.toolCallingMethod === 'function_calling' ? ' +tools' : ''}`
      + `${this.toolCallingMethod === 'raw' ? ' +rawtools' : ''}`
      + `${this.settings.useVision ? ' +vision' : ''}`
      + `${this.enableMemory ? ' +memory' : ''}, `
      + `planner_model=${this.plannerModelName}`
      + `${this.settings.isPlannerReasoning ? ' +reasoning' : ''}`
      + `${this.settings.useVisionForPlanner ? ' +vision' : ''}, `
      // @ts-expect-error
      + `extraction_model=${this.settings.pageExtractionLlm?.modelName || null} `,
    )

    // Initialize available actions for system prompt (only non-filtered actions)
    // These will be used for the system prompt to maintain caching
    this.unfilteredActions = this.controller.registry.getPromptDescription()

    this.settings.messageContext = this.setMessageContext()

    let { browser, browserContext, browserProfile, page, browserSession } = params

    browserContext = page?.context() || browserContext
    browserProfile = browserProfile || DEFAULT_BROWSER_PROFILE

    if (browserSession) {
      this.browserSession = new BrowserSession({ ...browserSession })
      this.browserSession.agentCurrentPage = undefined
      this.browserSession.humanCurrentPage = undefined
    } else {
      this.browserSession = new BrowserSession({
        browserProfile,
        browser,
        browserContext,
        // page,
      })
    }

    // Huge security warning if sensitive_data is provided but allowed_domains is not set
    if (this.sensitiveData) {
      const hasDomainSpecificCredentials = Object.values(this.sensitiveData).some(v => typeof v === 'object' && v !== null)

      if (!this.browserProfile.allowedDomains) {
        logger.error(
          '⚠️⚠️⚠️ Agent(sensitiveData=••••••••) was provided but BrowserContextConfig(allowedDomains=[...]) is not locked down! ⚠️⚠️⚠️\n'
          + '          ☠️ If the agent visits a malicious website and encounters a prompt-injection attack, your sensitiveData may be exposed!\n\n'
          + '             https://docs.browser-use.com/customize/browser-settings#restrict-urls\n'
          + 'Waiting 10 seconds before continuing... Press [Ctrl+C] to abort.',
        )

        // Only wait if in interactive terminal
        if (process.stdin.isTTY) {
          try {
            setTimeout(() => { }, 10000) // Wait 10 seconds
          } catch (error) {
            if (error instanceof Error && error.name === 'SIGINT') {
              logger.info('\n\n 🛑 Exiting now... set BrowserContextConfig(allowedDomains=["example.com", "example.org"]) to only domains you trust to see your sensitiveData.')
              process.exit(0)
            }
          }
        }
        logger.warn('‼️ Continuing with insecure settings for now... but this will become a hard error in the future!')
      } else if (hasDomainSpecificCredentials) {
        // For domain-specific format, ensure all domain patterns are included in allowed_domains
        const domainPatterns = Object.entries(this.sensitiveData)
          .filter(([k, v]) => typeof v === 'object' && v !== null)
          .map(([k, v]) => k)

        // Validate each domain pattern against allowed_domains
        for (const domainPattern of domainPatterns) {
          let isAllowed = false
          for (const allowedDomain of this.browserProfile.allowedDomains) {
            // Special cases that don't require URL matching
            if (domainPattern === allowedDomain || allowedDomain === '*') {
              isAllowed = true
              break
            }

            // Need to create example URLs to compare the patterns
            // Extract the domain parts, ignoring scheme
            const patternDomain = domainPattern.includes('://') ? domainPattern.split('://')[1] : domainPattern
            const allowedDomainPart = allowedDomain.includes('://') ? allowedDomain.split('://')[1] : allowedDomain

            // Check if pattern is covered by an allowed domain
            // Example: "google.com" is covered by "*.google.com"
            if (patternDomain === allowedDomainPart || (
              allowedDomainPart.startsWith('*.') && (
                patternDomain === allowedDomainPart.slice(2)
                || patternDomain.endsWith(`.${allowedDomainPart.slice(2)}`)
              )
            )) {
              isAllowed = true
              break
            }
          }

          if (!isAllowed) {
            logger.warn(
              `⚠️ Domain pattern "${domainPattern}" in sensitive_data is not covered by any pattern in allowed_domains=${this.browserProfile.allowedDomains}\n`
              + `   This may be a security risk as credentials could be used on unintended domains.`,
            )
          }
        }
      }
    }

    // Callbacks
    this.registerNewStepCallback = registerNewStepCallback
    this.registerDoneCallback = registerDoneCallback
    this.registerExternalAgentStatusRaiseErrorCallback = registerExternalAgentStatusRaiseErrorCallback

    // Context
    this.context = context

    // Telemetry
    this.telemetry = new ProductTelemetry()

    if (this.settings.saveConversationPath) {
      logger.info(`Saving conversation to ${this.settings.saveConversationPath}`)
    }
  }

  get browser() {
    return this.browserSession.browser
  }

  get browserContext() {
    return this.browserSession.browserContext
  }

  get browserProfile() {
    return this.browserSession.browserProfile
  }

  async init() {
    if (this.isInitialized) {
      return
    }

    const systemPrompt = new SystemPrompt({
      actionDescription: this.unfilteredActions,
      maxActionsPerStep: this.settings.maxActionsPerStep,

    })

    await systemPrompt.init({
      overrideSystemMessage: this.settings.overrideSystemMessage,
      extendSystemMessage: this.settings.extendSystemMessage,
    })
    // Initialize message manager with state
    // Initial system prompt with all actions - will be updated during each step
    this.messageManager = new MessageManager({
      task: this.task,
      systemMessage: systemPrompt.getSystemMessage(),
      settings: {
        maxInputTokens: this.settings.maxInputTokens,
        includeAttributes: this.settings.includeAttributes,
        messageContext: this.settings.messageContext,
        sensitiveData: this.sensitiveData,
        availableFilePaths: this.settings.availableFilePaths,
      },
      state: this.state.messageManagerState,
    })

    if (this.enableMemory) {
      try {
        // Initialize memory
        this.memory = new Memory({
          messageManager: this.messageManager,
          llm: this.llm,
          config: this.memoryConfig,
        })
      } catch (error) {
        if (error instanceof Error && error.message.includes('Import error')) {
          logger.warn(
            '⚠️ Agent(enableMemory=true) is set but missing some required packages, '
            + 'install and re-run to use memory features: npm install browser-use-memory',
          )
          this.memory = undefined
          this.enableMemory = false
        } else {
          throw error
        }
      }
    }

    await this.verifyAndSetupLLM() // Verify we can connect to the LLM

    this.isInitialized = true
  }

  private setMessageContext() {
    if (this.toolCallingMethod === 'raw') {
      if (this.settings.messageContext) {
        this.settings.messageContext += `\n\nAvailable actions: ${this.unfilteredActions}`
      } else {
        this.settings.messageContext = `Available actions: ${this.unfilteredActions}`
      }
    }

    return this.settings.messageContext
  }

  private setModelNames() {
    this.chatModelLibrary = (this.llm.constructor as typeof BaseChatModel).lc_name()
    // @ts-expect-error
    this.modelName = this.llm.model || this.llm.modelName || 'Unknown'
    // @ts-expect-error
    this.plannerModelName = this.settings.plannerLlm?.model || this.settings.plannerLlm?.modelName || 'Unknown'
  }

  private setupActionModels() {
    this.ActionModel = this.controller.registry.createActionModel()
    this.AgentOutput = AgentOutput.typeWithCustomActions(this.ActionModel)
    this.DoneActionModel = this.controller.registry.createActionModel({
      includeActions: ['done'],
    })
    this.DoneAgentOutput = AgentOutput.typeWithCustomActions(this.DoneActionModel)
  }

  async testToolCallingMethod(method: ToolCallingMethod): Promise<boolean> {
    /** Test if a specific tool calling method works with the current LLM. */
    try {
      // Test configuration
      const CAPITAL_QUESTION = 'What is the capital of France? Respond with just the city name in lowercase.'
      const EXPECTED_ANSWER = 'paris'

      interface CapitalResponse {
        /** Response model for capital city question */
        answer: string // The name of the capital city in lowercase
      }

      const isValidRawResponse = (response: any, expectedAnswer: string): boolean => {
        /**
         * Cleans and validates a raw JSON response string against an expected answer.
         */
        const content = response?.content?.trim() || ''
        // logger.debug(f'Raw response content: {content}')

        // Remove surrounding markdown code blocks if present
        let cleanContent = content
        if (cleanContent.startsWith('```json') && cleanContent.endsWith('```')) {
          cleanContent = cleanContent.slice(7, -3).trim()
        } else if (cleanContent.startsWith('```') && cleanContent.endsWith('```')) {
          cleanContent = cleanContent.slice(3, -3).trim()
        }

        // Attempt to parse and validate the answer
        try {
          const result = JSON.parse(cleanContent)
          const answer = String(result.answer || '').trim().toLowerCase().replace(/[. ]/g, '')

          if (!expectedAnswer.toLowerCase().includes(answer)) {
            console.debug(`🛠️ Tool calling method ${method} failed: expected '${expectedAnswer}', got '${answer}'`)
            return false
          }

          return true
        } catch (e) {
          console.debug(`🛠️ Tool calling method ${method} failed: Failed to parse JSON content: ${e}`)
          return false
        }
      }

      if (method === 'raw') {
        // For raw mode, test JSON response format
        const testPrompt = `${CAPITAL_QUESTION}
                Respond with a JSON object like: {"answer": "city_name_in_lowercase"}`

        const response = await this.llm.invoke([testPrompt])
        // Basic validation of response
        if (!response || !response.content) {
          return false
        }

        if (!isValidRawResponse(response, EXPECTED_ANSWER)) {
          return false
        }
        return true
      } else {
        // For other methods, try to use structured output
        const structuredLlm = this.llm.withStructuredOutput(z.object({
          answer: z.string(),
        }), { includeRaw: true, method })
        const response = structuredLlm.invoke([{ role: 'human', content: CAPITAL_QUESTION }])

        if (!response) {
          console.debug(`🛠️ Tool calling method ${method} failed: empty response`)
          return false
        }

        const extractParsed = (response: any): CapitalResponse | null => {
          if (typeof response === 'object' && response !== null) {
            return response.parsed || null
          }
          return response?.parsed || null
        }

        const parsed = extractParsed(response)

        if (!parsed || typeof parsed.answer !== 'string') {
          console.debug(`🛠️ Tool calling method ${method} failed: LLM responded with invalid JSON`)
          return false
        }

        if (!EXPECTED_ANSWER.includes(parsed.answer.toLowerCase())) {
          console.debug(`🛠️ Tool calling method ${method} failed: LLM failed to answer test question correctly`)
          return false
        }
        return true
      }
    } catch (e: any) {
      console.debug(`🛠️ Tool calling method '${method}' test failed: ${e.constructor.name}: ${e.message}`)
      return false
    }
  }

  async testToolCallingMethodAsync(method: ToolCallingMethod): Promise<[string, boolean]> {
    /** Test if a specific tool calling method works with the current LLM (async version). */
    // Run the synchronous test in a thread pool to avoid blocking
    const result = await this.testToolCallingMethod(method)

    return [method, result]
  }

  async detectBestToolCallingMethod(): Promise<ToolCallingMethod | undefined> {
    /** Detect the best supported tool calling method by testing each one. */
    const startTime = Date.now()

    // Order of preference for tool calling methods
    const methodsToTry: ToolCallingMethod[] = [
      'function_calling', // Most capable and efficient
      'tools', // Works with some models that don't support function_calling
      'json_mode', // More basic structured output
      'raw', // Fallback - no tool calling support
    ]

    // Try parallel testing for faster detection
    try {
      // Run async parallel tests
      const testAllMethods = async (): Promise<[string, boolean][]> => {
        const tasks = methodsToTry.map(method => this.testToolCallingMethodAsync(method))
        const results = await Promise.allSettled(tasks)
        return results.map((result, index) => {
          if (result.status === 'fulfilled') {
            return result.value
          } else {
            return [methodsToTry[index], false]
          }
        })
      }

      // Execute async tests
      const results: [string, boolean][] = await testAllMethods()

      // Process results in order of preference
      for (let i = 0; i < methodsToTry.length; i++) {
        const method = methodsToTry[i]
        const [resultMethod, success] = results[i]
        if (success) {
          (this.llm as any)._verifiedApiKeys = true;
          (this.llm as any)._verifiedToolCallingMethod = method // Cache on LLM instance
          const elapsed = (Date.now() - startTime) / 1000
          logger.debug(`🛠️ Tested LLM in parallel and chose tool calling method: [${method}] in ${elapsed.toFixed(2)}s`)
          return method
        }
      }
    } catch (e) {
      logger.debug(`Parallel testing failed: ${e}, falling back to sequential`)
      // Fall back to sequential testing
      for (const method of methodsToTry) {
        if (await this.testToolCallingMethod(method)) {
          // if we found the method which means api is verified.
          (this.llm as any)._verifiedApiKeys = true;
          (this.llm as any)._verifiedToolCallingMethod = method // Cache on LLM instance
          const elapsed = (Date.now() - startTime) / 1000
          logger.debug(`🛠️ Tested LLM and chose tool calling method: [${method}] in ${elapsed.toFixed(2)}s`)
          return method
        }
      }
    }

    // If we get here, no methods worked
    throw new Error('Failed to connect to LLM. Please check your API key and network connection.')
  }

  /**
   * Get known tool calling method for common model/library combinations.
   */
  getKnownToolCallingMethod(): ToolCallingMethod | undefined {
    // Fast path for known combinations
    const modelLower = this.modelName.toLowerCase()

    // OpenAI models
    if (this.chatModelLibrary === 'ChatOpenAI') {
      if (['gpt-4', 'gpt-3.5'].some(m => modelLower.includes(m))) {
        return 'function_calling'
      }
      if (['llama-4', 'llama-3'].some(m => modelLower.includes(m))) {
        return 'function_calling'
      }
    } else if (this.chatModelLibrary === 'AzureChatOpenAI') {
      // Azure OpenAI models
      if (modelLower.includes('gpt-4-')) {
        return 'tools'
      } else {
        return 'function_calling'
      }
    } else if (this.chatModelLibrary === 'ChatGoogleGenerativeAI') {
      // Google models
      return undefined // Google uses native tool support
    } else if (['ChatAnthropic', 'AnthropicChat'].includes(this.chatModelLibrary)) {
      // Anthropic models
      if (['claude-3', 'claude-2'].some(m => modelLower.includes(m))) {
        return 'tools'
      }
    } else if (isModelWithoutToolSupport(this.modelName)) {
      // Models known to not support tools
      return 'raw'
    }

    return undefined // Unknown combination, needs testing
  }

  /** Determine the best tool calling method to use with the current LLM. */
  async setToolCallingMethod(): Promise<ToolCallingMethod | undefined> {
    // old hardcoded logic
    //       if is_model_without_tool_support(self.model_name):
    //         return 'raw'
    //       elif self.chat_model_library == 'ChatGoogleGenerativeAI':
    //         return None
    //       elif self.chat_model_library == 'ChatOpenAI':
    //         return 'function_calling'
    //       elif self.chat_model_library == 'AzureChatOpenAI':
    //         # Azure OpenAI API requires 'tools' parameter for GPT-4
    //         # The error 'content must be either a string or an array' occurs when
    //         # the API expects a tools array but gets something else
    //         if 'gpt-4-' in self.model_name.lower():
    //           return 'tools'
    //         else:
    //           return 'function_calling'

    // If a specific method is set, use it
    if (this.settings.toolCallingMethod !== 'auto') {
      // Skip test if already verified
      if ((this.llm as any)._verifiedApiKeys === true || SKIP_LLM_API_KEY_VERIFICATION) {
        (this.llm as any)._verifiedApiKeys = true;
        (this.llm as any)._verifiedToolCallingMethod = this.settings.toolCallingMethod
        return this.settings.toolCallingMethod
      }

      if (!await this.testToolCallingMethod(this.settings.toolCallingMethod)) {
        if (this.settings.toolCallingMethod === 'raw') {
          // if raw failed means error in API key or network connection
          throw new Error('Failed to connect to LLM. Please check your API key and network connection.')
        } else {
          throw new Error(
            `Configured tool calling method '${this.settings.toolCallingMethod}' `
            + 'is not supported by the current LLM.',
          )
        }
      }
      (this.llm as any)._verifiedToolCallingMethod = this.settings.toolCallingMethod
      return this.settings.toolCallingMethod
    }

    // Check if we already have a cached method on this LLM instance
    if ('_verifiedToolCallingMethod' in this.llm) {
      logger.debug(
        `🛠️ Using cached tool calling method for ${this.chatModelLibrary}/${this.modelName}: [${(this.llm as any)._verifiedToolCallingMethod}]`,
      )
      return (this.llm as any)._verifiedToolCallingMethod
    }

    // Try fast path for known model/library combinations
    const knownMethod = this.getKnownToolCallingMethod()
    if (knownMethod) {
      // Trust known combinations without testing if verification is already done or skipped
      if ((this.llm as any)._verifiedApiKeys === true || SKIP_LLM_API_KEY_VERIFICATION) {
        (this.llm as any)._verifiedApiKeys = true;
        (this.llm as any)._verifiedToolCallingMethod = knownMethod // Cache on LLM instance
        logger.debug(
          `🛠️ Using known tool calling method for ${this.chatModelLibrary}/${this.modelName}: [${knownMethod}] (skipped test)`,
        )
        return knownMethod
      }

      const startTime = Date.now()
      // Verify the known method works
      if (await this.testToolCallingMethod(knownMethod)) {
        (this.llm as any)._verifiedApiKeys = true;
        (this.llm as any)._verifiedToolCallingMethod = knownMethod // Cache on LLM instance
        const elapsed = (Date.now() - startTime) / 1000
        logger.debug(
          `🛠️ Using known tool calling method for ${this.chatModelLibrary}/${this.modelName}: [${knownMethod}] in ${elapsed.toFixed(2)}s`,
        )
        return knownMethod
      }
      // If known method fails, fall back to detection
      logger.debug(
        `Known method ${knownMethod} failed for ${this.chatModelLibrary}/${this.modelName}, falling back to detection`,
      )
    }

    // Auto-detect the best method
    return await this.detectBestToolCallingMethod()
  }

  addNewTask(task: string) {
    this.messageManager.addNewTask(task)
  }

  /**
   * Utility function that raises an InterruptedError if the agent is stopped or paused.
   */
  private async throwErrorIfStoppedOrPaused() {
    if (this.registerExternalAgentStatusRaiseErrorCallback) {
      const isThrow = await this.registerExternalAgentStatusRaiseErrorCallback()
      if (isThrow) {
        throw new Error('InterruptedError')
      }
    }

    if (this.state.stopped || this.state.paused) {
      throw new Error('InterruptedError')
    }
  }

  async step(stepInfo?: AgentStepInfo) {
    logger.info(`📍 Step ${this.state.nSteps}`)
    let browserStateSummary: BrowserStateSummary | undefined
    let modelOutput!: AgentOutput
    let result: ActionResult[] = []
    const stepStartTime = Date.now()
    let tokens = 0
    try {
      browserStateSummary = await this.browserSession.getStateSummary(true)
      const currentPage = await this.browserSession.getCurrentPage()

      this.logStepContext(currentPage, browserStateSummary)

      if (this.enableMemory && this.memory && this.state.nSteps % this.memory.config.memoryInterval === 0) {
        this.memory.createProceduralMemory(this.state.nSteps)
      }

      await this.throwErrorIfStoppedOrPaused()

      // Update action models with page-specific actions
      await this.updateActionModelsForPage(currentPage)

      // Get page-specific filtered actions
      const pageFilterActions = this.controller.registry.getPromptDescription(currentPage)
      if (pageFilterActions) {
        const pageActionMessage = `For this page, these additional actions are available:\n${pageFilterActions}`
        this.messageManager.addMessageWithTokens({
          message: new HumanMessage(pageActionMessage),
        })
      }

      // If using raw tool calling method, we need to update the message context with new actions
      if (this.toolCallingMethod === 'raw') {
        // For raw tool calling, get all non-filtered actions plus the page-filtered ones
        const allUnfilteredActions = this.controller.registry.getPromptDescription()
        let allActions = allUnfilteredActions
        if (pageFilterActions) {
          allActions += `\n${pageFilterActions}`
        }
        const contextLines = (this.messageManager.settings.messageContext || '').split('\n')
        const nonActionLines = contextLines.filter(line => !line.startsWith('Available actions:'))
        let updateContext = nonActionLines.join('\n')
        if (updateContext) {
          updateContext += `\n\nAvailable actions: ${allActions}`
        } else {
          updateContext = `Available actions: ${allActions}`
        }
        this.messageManager.settings.messageContext = updateContext
      }

      this.messageManager.addStateMessage({
        state: browserStateSummary,
        result: this.state.lastResult,
        stepInfo,
        useVision: this.settings.useVision,
      })

      // Run planner at specified intervals if planner is configured
      if (this.settings.plannerLlm && this.state.nSteps % this.settings.plannerInterval === 0) {
        const plan = await this.runPlanner()
        // add plan before last state message
        this.messageManager.addPlan({
          plan,
          position: -1,
        })
      }

      if (stepInfo && stepInfo.isLastStep()) {
        // Add last step warning if needed
        let msg = 'Now comes your last step. Use only the "done" action now. No other actions - so here your action sequence must have length 1.'
        msg += '\nIf the task is not yet fully finished as requested by the user, set success in "done" to false! E.g. if not all steps are fully completed.'
        msg += '\nIf the task is fully finished, set success in "done" to true.'
        msg += '\nInclude everything you found out for the ultimate task in the done text.'
        logger.info('last step finishing up')
        this.messageManager.addMessageWithTokens({
          message: new HumanMessage(msg),
        })
        this.AgentOutput = this.DoneAgentOutput
      }

      const inputMessages = this.messageManager.getMessages()
      tokens = this.messageManager.state.history.currentTokens

      try {
        modelOutput = await this.getNextAction(inputMessages)
        if (!Array.isArray(modelOutput.action) || modelOutput.action.every(action => Object.keys(action).length === 0)) {
          logger.warn('Model returned empty action. Retrying...')
          const clarificationMessage = new HumanMessage({
            content: 'You forgot to return an action. Please respond only with a valid JSON action according to the expected format.',
          })

          const retryMessages = [...inputMessages, clarificationMessage]
          modelOutput = await this.getNextAction(retryMessages)

          if (!Array.isArray(modelOutput.action) || modelOutput.action.every(action => Object.keys(action).length === 0)) {
            logger.warn('Model still returned empty after retry. Inserting safe noop action.')
            const action = new this.ActionModel({
              done: {
                success: false,
                text: 'No next action returned by LLM!',
              },
            })
            modelOutput.action = [action]
          }
        }
        this.throwErrorIfStoppedOrPaused()

        this.state.nSteps += 1

        if (this.registerNewStepCallback) {
          await Promise.resolve(this.registerNewStepCallback(browserStateSummary, modelOutput, this.state.nSteps))
        }

        if (this.settings.saveConversationPath) {
          const target = `${this.settings.saveConversationPath}_${this.state.nSteps}.txt`
          saveConversation({
            inputMessages,
            response: modelOutput,
            target,
            encoding: this.settings.saveConversationPathEncoding,
          })
        }

        this.messageManager.removeLastStateMessage()

        await this.throwErrorIfStoppedOrPaused()

        this.messageManager.addModelOutput(modelOutput)
      } catch (error) {
        logger.error('Error during getNextAction', error)
        this.messageManager.removeLastStateMessage()
      }

      result = await this.multiAct(modelOutput.action)

      this.state.lastResult = result

      if (result.length > 0 && result[result.length - 1].isDone) {
        logger.info(`Result: ${result[result.length - 1].extractedContent}`)
      }

      this.state.consecutiveFailures = 0
    } catch (error) {
      logger.error('Error during agent step', error)
      result = await this.handleStepError(error as Error)
      this.state.lastResult = result
    } finally {
      const stepEndTime = Date.now()

      if (result.length <= 0) {
        return
      }

      if (browserStateSummary) {
        const metadata = new StepMetadata({
          stepNumber: this.state.nSteps,
          stepStartTime,
          stepEndTime,
          inputTokens: tokens,
        })
        this.makeHistoryItem({
          modelOutput,
          state: browserStateSummary,
          result,
          metadata,
        })
      }

      this.logStepCompletionSummary(stepStartTime, result)
    }
  }

  /**
   * Handle all types of errors that can occur during a step
   * @param error
   */
  async handleStepError(error: Error): Promise<ActionResult[]> {
    let errorMsg = AgentError.formatError(error)
    const prefix = `❌ Result failed ${this.state.consecutiveFailures + 1}/${this.settings.maxFailures} times:\n `
    this.state.consecutiveFailures += 1
    if (errorMsg.includes('Browser closed')) {
      logger.error('❌  Browser is closed or disconnected, unable to proceed')
      return [new ActionResult({
        error: 'Browser closed or disconnected, unable to proceed',
        includeInMemory: false,
      })]
    }

    if (errorMsg.includes('Max token limit reached')) {
      // Cut tokens from history
      this.messageManager.settings.maxInputTokens = this.settings.maxInputTokens - 500
      logger.info(
        `Cutting tokens from history - new max input tokens: ${this.messageManager.settings.maxInputTokens}`,
      )
      this.messageManager.cutMessages()
    } else if (errorMsg.includes('Could not parse response')) {
      // Give model a hint how output should look like
      errorMsg += '\n\nReturn a valid JSON object with the required fields.'
    } else {
    // Define rate limit error types
      const isRateLimitError = (
        error instanceof RateLimitError // OpenAI
        // || error instanceof ResourceExhausted // Google
        // || error instanceof AnthropicRateLimitError // Anthropic
      )

      if (isRateLimitError) {
        logger.warn(`${prefix}${errorMsg}`)
        await sleep(this.settings.retryDelay * 1000)
      } else {
        logger.error(`${prefix}${errorMsg}`)
      }
    }
    return [new ActionResult({ error: errorMsg, includeInMemory: true })]
  }

  /**
   * Create and store history item
   */
  makeHistoryItem({
    modelOutput,
    state,
    result,
    metadata,
  }: { modelOutput: AgentOutput, state: BrowserStateSummary, result: ActionResult[], metadata: StepMetadata }) {
    // Get interacted elements from model output and state selector map
    let interactedElements: (DOMHistoryElement | undefined)[]

    if (modelOutput) {
      interactedElements = AgentHistory.getInteractedElement(modelOutput, state.selectorMap)
    } else {
      interactedElements = []
    }

    // Create state history object
    const stateHistory = new BrowserStateHistory({
      url: state.url,
      title: state.title,
      tabs: state.tabs,
      interactedElement: interactedElements,
      screenshot: state.screenshot,
    })

    // Create and store history item
    const historyItem = new AgentHistory({
      modelOutput,
      result,
      state: stateHistory,
      metadata,
    })
    this.state.history.history.push(historyItem)
  }

  removeThinkTags(text: string): string {
    // Step 1: Remove well-formed <think>...</think>
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '')
    // Step 2: If there's an unmatched closing tag </think>,
    //        remove everything up to and including that.
    text = text.replace(/[\s\S]*?<\/think>/g, '')
    return text.trim()
  }

  convertInputMessages(inputMessages: BaseMessage[]): BaseMessage[] {
    if (isModelWithoutToolSupport(this.modelName)) {
      return convertInputMessages(inputMessages, this.modelName)
    }
    return inputMessages
  }

  /**
   * Get next action from LLM based on current state
   * @param inputMessages
   */
  @timeExecutionAsync('--getNextAction (agent)')
  async getNextAction(inputMessages: BaseMessage[]): Promise<AgentOutput> {
    inputMessages = this.convertInputMessages(inputMessages)

    let response: { raw: AIMessageChunk, parsed: AgentOutput | undefined }
    let parsed: AgentOutput | undefined
    if (this.toolCallingMethod === 'raw') {
      this.logLlmCallInfo(inputMessages, this.toolCallingMethod)
      let output: AIMessageChunk
      try {
        output = await this.llm.invoke(inputMessages)
        response = {
          raw: output,
          parsed: undefined,
        }
      } catch (e) {
        console.error(`Failed to invoke model: ${e}`)
        throw new LLMException(401, 'LLM API call failed')
      }
      output.content = this.removeThinkTags(output.content as string)
      try {
        const parsedJson = extractJsonFromModelOutput(output.content)
        parsed = new this.AgentOutput({
          action: parsedJson.action,
          currentState: parsedJson.currentState,
        })
        response.parsed = parsed
      } catch (error) {
        logger.warn(`Failed to parse model output: ${output} ${error}`)
        throw new Error('Could not parse response.')
      }
    } else if (!this.toolCallingMethod) {
      const structuredLlm = this.llm.withStructuredOutput(this.AgentOutput.schema, { includeRaw: true })
      try {
        const output = await structuredLlm.invoke(inputMessages)
        parsed = new this.AgentOutput(output.parsed)
        response = {
          raw: output.raw as AIMessageChunk,
          parsed,
        }
      } catch (e) {
        console.error(`Failed to invoke model: ${e}`)
        throw new LLMException(401, 'LLM API call failed')
      }
    } else {
      try {
        this.logLlmCallInfo(inputMessages, this.toolCallingMethod)
        const structuredLlm = this.llm.withStructuredOutput(this.AgentOutput.schema, {
          includeRaw: true,
          method: this.toolCallingMethod,
        })
        const output = await structuredLlm.invoke(inputMessages)

        parsed = new this.AgentOutput(output.parsed)
        response = {
          raw: output.raw as AIMessageChunk,
          parsed,
        }
      } catch (e) {
        console.error(`Failed to invoke model: ${e}`)
        throw new LLMException(401, 'LLM API call failed')
      }
    }
    // Handle tool call responses
    if (!parsed && response.raw) {
      const rawMsg = response.raw
      if (rawMsg.tool_calls && rawMsg.tool_calls.length) {
      // Convert tool calls to AgentOutput format
        const toolCall = rawMsg.tool_calls[0] // Take first tool call

        // Create current state
        const toolCallName = toolCall.name
        const toolCallArgs = toolCall.args

        const currentState: AgentBrain = {
          // pageSummary: 'Processing tool call',
          evaluationPreviousGoal: 'Executing action',
          memory: 'Using tool call',
          nextGoal: `Execute ${toolCallName}`,
        }

        // Create action from tool call
        const action = { [toolCallName]: toolCallArgs }

        response.parsed = new this.AgentOutput({
          currentState,
          action: [new this.ActionModel(action)],
        })
      } else {
        response.parsed = undefined
      }
    }

    // If still no parsed output, try to extract JSON from raw content
    if (!response.parsed) {
      try {
        const parsedJson = extractJsonFromModelOutput(response.raw.content as string)
        response.parsed = new this.AgentOutput({
          action: parsedJson.action,
          currentState: parsedJson.currentState,
        })
      } catch (e) {
        logger.warn(`Failed to parse model output: ${response.raw.content} ${e}`)
        throw new Error('Could not parse response.')
      }
    }
    // Cut the number of actions to max_actions_per_step if needed
    if (response.parsed.action.length > this.settings.maxActionsPerStep) {
      response.parsed.action = response.parsed.action.slice(0, this.settings.maxActionsPerStep)
    }

    // Log the response if agent is not paused or stopped
    if (!(this.state.paused || this.state.stopped)) {
      logResponse(response.parsed)
    }
    this.logNextActionSummary(parsed)
    return response.parsed
  }

  /**
   * Log the agent run
   */
  private logAgentRun() {
    logger.info(`🚀 Starting task: ${this.task}`)
  }

  logStepContext(currentPage: Page, browserStateSummary: BrowserStateSummary): void {
    /** Log step context information */
    const urlShort = currentPage.url().length > 50 ? `${currentPage.url().substring(0, 50)}...` : currentPage.url()
    const interactiveCount = browserStateSummary ? Object.keys(browserStateSummary.selectorMap).length : 0
    logger.info(
      `📍 Step ${this.state.nSteps}: Evaluating page with ${interactiveCount} interactive elements on: ${urlShort}`,
    )
  }

  logNextActionSummary(parsed: AgentOutput): void {
    /** Log a comprehensive summary of the next action(s) */
    // TODO:
    // if (!(logger.isEnabledFor(logging.DEBUG) && parsed.action)) {
    //   return
    // }

    const actionCount = parsed.action.length

    // Collect action details
    const actionDetails: string[] = []
    for (let i = 0; i < parsed.action.length; i++) {
      const action = parsed.action[i]
      const actionData = { ...action }
      const actionName = actionData ? Object.keys(actionData)[0] : 'unknown'
      const actionParams = actionData && actionName ? actionData[actionName] : {}

      // Format key parameters concisely
      const paramSummary: string[] = []
      if (typeof actionParams === 'object' && actionParams !== null) {
        for (const [key, value] of Object.entries(actionParams)) {
          if (key === 'index') {
            paramSummary.push(`#${value}`)
          } else if (key === 'text' && typeof value === 'string') {
            const textPreview = value.length > 30 ? `${value.substring(0, 30)}...` : value
            paramSummary.push(`text="${textPreview}"`)
          } else if (key === 'url') {
            paramSummary.push(`url="${value}"`)
          } else if (key === 'success') {
            paramSummary.push(`success=${value}`)
          } else if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && String(value).length < 20) {
            paramSummary.push(`${key}=${value}`)
          }
        }
      }

      const paramStr = paramSummary.length > 0 ? `(${paramSummary.join(', ')})` : ''
      actionDetails.push(`${actionName}${paramStr}`)
    }

    // Create summary based on single vs multi-action
    if (actionCount === 1) {
      const actionName = actionDetails[0]
      logger.info(`⚡️ Decided next action: ${actionName}`)
    } else {
      const summaryLines = [`⚡️ Decided next ${actionCount} multi-actions:`]
      for (let i = 0; i < actionDetails.length; i++) {
        const detail = actionDetails[i]
        summaryLines.push(`          ${i + 1}. ${detail}`)
      }
      logger.info(summaryLines.join('\n'))
    }
  }

  logStepCompletionSummary(stepStartTime: number, result: ActionResult[]): void {
    /** Log step completion summary with action count, timing, and success/failure stats */
    if (!result.length) {
      return
    }

    const stepDuration = (Date.now() - stepStartTime) / 1000
    const actionCount = result.length

    // Count success and failures
    const successCount = result.filter(r => !r.error).length
    const failureCount = actionCount - successCount

    // Format success/failure indicators
    const successIndicator = successCount > 0 ? `✅ ${successCount}` : ''
    const failureIndicator = failureCount > 0 ? `❌ ${failureCount}` : ''
    const statusParts = [successIndicator, failureIndicator].filter(part => part)
    const statusStr = statusParts.length > 0 ? statusParts.join(' | ') : '✅ 0'

    logger.info(`📍 Step ${this.state.nSteps}: Ran ${actionCount} actions in ${stepDuration.toFixed(2)}s: ${statusStr}`)
  }

  logLlmCallInfo(inputMessages: BaseMessage[], method: string): void {
    /** Log comprehensive information about the LLM call being made */
    // Count messages and check for images
    const messageCount = inputMessages.length
    const totalChars = inputMessages.reduce((sum, msg) => sum + String(msg.content).length, 0)
    const hasImages = inputMessages.some(msg =>
      msg.content
      && Array.isArray(msg.content)
      && msg.content.some(item =>
        typeof item === 'object'
        && item !== null
        && item.type === 'image_url',
      ),
    )
    const currentTokens = this.messageManager.state.history.currentTokens || 0

    // Count available tools/actions from the current ActionModel
    // This gives us the actual number of tools exposed to the LLM for this specific call
    const toolCount = this.ActionModel ? Object.keys(this.ActionModel.schema.shape || {}).length : 0
    // const toolCount =

    // Format the log message parts
    const imageStatus = hasImages ? ', 📷 img' : ''
    let outputFormat: string
    let toolInfo: string

    if (method === 'raw') {
      outputFormat = '=> raw text'
      toolInfo = ''
    } else {
      outputFormat = '=> JSON out'
      toolInfo = ` + 🔨 ${toolCount} tools (${method})`
    }

    const termWidth = process.stdout.columns || 80
    console.log('='.repeat(termWidth))
    logger.info(
      `🧠 LLM call => ${this.chatModelLibrary} [✉️ ${messageCount} msg, ~${currentTokens} tk, ${totalChars} char${imageStatus}] ${outputFormat}${toolInfo}`,
    )
  }

  /**
   * Log the agent event for this run"
   * @param maxSteps
   * @param agentRunError
   */
  logAgentEvent(maxSteps: number, agentRunError?: string) {
    // Prepare action_history data correctly
    const actionHistoryData: (Record<string, any>[] | undefined)[] = []
    this.state.history.history.forEach((item) => {
      if (item.modelOutput && item.modelOutput.action) {
        const stepActions = item.modelOutput.action.map((action) => {
          return {
            ...action,
          }
        })
        actionHistoryData.push(stepActions)
      } else {
        actionHistoryData.push(undefined)
      }
    })

    const finalResult = this.state.history.finalResult()

    this.telemetry.capture(new AgentTelemetryEvent({
      task: this.task,
      model: this.modelName,
      modelProvider: this.chatModelLibrary,
      plannerLLm: this.plannerModelName,
      maxSteps,
      maxActionsPerStep: this.settings.maxActionsPerStep,
      useVision: this.settings.useVision,
      useValidation: this.settings.validateOutput,
      version: this.version,
      actionErrors: this.state.history.errors(),
      actionHistory: actionHistoryData,
      steps: this.state.nSteps,
      totalInputTokens: this.state.history.totalInputTokens(),
      totalDurationSeconds: this.state.history.totalDurationSeconds(),
      success: this.state.history.isSuccessful(),
      finalResultResponse: finalResult,
      errorMessage: agentRunError,
      source: this.source,
      urlVisited: this.state.history.urls(),
    }))
  }

  async takeStep() {
    await this.step()
    if (this.state.history.isDone()) {
      if (this.settings.validateOutput) {
        const isValid = await this.validateOutput()
        if (!isValid) {
          return {
            isDone: true,
            isValid: false,
          }
        }
      }
      await this.logCompletion()
      if (this.registerDoneCallback) {
        await this.registerDoneCallback(this.state.history)
      }
      return {
        isDone: true,
        isValid: true,
      }
    }
    return {
      isDone: false,
      isValid: true,
    }
  }

  @timeExecutionAsync('--run (agent)')
  async run({
    maxSteps = 10,
    onStepStart,
    onStepEnd,
  }: {
    maxSteps?: number
    onStepStart?: AgentHook
    onStepEnd?: AgentHook
  } = {}) {
    await this.init()
    this.forceExitTelemetryLogged = false
    let agentRunError: string | undefined

    const onForceExitLogTelemetry = () => {
      this.logAgentEvent(maxSteps, 'Force SIGINT: Cancelled by user')

      if (this.telemetry.flush) {
        this.telemetry.flush()
      }

      this.forceExitTelemetryLogged = true
    }
    const signalHandler = new SignalHandler({
      pauseCallback: () => this.pause(),
      resumeCallback: () => this.resume(),
      customExitCallback: onForceExitLogTelemetry,
      exitOnSecondInt: true,
    })

    signalHandler.register()

    try {
      this.logAgentRun()
      if (this.initialActions.length) {
        const result = await this.multiAct(this.initialActions, false)
        this.state.lastResult = result
      }
      let step = 0
      for (; step < maxSteps; step++) {
        if (this.state.paused) {
          await signalHandler.waitForResume()
          signalHandler.reset()
        }

        if (this.state.consecutiveFailures >= this.settings.maxFailures) {
          logger.error(`❌ Stopping due to ${this.settings.maxFailures} consecutive failures`)
          agentRunError = `Stopped due to ${this.settings.maxFailures} consecutive failures`
          break
        }

        if (this.state.stopped) {
          logger.info('Agent stopped')
          agentRunError = 'Agent stopped programmatically'
          break
        }

        while (this.state.paused) {
          await sleep(0.2) // Small delay to prevent CPU spinning
          if (this.state.stopped) { // Allow stopping while paused
            agentRunError = 'Agent stopped programmatically while paused'
            break
          }
        }

        if (onStepStart) {
          await onStepStart(this)
        }

        const stepInfo = new AgentStepInfo({
          stepNumber: step,
          maxSteps,
        })

        await this.step(stepInfo)

        if (onStepEnd) {
          await onStepEnd(this)
        }

        if (this.state.history.isDone()) {
          if (this.settings.validateOutput && step < maxSteps - 1) {
            const isValid = await this.validateOutput()
            if (!isValid) {
              continue
            }
          }

          await this.logCompletion()
          break
        }
      }

      if (step === maxSteps) {
        agentRunError = 'Failed to complete task in maximum steps'
        this.state.history.history.push(new AgentHistory({
          modelOutput: undefined,
          result: [new ActionResult({
            error: agentRunError,
            includeInMemory: true,
          })],
          state: new BrowserStateHistory({
            url: '',
            title: '',
            tabs: [],
            interactedElement: [],
            screenshot: undefined,
          }),
          metadata: undefined,
        }))
        logger.info(`❌ ${agentRunError}`)
      }

      return this.state.history
    } catch (error) {
      logger.error('Error during agent execution:', error)
      agentRunError = String(agentRunError)
    } finally {
      signalHandler.unregister()
      if (!this.forceExitTelemetryLogged) {
        try {
          this.logAgentEvent(maxSteps, agentRunError)
          logger.info('Agent run telemetry logged.')
        } catch (error) {
          logger.error(`Failed to log telemetry event: ${error}`)
        }
      } else {
        logger.info('Telemetry for force exit (SIGINT) was logged by custom exit callback.')
      }

      // TODO: save playwright script

      await this.close()

      if (this.settings.generateGif) {
        let outputPath = 'agent_history.gif'
        if (typeof this.settings.generateGif === 'string') {
          outputPath = this.settings.generateGif
        }

        createHistoryGif({
          task: this.task,
          history: this.state.history,
          outputPath,
        })
      }
    }
  }

  @timeExecutionAsync('--multi-act (agent)')
  async multiAct(actions: ActionPayload[], checkForNewElements = false) {
    const results: ActionResult[] = []
    const cachedSelectorMap = await this.browserSession.getSelectorMap()
    const cachedPathHashes = new Set(Object.values(cachedSelectorMap).map(selector => selector.hash.branchPathHash))

    await this.browserSession.removeHighlights()

    for (const [i, action] of actions.entries()) {
      if (action.getIndex() !== undefined && i !== 0) {
        const newState = await this.browserSession.getStateSummary(false)
        const newSelectorMap = newState.selectorMap

        //  Detect index change after previous action
        const originTarget = cachedSelectorMap[action.getIndex()]
        const originTargetHash = originTarget?.hash.branchPathHash
        const newTarget = newSelectorMap[action.getIndex()]
        const newTargetHash = newTarget?.hash.branchPathHash
        if (originTargetHash !== newTargetHash) {
          const msg = `Element index changed after action ${i} / ${actions.length}, because page changed.`

          logger.info(msg)
          results.push(new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          }))
          break
        }

        const newPathHashes = new Set(Object.values(newSelectorMap).map(selector => selector.hash.branchPathHash))

        if (checkForNewElements && !isSubset(newPathHashes, cachedPathHashes)) {
          const msg = `Something new appeared after action ${i} / ${actions.length}.`
          logger.info(msg)

          results.push(new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          }))
        }
      }

      try {
        await this.throwErrorIfStoppedOrPaused()
        const result = await this.controller.act({
          action,
          browserContext: this.browserSession,
          pageExtractionLlm: this.settings.pageExtractionLlm,
          sensitiveData: this.sensitiveData,
          availableFilePaths: this.settings.availableFilePaths,
          context: this.context,
        })
        results.push(result)
        const actionData = { ...action }
        const actionName = Object.keys(actionData)[0]
        logger.debug(`Executed action ${i + 1} / ${actions.length}: ${actionName}`)
        if (results[results.length - 1].isDone || results[results.length - 1].error || i === actions.length - 1) {
          break
        }

        await sleep(this.browserProfile.waitBetweenActions)
      } catch (error) {
        logger.error(`Error during action execution: ${error}`)
      }
    }
    return results
  }

  /**
   * Validate the output of the last action is what the user wanted
   */
  async validateOutput(): Promise<boolean> {
    // Validation system message
    const systemMsg
    = `You are a validator of an agent who interacts with a browser. `
      + `Validate if the output of last action is what the user wanted and if the task is completed. `
      + `If the task is unclear defined, you can let it pass. But if something is missing or the image does not show what was requested dont let it pass. `
      + `Try to understand the page and help the model with suggestions like scroll, do x, ... to get the solution right. `
      + `Task to validate: ${this.task}. Return a JSON object with 2 keys: is_valid and reason. `
      + `is_valid is a boolean that indicates if the output is correct. `
      + `reason is a string that explains why it is valid or not.`
      + ` example: {"is_valid": false, "reason": "The user wanted to search for "cat photos", but the agent searched for "dog photos" instead."}`

    // If no browser session, we can't validate the output
    if (!this.browserContext) {
      return true
    }
    // Get current browser state
    const state = await this.browserSession.getStateSummary(false)

    // Create agent message with current state and results
    const content = new AgentMessagePrompt({
      state,
      result: this.state.lastResult,
      includeAttributes: this.settings.includeAttributes,
    })
    // Create message array for LLM
    const msg = [
      new SystemMessage(systemMsg),
      content.getUserMessage(this.settings.useVision),
    ]

    try {
      const validator = this.llm.withStructuredOutput(z.object({
        isValid: z.boolean(),
        reason: z.string(),
      }), {
        includeRaw: true,
      })

      // Get validation response
      const response = await validator.invoke(msg)
      const parsed = response.parsed

      // Check validation result
      const isValid = parsed.isValid

      if (!isValid) {
        logger.info(`❌ Validator decision: ${parsed.reason}`)
        const msg = `The output is not yet correct. ${parsed.reason}.`
        this.state.lastResult = [new ActionResult({
          extractedContent: msg,
          includeInMemory: true,
        })]
      } else {
        logger.info(`✅ Validator decision: ${parsed.reason}`)
      }

      return isValid
    } catch (error) {
    // If validation fails, log error and return true to continue
      logger.warn(`Error during output validation: ${error}`)
      return false
    }
  }

  /**
   * Log the completion of the task
   */
  async logCompletion() {
    if (this.state.history.isSuccessful()) {
      logger.info('✅ Task completed')
    } else {
      logger.info('❌ Unfinished')
    }

    const totalToken = this.state.history.totalInputTokens()
    logger.info(`📝 Total input tokens used (approximate): ${totalToken}`)
    if (this.registerDoneCallback) {
      await this.registerDoneCallback(this.state.history)
    }
  }

  /**
   * Re-run the history of the agent
   * @param history The history to re-run
   * @param maxRetries The maximum number of retries for each action
   * @param skipFailures Whether to skip failures or not
   * @param delayBetweenActions The delay between actions in seconds
   * @returns List of action results
   */
  async reRunHistory({
    history,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2,
  }: {
    history: AgentHistoryList
    maxRetries?: number
    skipFailures?: boolean
    delayBetweenActions?: number
  }): Promise<ActionResult[]> {
    if (this.initialActions.length) {
      const result = await this.multiAct(this.initialActions, false)
      this.state.lastResult = result
    }
    const results: ActionResult[] = []
    for (const [i, historyItem] of history.history.entries()) {
      const goal = historyItem.modelOutput ? historyItem.modelOutput.currentState.nextGoal : ''
      logger.info(`Replaying step ${i + 1}/${history.history.length}: goal: ${goal}`)
      if (!historyItem.modelOutput?.action.filter(Boolean).length) {
        logger.warn(`Step ${i + 1}: No action to replay, skipping`)
        results.push(new ActionResult({
          error: 'No action to replay',
        }))
        continue
      }

      let retryCount = 0

      while (retryCount < maxRetries) {
        try {
          const result = await this.executeHistoryStep(historyItem, delayBetweenActions)
          results.push(...result)
          break
        } catch (error) {
          retryCount += 1
          if (retryCount === maxRetries) {
            const errorMsg = `'Step ${i + 1} failed after ${maxRetries} attempts: ${error}'`
            logger.error(errorMsg)
            if (!skipFailures) {
              results.push(new ActionResult({
                error: errorMsg,
                includeInMemory: true,
              }))
              throw new Error(errorMsg)
            }
          } else {
            logger.warn(`Step ${i + 1} failed (attempt ${retryCount}/${maxRetries}), retrying...`)
            await sleep(delayBetweenActions)
          }
        }
      }
    }

    return results
  }

  /**
   * Execute a single step from history with element validation
   */
  async executeHistoryStep(historyItem: AgentHistory, delayBetweenActions: number): Promise<ActionResult[]> {
    const state = await this.browserSession.getStateSummary(false)
    if (!state || !historyItem.modelOutput) {
      throw new Error('Invalid state or model output')
    }
    const updateActions: ActionModel[] = []
    for (const [i, action] of historyItem.modelOutput.action.entries()) {
      const updateAction = this.updateActionIndices(historyItem.state.interactedElement[i], action, state)
      if (!updateAction) {
        throw new Error(`Could not find matching element ${i} in current page`)
      }
      updateActions.push(updateAction)
    }

    const results = this.multiAct(updateActions)
    await sleep(delayBetweenActions)
    return results
  }

  /**
   * Update action indices based on current page state.
   * Returns updated action or None if element cannot be found.
   */
  updateActionIndices(historicalElement: DOMHistoryElement | undefined, action: ActionModel, currentState: BrowserStateSummary) {
    if (!historicalElement || !currentState.elementTree) {
      return action
    }

    const currentElement = HistoryTreeProcessor.findHistoryElementInTree(historicalElement, currentState.elementTree)
    if (!currentElement || currentElement.highlightIndex === undefined) {
      return undefined
    }

    const oldIndex = action.getIndex()

    if (oldIndex !== currentElement.highlightIndex) {
      action.setIndex(currentElement.highlightIndex)
      logger.info(`Element moved in DOM, updated index from ${oldIndex} to ${currentElement.highlightIndex}`)
    }
    return action
  }

  async loadAndReturn({
    historyFile = 'AgentHistory.json',
    ...rest
  }: {
    historyFile?: string
    maxRetries?: number
    skipFailures?: boolean
    delayBetweenActions?: number
  }) {
    const history = await AgentHistoryList.loadFromFile(historyFile, this.AgentOutput)
    return this.reRunHistory({
      history,
      ...rest,
    })
  }

  async saveHistory(historyFile = 'AgentHistory.json') {
    await this.state.history.saveToFile(historyFile)
  }

  /**
   * Pause the agent before the next step
   */
  pause() {
    console.log('\n\n⏸️  Got Ctrl+C, paused the agent and left the browser open.')
    this.state.paused = true
  }

  async resume() {
    console.log('----------------------------------------------------------------------')
    console.log('▶️  Got Enter, resuming agent execution where it left off...\n')
    this.state.paused = false
    if (this.browser) {
      // await this.browser.re()
      // await sleep(5)
    }
  }

  stop() {
    logger.info('⏹️ Agent stopping')
    this.state.stopped = true
  }

  private convertInitialActions(actions: ExecuteActions[]) {
    const ActionModel = this.ActionModel
    return actions.map((action) => {
      // Each action_dict should have a single key-value pair
      const actionName = Object.keys(action)[0]
      let actionParams = action[actionName]

      // Get the parameter model for this action from registry
      const registerAction = this.controller.registry.registry.actions[actionName]
      if (!registerAction) {
        return false
      }
      actionParams = registerAction.paramSchema.parse(actionParams)
      const actionModel = new ActionModel({
        [actionName]: actionParams,
      })
      return actionModel
    }).filter(Boolean) as ActionModel[]
  }

  /**
   * Verify that the LLM API keys are setup and the LLM API is responding properly.
   * Helps prevent errors due to running out of API credits, missing env vars, or network issues.
   *
   * @returns True if connection is verified, false otherwise
   */
  private async verifyAndSetupLLM(): Promise<boolean> {
    /**
     * Verify that the LLM API keys are setup and the LLM API is responding properly.
     * Also handles tool calling method detection if in auto mode.
     */
    this.toolCallingMethod = await this.setToolCallingMethod()

    // Skip verification if already done
    if ((this.llm as any)._verifiedApiKeys === true || SKIP_LLM_API_KEY_VERIFICATION) {
      (this.llm as any)._verifiedApiKeys = true
      return true
    }

    return true
  }

  async runPlanner(): Promise<string | undefined> {
    // Skip planning if no planner_llm is set
    if (!this.settings.plannerLlm) {
      return undefined
    }

    // Get current state to filter actions by page
    const page = await this.browserSession.getCurrentPage()

    // Get all standard actions (no filter) and page-specific actions
    const standardActions = this.controller.registry.getPromptDescription()
    const pageActions = this.controller.registry.getPromptDescription(page)
    let allActions = standardActions
    if (pageActions) {
      allActions += `\n${pageActions}`
    }

    // Create planner message history using full message history with all available actions
    const plannerMessages = [
      new PlannerPrompt(allActions).getSystemMessage(this.settings.isPlannerReasoning, this.settings.extendPlannerSystemMessage),
      ...this.messageManager.getMessages().slice(1),
    ]

    if (!this.settings.useVisionForPlanner && this.settings.useVision) {
      const lastStateMessage = plannerMessages.at(-1)!
      let newMsg = ''
      if (Array.isArray(lastStateMessage.content)) {
        for (const msg of lastStateMessage.content) {
          if (msg.type === 'text') {
            // @ts-expect-error
            newMsg += msg.content
          }
        }
      } else {
        newMsg = lastStateMessage.content
      }
      plannerMessages[plannerMessages.length - 1] = new HumanMessage({
        content: newMsg,

      })
    }

    let response: AIMessageChunk
    try {
      response = await this.settings.plannerLlm.invoke(plannerMessages)
    } catch (error) {
      logger.error(`Failed to invoke planner: ${error}`)
      throw new LLMException(401, 'LLM API call failed')
    }
    let plan = response.content.toString()

    if (this.plannerModelName && (this.plannerModelName.toLowerCase().includes('deepseek-r1') || this.plannerModelName.toLowerCase().includes('deepseek-reasoner'))) {
      plan = this.removeThinkTags(plan)
    }

    try {
      const planJson = JSON.parse(plan)
      logger.info(`Planning Analysis:\n${JSON.stringify(planJson, null, 2)}`)
    } catch (error) {
      logger.error(`Failed to parse plan JSON: ${error}`)
    }

    return plan
  }

  async close() {
    try {
      this.browserSession.stop()
    } catch (error) {
      logger.error('Error closing browser:', error)
    }
  }

  updateActionModelsForPage(page: Page) {
    // Create new action model with current page's filtered actions
    this.ActionModel = this.controller.registry.createActionModel({
      page,
    })

    // Update output model with the new actions
    this.AgentOutput = AgentOutput.typeWithCustomActions(this.ActionModel)

    // Update done action model too
    this.DoneActionModel = this.controller.registry.createActionModel({
      page,
      includeActions: ['done'],
    })

    this.DoneAgentOutput = AgentOutput.typeWithCustomActions(this.DoneActionModel)
  }
}
