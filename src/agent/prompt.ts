import type { BrowserStateSummary } from '../browser/views'
import type { ActionResult, AgentStepInfo } from './views'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { PromptTemplate } from '@langchain/core/prompts'

/**
 * Class that handles system prompts for the agent
 */
export class SystemPrompt {
  /** Default action description to include in the prompt */
  protected defaultActionDescription: string
  /** Maximum number of actions allowed per step */
  protected maxActionsPerStep: number
  /** System message to use for the agent */
  protected systemMessage!: SystemMessage
  /** Template for the prompt */
  protected promptTemplate: string = ''

  private isInitialized = false

  /**
   * Initialize a new SystemPrompt
   *
   * @param actionDescription Description of available actions
   * @param maxActionsPerStep Maximum number of actions allowed per step
   * @param overrideSystemMessage Optional complete system message to use instead of template
   * @param extendSystemMessage Optional text to append to system message
   */
  constructor(
    {
      actionDescription,
      maxActionsPerStep = 10,
    }: {
      actionDescription: string
      maxActionsPerStep?: number

    },
  ) {
    this.defaultActionDescription = actionDescription
    this.maxActionsPerStep = maxActionsPerStep
  }

  async init({ overrideSystemMessage, extendSystemMessage }: {
    overrideSystemMessage?: string
    extendSystemMessage?: string
  } = {}) {
    if (this.isInitialized) {
      return
    }
    let prompt = ''

    if (overrideSystemMessage) {
      prompt = overrideSystemMessage
    } else {
      const promptTemplate = await this.loadPromptTemplate()
      prompt = await promptTemplate.format({
        max_actions: String(this.maxActionsPerStep),
      })
    }

    if (extendSystemMessage) {
      prompt += `\n${extendSystemMessage}`
    }

    this.systemMessage = new SystemMessage(prompt)
    this.isInitialized = true
  }

  /**
   * Load the prompt template from the markdown file.
   */
  protected async loadPromptTemplate() {
    try {
      // In TypeScript, we need to handle file paths differently
      const filePath = path.resolve(import.meta.dirname, './system_prompt.md')
      return PromptTemplate.fromTemplate(await fs.readFile(filePath, 'utf-8'))
    } catch (e) {
      throw new Error(`Failed to load system prompt template: ${e}`)
    }
  }

  /**
   * Get the system prompt for the agent.
   *
   * @returns Formatted system prompt
   */
  getSystemMessage(...params: any[]): SystemMessage {
    if (!this.isInitialized) {
      throw new Error('SystemPrompt not initialized. Call init() before using.')
    }
    return this.systemMessage
  }
}

/**
 * Class that handles message prompts for the agent based on browser state
 */
export class AgentMessagePrompt {
  /** Current browser state */
  private state: BrowserStateSummary
  /** Results from previous actions */
  private result?: ActionResult[]
  /** Attributes to include in element descriptions */
  private includeAttributes: string[]
  /** Information about the current step */
  private stepInfo?: AgentStepInfo

  /**
   * Initialize a new AgentMessagePrompt
   *
   * @param state Current browser state
   * @param result Optional results from previous actions
   * @param includeAttributes Optional list of element attributes to include
   * @param stepInfo Optional information about the current step
   */
  constructor(
    {
      state,
      result,
      includeAttributes,
      stepInfo,
    }: {
      state: BrowserStateSummary
      result?: ActionResult[]
      includeAttributes?: string[]
      stepInfo?: AgentStepInfo
    },
  ) {
    this.state = state
    this.result = result
    this.includeAttributes = includeAttributes || []
    this.stepInfo = stepInfo
  }

