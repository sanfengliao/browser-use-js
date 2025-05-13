import type { BrowserConfig } from '@/browser/browser'
import type { BrowserContextConfig } from '@/browser/context'

import type { BrowserStateHistory } from '@/browser/view'

import type { ActionModel, ExecuteActions } from '@/controller/registry/view'
import type { DOMHistoryElement } from '@/dom/history_tree_processor/view'
import type { DOMElementNode, SelectorMap } from '@/dom/views'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import fs from 'node:fs/promises'
import { HistoryTreeProcessor } from '../dom/history_tree_processor/service'

// Types for tool calling method
type ToolCallingMethod = 'function_calling' | 'json_mode' | 'raw' | 'auto' | 'tools'

// Required LLM API environment variables
const REQUIRED_LLM_API_ENV_VARS: Record<string, string[]> = {
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
 * Options for the agent
 */
export class AgentSettings {
  /**
   * Whether to use vision capabilities
   */
  useVision: boolean = true

  /**
   * Whether to use vision for the planner
   */
  useVisionForPlanner: boolean = false

  /**
   * Path to save conversation history
   */
  saveConversationPath?: string

  /**
   * Encoding for saved conversation files
   */
  saveConversationPathEncoding: string = 'utf-8'

  /**
   * Maximum number of failures allowed before stopping
   */
  maxFailures: number = 3

  /**
   * Delay in seconds before retrying after failure
   */
  retryDelay: number = 10

  /**
   * Maximum tokens for input context
   */
  maxInputTokens: number = 128000

  /**
   * Whether to validate model output against schema
   */
  validateOutput: boolean = false

  /**
   * Additional context to include in messages
   */
  messageContext?: string

  /**
   * Whether to generate GIF of interaction (true/false or path)
   */
  generateGif: boolean | string = false

  /**
   * Available file paths for agent to use
   */
  availableFilePaths?: string[]

  /**
   * Completely replace system message
   */
  overrideSystemMessage?: string

  /**
   * Add content to existing system message
   */
  extendSystemMessage?: string

  /**
   * DOM attributes to include in element tree
   */
  includeAttributes: string[] = [
    'title',
    'type',
    'name',
    'role',
    'tabindex',
    'aria-label',
    'placeholder',
    'value',
    'alt',
    'aria-expanded',
  ]

  /**
   * Maximum number of actions agent can perform per step
   */
  maxActionsPerStep: number = 10

  /**
   * Method to use for tool calling
   */
  toolCallingMethod: ToolCallingMethod = 'auto'

  /**
   * LLM to use for page content extraction
   */
  pageExtractionLlm?: BaseChatModel

  /**
   * LLM to use for planning
   */
  plannerLlm?: BaseChatModel

  /**
   * Run planner every N steps
   */
  plannerInterval: number = 1

  /**
   * Whether the planner is currently reasoning
   */
  isPlannerReasoning: boolean = false

  /**
   * Additional content to add to planner system message
   */
  extendPlannerSystemMessage?: string

  /**
   * Path to save the generated Playwright script
   */
  savePlaywrightScriptPath?: string

  constructor(init?: Partial<AgentSettings>) {
    Object.assign(this, init)
  }
}

/**
 * Current state of the agent
 */
export interface AgentBrain {
  memory: string
  nextGoal: string
  evaluationPreviousGoal: string
}

/**
 * Metadata for a single step including timing and token information
 */
export class StepMetadata {
  /**
   * Start time of this step
   */
  stepStartTime: number

  /**
   * End time of this step
   */
  stepEndTime: number

  /**
   * Approximate tokens from message manager for this step
   */
  inputTokens: number

  /**
   * Step number
   */
  stepNumber: number

  constructor(data: {
    stepStartTime: number
    stepEndTime: number
    inputTokens: number
    stepNumber: number
  }) {
    this.stepStartTime = data.stepStartTime
    this.stepEndTime = data.stepEndTime
    this.inputTokens = data.inputTokens
    this.stepNumber = data.stepNumber
  }

  /**
   * Calculate step duration in seconds
   */
  get durationSeconds(): number {
    return this.stepEndTime - this.stepStartTime
  }
}
export interface ActionResultData {
  isDone?: boolean
  success?: boolean
  extractedContent?: string
  error?: string
  includeInMemory?: boolean
}

export class ActionResult implements ActionResultData {
  isDone: boolean
  success?: boolean
  extractedContent?: string
  error?: string
  includeInMemory?: boolean

  constructor(data: ActionResultData = {}) {
    this.isDone = data.isDone || false
    this.success = data.success
    this.extractedContent = data.extractedContent
    this.error = data.error
    this.includeInMemory = data.includeInMemory || false
  }
}

/**
 * Output model for agent
 *
 * @dev note: this model is extended with custom actions in AgentService. You can also use some fields
 * that are not in this model as provided by the linter, as long as they are registered in the DynamicActions model.
 */
export class AgentOutput {
  /**
   * Current state of the agent
   */
  currentState: AgentBrain

  /**
   * List of actions to execute
   */

  action: ActionModel[]

  /**
   * Model configuration allowing arbitrary types
   */
  static modelConfig = {
    arbitraryTypesAllowed: true,
  }

  /**
   * Create a new AgentOutput instance
   */
  constructor(data: {
    currentState: AgentBrain
    action: ActionModel[]
  }) {
    this.currentState = data.currentState
    this.action = data.action
  }

  /**
   * Extend actions with custom actions
   */
  static typeWithCustomActions<T extends ExecuteActions>(customActions: T): typeof AgentOutput {
    class ExtendedAgentOutput extends AgentOutput {
      constructor(data: {
        currentState: AgentBrain
        action: T[]
      }) {
        super(data)
      }
    }

    // Set documentation
    Object.defineProperty(ExtendedAgentOutput, 'name', { value: 'AgentOutput' })
    Object.defineProperty(ExtendedAgentOutput, '__doc__', { value: 'AgentOutput model with custom actions' })

    return ExtendedAgentOutput
  }
}

/**
 * History item for agent actions
 */
export class AgentHistory {
  /**
   * Output from the agent model
   */
  modelOutput?: AgentOutput

  /**
   * Results of executed actions
   */
  result: ActionResultData[]

  /**
   * State of the browser at this point in history
   */
  state: BrowserStateHistory

  /**
   * Metadata about this step including timing and token information
   */
  metadata?: StepMetadata

  constructor(data: {
    modelOutput?: AgentOutput
    result: ActionResultData[]
    state: BrowserStateHistory
    metadata?: StepMetadata
  }) {
    this.modelOutput = data.modelOutput
    this.result = data.result
    this.state = data.state
    this.metadata = data.metadata
  }

  /**
   * Get elements that were interacted with during this history step
   */
  static getInteractedElement(
    modelOutput: AgentOutput,
    selectorMap: SelectorMap,
  ): (DOMHistoryElement | undefined)[] {
    const elements: (DOMHistoryElement | undefined)[] = []

    for (const action of modelOutput.action) {
      const index = action.getIndex()
      if (index !== undefined && index in selectorMap) {
        const el: DOMElementNode = selectorMap[index]
        elements.push(HistoryTreeProcessor.convertDomElementToHistoryElement(el))
      }
      else {
        elements.push(undefined)
      }
    }

    return elements
  }

  /**
   * Custom serialization handling circular references
   */
  modelDump(kwargs: Record<string, any> = {}) {
    let modelOutputDump: AgentOutput | undefined
    if (this.modelOutput) {
      const actionDump = this.modelOutput.action.slice()

      modelOutputDump = {
        currentState: this.modelOutput.currentState,
        action: actionDump, // This preserves the actual action data
      }
    }

    return {
      modelOutput: modelOutputDump,
      result: this.result,
      state: this.state.toDict(),
      metadata: this.metadata,
    }
  }
}

/**
 * Interface for saving playwright scripts
 */
interface SavePlaywrightScriptOptions {
  /**
   * The path where the generated script will be saved
   */
  outputPath: string

  /**
   * A list of keys used as placeholders for sensitive data
   * (e.g., ['username_placeholder', 'password_placeholder']).
   * These will be loaded from environment variables in the generated script.
   */
  sensitiveDataKeys?: string[]

  /**
   * Configuration of the original Browser instance
   */
  browserConfig?: BrowserConfig

  /**
   * Configuration of the original BrowserContext instance
   */
  contextConfig?: BrowserContextConfig
}

/**
 * List of agent history items
 */
export class AgentHistoryList {
  /**
   * History items
   */
  history: AgentHistory[]

  /**
   * Create a new AgentHistoryList
   */
  constructor(data: { history: AgentHistory[] }) {
    this.history = data.history
  }

  /**
   * Get total duration of all steps in seconds
   */
  totalDurationSeconds(): number {
    let total = 0.0
    for (const h of this.history) {
      if (h.metadata) {
        total += h.metadata.durationSeconds
      }
    }
    return total
  }

  /**
   * Get total tokens used across all steps.
   * Note: These are from the approximate token counting of the message manager.
   * For accurate token counting, use tools like LangChain Smith or OpenAI's token counters.
   */
  totalInputTokens(): number {
    let total = 0
    for (const h of this.history) {
      if (h.metadata) {
        total += h.metadata.inputTokens
      }
    }
    return total
  }

  /**
   * Get token usage for each step
   */
  inputTokenUsage(): number[] {
    return this.history
      .filter(h => h.metadata)
      .map(h => h.metadata!.inputTokens)
  }

  /**
   * Representation of the AgentHistoryList object
   */
  toString(): string {
    return `AgentHistoryList(all_results=${JSON.stringify(this.actionResults())}, all_model_outputs=${JSON.stringify(this.modelActions())})`
  }

  /**
   * Save history to JSON file with proper serialization
   */
  async saveToFile(filepath: string): Promise<void> {
    const pathStr = filepath.toString()
    const dirPath = pathStr.substring(0, pathStr.lastIndexOf('/'))

    await fs.mkdir(dirPath, { recursive: true })
    const data = this.modelDump()
    await fs.writeFile(pathStr, JSON.stringify(data, null, 2), { encoding: 'utf-8' })
  }

  /**
   * Generates a Playwright script based on the agent's history and saves it to a file.
   *
   * @param options Configuration options for saving the playwright script
   */
  // async saveAsPlaywrightScript(options: SavePlaywrightScriptOptions): Promise<void> {
  //   const serializedHistory = this.modelDump().history
  //   const generator = new PlaywrightScriptGenerator(
  //     serializedHistory,
  //     options.sensitiveDataKeys,
  //     options.browserConfig,
  //     options.contextConfig,
  //   )
  //   const scriptContent = generator.generateScriptContent()

  //   const pathStr = options.outputPath.toString()
  //   const dirPath = pathStr.substring(0, pathStr.lastIndexOf('/'))

  //   await fs.mkdir(dirPath, { recursive: true })
  //   await fs.writeFile(pathStr, scriptContent, { encoding: 'utf-8' })
  // }

  /**
   * Custom serialization that properly uses AgentHistory's modelDump
   */
  modelDump(kwargs: Record<string, any> = {}): Record<string, any> {
    return {
      history: this.history.map(h => h.modelDump(kwargs)),
    }
  }

  /**
   * Load history from JSON file
   */
  static async loadFromFile(
    filepath: string,
    outputModel: typeof AgentOutput,
  ): Promise<AgentHistoryList> {
    const pathStr = filepath.toString()
    const data = JSON.parse(await fs.readFile(pathStr, { encoding: 'utf-8' }))

    // Create and validate the model
    return AgentHistoryList.modelValidate(data)
  }

  /**
   * Validate the model from JSON data
   */
  static modelValidate(data: Record<string, any>): AgentHistoryList {
    // In TypeScript we'd need to implement proper validation
    // This is a simplified version
    return new AgentHistoryList({
      history: data.history.map((h: any) => new AgentHistory(h)),
    })
  }

  /**
   * Last action in history
   */
  lastAction() {
    if (this.history.length && this.history[this.history.length - 1].modelOutput) {
      const actions = this.history[this.history.length - 1].modelOutput!.action
      return actions[actions.length - 1]
    }
    return null
  }

  /**
   * Get all errors from history, with null for steps without errors
   */
  errors(): (string | null)[] {
    return this.history.map((h) => {
      const stepErrors = h.result
        .filter(r => r.error)
        .map(r => r.error!)

      // Each step can have only one error
      return stepErrors.length ? stepErrors[0] : null
    })
  }

  /**
   * Final result from history
   */
  finalResult(): string | null {
    if (this.history.length && this.history[this.history.length - 1].result.length > 0) {
      return this.history[this.history.length - 1].result[
        this.history[this.history.length - 1].result.length - 1
      ].extractedContent ?? null
    }
    return null
  }

  /**
   * Check if the agent is done
   */
  isDone(): boolean {
    if (this.history.length && this.history[this.history.length - 1].result.length > 0) {
      const lastResult = this.history[this.history.length - 1].result[
        this.history[this.history.length - 1].result.length - 1
      ]
      return lastResult.isDone === true
    }
    return false
  }

  /**
   * Check if the agent completed successfully - the agent decides in the last step if it was successful or not.
   * Returns null if not done yet.
   */
  isSuccessful(): boolean | null {
    if (this.history.length && this.history[this.history.length - 1].result.length > 0) {
      const lastResult = this.history[this.history.length - 1].result[
        this.history[this.history.length - 1].result.length - 1
      ]
      if (lastResult.isDone === true) {
        return lastResult.success ?? null
      }
    }
    return null
  }

  /**
   * Check if the agent has any non-null errors
   */
  hasErrors(): boolean {
    return this.errors().some(error => error !== null)
  }

  /**
   * Get all unique URLs from history
   */
  urls(): (string | null)[] {
    return this.history.map(h => h.state.url ?? null)
  }

  /**
   * Get all screenshots from history
   */
  screenshots(): (string | null)[] {
    return this.history.map(h => h.state.screenshot ?? null)
  }

  /**
   * Get all action names from history
   */
  actionNames(): string[] {
    return this.modelActions().map((action) => {
      const actions = Object.keys(action)
      return actions.length ? actions[0] : ''
    }).filter(name => name !== '')
  }

  /**
   * Get all thoughts from history
   */
  modelThoughts(): AgentBrain[] {
    return this.history
      .filter(h => h.modelOutput)
      .map(h => h.modelOutput!.currentState)
  }

  /**
   * Get all model outputs from history
   */
  modelOutputs(): AgentOutput[] {
    return this.history
      .filter(h => h.modelOutput)
      .map(h => h.modelOutput!)
  }

  /**
   * Get all actions from history
   */
  modelActions(): Record<string, any>[] {
    const outputs: Record<string, any>[] = []

    for (const h of this.history) {
      if (h.modelOutput) {
        h.modelOutput.action.forEach((action, i) => {
          const output = action
          output.interacted_element = h.state.interactedElement?.[i]
          outputs.push(output)
        })
      }
    }

    return outputs
  }

  /**
   * Get all results from history
   */
  actionResults(): ActionResultData[] {
    const results: ActionResultData[] = []
    for (const h of this.history) {
      results.push(...h.result.filter(r => r))
    }
    return results
  }

  /**
   * Get all extracted content from history
   */
  extractedContent(): string[] {
    const content: string[] = []
    for (const h of this.history) {
      content.push(...h.result
        .filter(r => r.extractedContent)
        .map(r => r.extractedContent!),
      )
    }
    return content
  }

  /**
   * Get all model actions from history as JSON, optionally filtered by action type
   */
  modelActionsFiltered(include?: string[]): Record<string, any>[] {
    if (!include) {
      include = []
    }

    const outputs = this.modelActions()
    const result: Record<string, any>[] = []

    for (const o of outputs) {
      for (const i of include) {
        if (i === Object.keys(o)[0]) {
          result.push(o)
        }
      }
    }

    return result
  }

  /**
   * Get the number of steps in the history
   */
  numberOfSteps(): number {
    return this.history.length
  }
}
