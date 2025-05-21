import { Browser } from '@/browser/browser'
import { BrowserContext } from '@/browser/context'
import { BrowserState, BrowserStateHistory } from '@/browser/view'
import { ActionModel, ActionPayload, ExecuteActions } from '@/controller/registry/view'
import { Controller } from '@/controller/service'
import { DOMHistoryElement } from '@/dom/history_tree_processor/view'
import { LLMException } from '@/error'
import { Logger } from '@/logger'
import { ProductTelemetry } from '@/telemetry/service'
import { AgentEndTelemetryEvent, AgentRunTelemetryEvent, AgentStepTelemetryEvent } from '@/telemetry/view'
import { checkEnvVariables, isSubset, SignalHandler, sleep, timeExecutionAsync } from '@/utils'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessageChunk, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { config } from 'dotenv'
import { RateLimitError } from 'openai'
import { Page } from 'playwright'
import { z } from 'zod'
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
  private version: string = '1.0.0'
  private source: string = 'browser-use'

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
    } else {
      this.initialActions = []
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
    this.chatModelLibrary = (this.llm.constructor as typeof BaseChatModel).lc_name()
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
    const signalHandler = new SignalHandler({
      pauseCallback: () => this.pause(),
      resumeCallback: () => this.resume(),
      exitOnSecondInt: true,
    })

    signalHandler.register()

    await this.init()
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
          break
        }

        if (this.state.stopped) {
          logger.info('Agent stopped')
          break
        }

        while (this.state.paused) {
          await sleep(0.2) // Small delay to prevent CPU spinning
          if (this.state.stopped) { // Allow stopping while paused
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
        const errorMessage = 'Failed to complete task in maximum steps'
        this.state.history.history.push(new AgentHistory({
          modelOutput: undefined,
          result: [new ActionResult({
            error: errorMessage,
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
        logger.info(`❌ ${errorMessage}`)
      }

      return this.state.history
    } catch (error) {
      logger.error('Error during agent execution:', error)
    } finally {
      signalHandler.unregister()
      this.telemetry.capture(new AgentEndTelemetryEvent({
        agentId: this.state.agentId,
        isDone: this.state.history.isDone(),
        success: this.state.history.isSuccessful(),
        steps: this.state.nSteps,
        maxStepsReached: this.state.nSteps >= maxSteps,
        errors: this.state.history.errors(),
        totalDurationSeconds: this.state.history.totalDurationSeconds(),
        totalInputTokens: this.state.history.totalInputTokens(),
      }))

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
      await this.browser.init()
      await sleep(5)
    }
  }

  stop() {
    logger.info('⏹️ Agent stopping')
    this.state.stopped = true
  }

  close() {
    throw new Error('Method not implemented.')
  }

  logCompletion() {
    throw new Error('Method not implemented.')
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
    if (!this.browserContext.session) {
      return true
    }
    // Get current browser state
    const state = await this.browserContext.getState(false)

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

  async step(stepInfo: AgentStepInfo) {
    logger.info(`📍 Step ${this.state.nSteps}`)
    let state: BrowserState | undefined
    let modelOutput!: AgentOutput
    let result: ActionResult[] = []
    const stepStartTime = Date.now()
    let tokens = 0
    try {
      state = await this.browserContext.getState(true)
      const currentPage = await this.browserContext.getCurrentPage()

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
        state,
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
          await Promise.resolve(this.registerNewStepCallback(state, modelOutput, this.state.nSteps))
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

      const actions = (modelOutput.action || []).map(action => ({ ...action }))

      this.telemetry.capture(new AgentStepTelemetryEvent({
        agentId: this.state.agentId,
        step: this.state.nSteps,
        actions,
        consecutiveFailures: this.state.consecutiveFailures,
        stepError: result.length > 0 ? result.map(r => r.error).filter(Boolean) as string[] : ['No result'],

      }))

      if (result.length <= 0) {
        return
      }

      if (state) {
        const metadata = new StepMetadata({
          stepNumber: this.state.nSteps,
          stepStartTime,
          stepEndTime,
          inputTokens: tokens,
        })
        this.makeHistoryItem({
          modelOutput,
          state,
          result,
          metadata,
        })
      }
    }
  }

  /**
   * Create and store history item
   */
  makeHistoryItem({
    modelOutput,
    state,
    result,
    metadata,
  }: { modelOutput: AgentOutput, state: BrowserState, result: ActionResult[], metadata: StepMetadata }) {
    // Get interacted elements from model output and state selector map
    let interactedElements: (DOMHistoryElement | undefined)[]

    if (modelOutput) {
      interactedElements = AgentHistory.getInteractedElement(modelOutput, state.selectorMap)
    } else {
      interactedElements = [undefined]
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
      logger.debug(`Using ${this.toolCallingMethod} for ${this.chatModelLibrary}`)
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
        logger.debug(`Using ${this.toolCallingMethod} for ${this.chatModelLibrary}`)
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

    return response.parsed
  }

  convertInputMessages(inputMessages: BaseMessage[]): BaseMessage[] {
    if (isModelWithoutToolSupport(this.modelName)) {
      return convertInputMessages(inputMessages, this.modelName)
    }
    return inputMessages
  }

  async runPlanner(): Promise<string | undefined> {
    // Skip planning if no planner_llm is set
    if (!this.settings.plannerLlm) {
      return undefined
    }

    // Get current state to filter actions by page
    const page = await this.browserContext.getCurrentPage()

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

  removeThinkTags(text: string): string {
    // Step 1: Remove well-formed <think>...</think>
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '')
    // Step 2: If there's an unmatched closing tag </think>,
    //        remove everything up to and including that.
    text = text.replace(/[\s\S]*?<\/think>/g, '')
    return text.trim()
  }

  @timeExecutionAsync('--multi-act (agent)')
  async multiAct(actions: ActionPayload[], checkForNewElements = false) {
    const results: ActionResult[] = []
    const cachedSelectorMap = await this.browserContext.getSelectorMap()
    const cachedPathHashes = new Set(Object.values(cachedSelectorMap).map(selector => selector.hash.branchPathHash))

    await this.browserContext.removeHighlights()

    for (const [i, action] of actions.entries()) {
      if (action.getIndex() !== undefined && i !== 0) {
        const newState = await this.browserContext.getState(true)
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
          browserContext: this.browserContext,
          pageExtractionLlm: this.settings.pageExtractionLlm,
          sensitiveData: this.sensitiveData,
          availableFilePaths: this.settings.availableFilePaths,
          context: this.context,
        })
        results.push(result)

        logger.debug(`Executed action ${i + 1} / ${actions.length}`)
        if (results[results.length - 1].isDone || results[results.length - 1].error || i === actions.length - 1) {
          break
        }

        await sleep(this.browserContext.config.waitBetweenActions)
      } catch (error) {
        // TODO: handle cancel error
      }
    }
    return results
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

  /**
   * Log the agent run
   */
  private logAgentRun() {
    logger.info(`🚀 Starting task: ${this.task}`)
    this.telemetry.capture(new AgentRunTelemetryEvent({
      agentId: this.state.agentId,
      useVision: this.settings.useVision,
      task: this.task,
      modelName: this.modelName,
      chatModelLibrary: this.chatModelLibrary,
      version: this.version,
      source: this.source,
    }))
  }

  addNewTask(task: string) {
    this.messageManager.addNewTask(task)
  }
}