  /**
   * Generate a user message based on the current browser state
   *
   * @param useVision Whether to include screenshots for vision models
   * @returns Human message with browser state information
   */
  getUserMessage(useVision: boolean = true): HumanMessage {
    const elementsText = this.state.elementTree.clickableElementsToString(this.includeAttributes)

    const hasContentAbove = (this.state.pixelsAbove || 0) > 0
    const hasContentBelow = (this.state.pixelsBelow || 0) > 0

    let formattedElementsText = ''
    if (elementsText !== '') {
      if (hasContentAbove) {
        formattedElementsText = `... ${this.state.pixelsAbove} pixels above - scroll or extract content to see more ...\n${elementsText}`
      } else {
        formattedElementsText = `[Start of page]\n${elementsText}`
      }

      if (hasContentBelow) {
        formattedElementsText = `${formattedElementsText}\n... ${this.state.pixelsBelow} pixels below - scroll or extract content to see more ...`
      } else {
        formattedElementsText = `${formattedElementsText}\n[End of page]`
      }
    } else {
      formattedElementsText = 'empty page'
    }

    let stepInfoDescription = ''
    if (this.stepInfo) {
      stepInfoDescription = `Current step: ${this.stepInfo.stepNumber + 1}/${this.stepInfo.maxSteps}`
    }

    const timeStr = new Date().toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })

    stepInfoDescription += `Current date and time: ${timeStr}`

    let stateDescription = `
[Task history memory ends]
[Current state starts here]
The following is one-time information - if you need to remember it write it to memory:
Current url: ${this.state.url}
Available tabs:
${JSON.stringify(this.state.tabs)}
Interactive elements from top layer of the current page inside the viewport:
${formattedElementsText}
${stepInfoDescription}
`

    if (this.result && this.result.length > 0) {
      for (let i = 0; i < this.result.length; i++) {
        const result = this.result[i]
        if (result.extractedContent) {
          stateDescription += `\nAction result ${i + 1}/${this.result.length}: ${result.extractedContent}`
        }
        if (result.error) {
          // only use last line of error
          const error = result.error.split('\n').pop()
          stateDescription += `\nAction error ${i + 1}/${this.result.length}: ...${error}`
        }
      }
    }

    if (this.state.screenshot && useVision) {
      // Format message for vision model
      return new HumanMessage({
        content: [
          { type: 'text', text: stateDescription },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${this.state.screenshot}` }, // detail: 'low' options removed
          },
        ],
      },
      )
    }

    return new HumanMessage(stateDescription)
  }
}

/**
 * Class that handles planner prompts
 */
export class PlannerPrompt extends SystemPrompt {
  /** Available actions for the planner */
  private availableActions: string

  /**
   * Initialize a new PlannerPrompt
   *
   * @param availableActions Description of available actions
   */
  constructor(availableActions: string) {
    super({
      actionDescription: availableActions,
    })
    this.availableActions = availableActions
  }

  /**
   * Get the system message for the planner.
   *
   * @param isPlannerReasoning If True, return as HumanMessage for chain-of-thought
   * @param extendedPlannerSystemPrompt Optional text to append to the base prompt
   * @returns SystemMessage or HumanMessage depending on isPlannerReasoning
   */
  getSystemMessage(
    isPlannerReasoning: boolean,
    extendedPlannerSystemPrompt?: string,
  ): SystemMessage | HumanMessage {
    const plannerPromptText = `
You are a planning agent that helps break down tasks into smaller steps and reason about the current state.
Your role is to:
1. Analyze the current state and history
2. Evaluate progress towards the ultimate goal
3. Identify potential challenges or roadblocks
4. Suggest the next high-level steps to take

Inside your messages, there will be AI messages from different agents with different formats.

Your output format should be always a JSON object with the following fields:
{
    "state_analysis": "Brief analysis of the current state and what has been done so far",
    "progress_evaluation": "Evaluation of progress towards the ultimate goal (as percentage and description)",
    "challenges": "List any potential challenges or roadblocks",
    "next_steps": "List 2-3 concrete next steps to take",
    "reasoning": "Explain your reasoning for the suggested next steps"
}

Ignore the other AI messages output structures.

Keep your responses concise and focused on actionable insights.
`

    let fullPrompt = plannerPromptText

    if (extendedPlannerSystemPrompt) {
      fullPrompt += `\n${extendedPlannerSystemPrompt}`
    }

    if (isPlannerReasoning) {
      return new HumanMessage(fullPrompt)
    } else {
      return new SystemMessage(fullPrompt)
    }
  }
}
