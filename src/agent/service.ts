import { Browser } from '@/browser/browser'
import { BrowserContext } from '@/browser/context'
import { BrowserState } from '@/browser/view'
import { ActionModel, ExecuteActions } from '@/controller/registry/view'
import { Controller } from '@/controller/service'
import { Logger } from '@/logger'
import { ProductTelemetry } from '@/telemetry/service'
import { checkEnvVariables } from '@/utils'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage } from '@langchain/core/messages'
import { config } from 'dotenv'
import { Memory } from './memory/service'
import { MemoryConfig } from './memory/views'
import { MessageManager } from './message_manager/service'
import { isModelWithoutToolSupport } from './message_manager/utils'
import { SystemPrompt } from './prompt'
import { AgentHistoryList, AgentOutput, AgentSettings, AgentState } from './views'

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

  /** Controller for browser actions */
  controller?: Controller<Context>

  /** Sensitive data to be used in browser operations */
  sensitiveData?: Record<string, string>

  /** Initial actions to execute before starting the agent */
  initialActions?: Array<Record<string, Record<string, any>>>

  /** Callback for registering new steps */
  registerNewStepCallback?: (
    state: BrowserState,
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

  // Browser components
  private browser: Browser
  private browserContext: BrowserContext
  private injectedBrowser: boolean
  private injectedBrowserContext: boolean

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
  private initialActions: any[] | null = null

  // Model information
  private modelName!: string
  private plannerModelName?: string
  private chatModelLibrary!: string
  private toolCallingMethod?: ToolCallingMethod

  // Message management
  private messageManager!: MessageManager

  // Callbacks
  private registerNewStepCallback?: (
    state: BrowserState,
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
  // private version: string
  // private source: string

  private isInitialized = false

  /**
   * Initialize an Agent instance
   * @param params Agent parameters
   */
  constructor(params: AgentParams<Context>) {
    const {
      task,
      llm,
      browser,
      browserContext,
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
    }

    // Model setup
    this.setModelNames()
    this.toolCallingMethod = this.setToolCallingMethod()

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

    // Huge security warning if sensitive_data is provided but allowed_domains is not set
    if (this.sensitiveData && !(browser?.config?.newContextConfig?.allowedDomains)) {
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
    }

    // Browser setup
    this.injectedBrowser = Boolean(browser)
    this.injectedBrowserContext = Boolean(browserContext)
    this.browser = browser || new Browser()

    if (this.browser.config) {
      this.browser.config.newContextConfig.disableSecurity = this.browser.config.disableSecurity
    }

    this.browserContext = browserContext || new BrowserContext({
      browser: this.browser,
      config: this.browser.config.newContextConfig,
    })

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

    await this.verifyLlmConnection() // Verify we can connect to the LLM

    this.isInitialized = true
  }

  private setupActionModels() {
    this.ActionModel = this.controller.registry.createActionModel()
    this.AgentOutput = AgentOutput.typeWithCustomActions(this.ActionModel)
    this.DoneActionModel = this.controller.registry.createActionModel({
      includeActions: ['done'],
    })
    this.DoneAgentOutput = AgentOutput.typeWithCustomActions(this.DoneActionModel)
  }

  private convertInitialActions(actions: ExecuteActions[]) {
    const ActionModel = this.ActionModel
    return actions.map((action) => {
      const actionName = Object.keys(action)[0]
      let actionParams = action[actionName]
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

  private setModelNames() {
    // @ts-expect-error
    this.chatModelLibrary = this.llm.constructor.lc_name()
    // @ts-expect-error
    this.modelName = this.llm.model || this.llm.modelName || 'Unknown'
    // @ts-expect-error
    this.plannerModelName = this.settings.plannerLlm?.model || this.settings.plannerLlm?.modelName || 'Unknown'
  }

  /**
   * Determines the appropriate tool calling method based on model and settings
   *
   * @returns The tool calling method to use or null
   */
  private setToolCallingMethod(): ToolCallingMethod | undefined {
    const toolCallingMethod = this.settings.toolCallingMethod

    if (toolCallingMethod === 'auto') {
      // Automatically determine the best tool calling method based on model
      if (isModelWithoutToolSupport(this.modelName)) {
        return 'raw'
      } else if (this.chatModelLibrary === 'ChatGoogleGenerativeAI') {
        return undefined
      } else if (this.chatModelLibrary === 'ChatOpenAI') {
        return 'function_calling'
      } else if (this.chatModelLibrary === 'AzureChatOpenAI') {
        // Azure OpenAI API requires 'tools' parameter for GPT-4
        // The error 'content must be either a string or an array' occurs when
        // the API expects a tools array but gets something else
        if (this.modelName.toLowerCase().includes('gpt-4')) {
          return 'tools'
        } else {
          return 'function_calling'
        }
      } else {
        return undefined
      }
    } else {
      // Use the explicitly provided tool calling method
      return toolCallingMethod
    }
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

  /**
   * Verify that the LLM API keys are setup and the LLM API is responding properly.
   * Helps prevent errors due to running out of API credits, missing env vars, or network issues.
   *
   * @returns True if connection is verified, false otherwise
   */
  private async verifyLlmConnection(): Promise<boolean> {
    logger.debug(`Verifying the ${this.llm.constructor.name} LLM knows the capital of France...`)

    if ((this.llm as any)._verifiedApiKeys === true || SKIP_LLM_API_KEY_VERIFICATION) {
    // skip roundtrip connection test for speed in cloud environment
    // If the LLM API keys have already been verified during a previous run, skip the test
      (this.llm as any)._verifiedApiKeys = true
      return true
    }

    const { chatModelLibrary } = this
    // show a warning if it looks like any required environment variables are missing
    // @ts-expect-error
    const requiredKeys = REQUIRED_LLM_API_ENV_VARS[chatModelLibrary] || []
    if (requiredKeys.length > 0 && !checkEnvVariables(requiredKeys, 'all')) {
      const error = `Expected LLM API Key environment variables might be missing for ${chatModelLibrary}: ${requiredKeys.join(' ')}`
      logger.warn(`❌ ${error}`)
    }

    // send a basic sanity-test question to the LLM and verify the response
    const testPrompt = 'What is the capital of France? Respond with a single word.'
    const testAnswer = 'paris'
    try {
    // dont convert this to async! it *should* block any subsequent llm calls from running
      const response = await this.llm.invoke([new HumanMessage(testPrompt)])
      const responseText = String(response.content).toLowerCase()

      if (responseText.includes(testAnswer)) {
        logger.debug(
          `🪪 LLM API keys ${requiredKeys.join(', ')} work, ${this.llm.constructor.name} model is connected & responding correctly.`,
        );
        (this.llm as any)._verifiedApiKeys = true
        return true
      } else {
        logger.warn(
          '❌  Got bad LLM response to basic sanity check question: \n\t  %s\n\t\tEXPECTING: %s\n\t\tGOT: %s',
          testPrompt,
          testAnswer,
          response,
        )
        throw new Error('LLM responded to a simple test question incorrectly')
      }
    } catch (e) {
      (this.llm as any)._verifiedApiKeys = false
      if (requiredKeys.length > 0) {
        logger.error(
          `\n\n❌  LLM ${this.llm.constructor.name} connection test failed. Check that ${requiredKeys.join(', ')} is set correctly in .env and that the LLM API account has sufficient funding.\n\n${e}\n`,
        )
        return false
      } else {
        throw e
      }
    }
  }
}
