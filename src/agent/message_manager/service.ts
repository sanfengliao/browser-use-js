import { BrowserStateSummary } from '@/browser/views'
import { Logger } from '@/logger'
import { timeExecutionSync } from '@/utils'
import { ToolCall } from '@langchain/core/dist/messages/tool'
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { AgentMessagePrompt } from '../prompt'
import { ActionResult, AgentOutput, AgentStepInfo } from '../views'
import { MessageManagerState, MessageMetadata } from './view'

const logger = Logger.getLogger(import.meta.filename)

/**
 * Escape special characters in a string for use in a RegExp
 *
 * @param string The string to escape
 * @returns Escaped string safe for RegExp
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // $& means the whole matched string
}

/**
 * Settings for message manager
 */
export class MessageManagerSettings {
  /**
   * Maximum number of input tokens allowed
   * @default 128000
   */
  maxInputTokens: number

  /**
   * Estimated number of characters per token for token counting
   * @default 3
   */
  estimatedCharactersPerToken: number

  /**
   * Number of tokens to allocate for image content
   * @default 800
   */
  imageTokens: number

  /**
   * List of element attributes to include in state descriptions
   * @default []
   */
  includeAttributes: string[]

  /**
   * Additional context to include in messages
   * @default undefined
   */
  messageContext?: string

  /**
   * Dictionary of sensitive data to filter from messages
   * @default undefined
   */
  sensitiveData?: Record<string, string>

  /**
   * List of file paths available to the agent
   * @default undefined
   */
  availableFilePaths?: string[]

  /**
   * Create a new MessageManagerSettings instance
   *
   * @param settings Optional partial settings
   */
  constructor(settings: Partial<MessageManagerSettings> = {}) {
    // Set default values
    this.maxInputTokens = 128000
    this.estimatedCharactersPerToken = 3
    this.imageTokens = 800
    this.includeAttributes = []

    // Override with provided values
    Object.assign(this, settings)
  }
}

export class MessageManager {
  task: string
  systemPrompt: SystemMessage
  settings: MessageManagerSettings
  state: MessageManagerState
  constructor({
    task,
    systemMessage,
    settings,
    state = new MessageManagerState(),
  }: {
    task: string
    systemMessage: SystemMessage
    settings?: Partial<MessageManagerSettings>
    state?: MessageManagerState
  }) {
    this.task = task
    this.systemPrompt = systemMessage
    this.settings = new MessageManagerSettings(settings)
    this.state = state

    if (this.state.history.messages.length === 0) {
      this.initMessages()
    }
  }

  /**
   * Initialize the message history with system message, context, task, and other initial messages
   */
  private initMessages() {
    this.addMessageWithTokens({
      message: this.systemPrompt,
      messageType: 'init',
    })
    if (this.settings.messageContext) {
      const contextMessage = new HumanMessage({
        content: `Context for the task: ${this.settings.messageContext}`,
      })
      this.addMessageWithTokens({
        message: contextMessage,
        messageType: 'init',
      })
    }
    // Add task message
    const taskMessage = new HumanMessage(
      `Your ultimate task is: """${this.task}""". If you achieved your ultimate task, stop everything and use the done action in the next step to complete the task. If not, continue as usual.`,
    )
    this.addMessageWithTokens({ message: taskMessage, messageType: 'init' })

    // Add sensitive data info if available
    if (this.settings.sensitiveData) {
      let info = `Here are placeholders for sensitive data: ${Object.keys(this.settings.sensitiveData)}`
      info += '\nTo use them, write <secret>the placeholder name</secret>'
      const infoMessage = new HumanMessage(info)
      this.addMessageWithTokens({ message: infoMessage, messageType: 'init' })
    }

    // Add example message and output
    const placeholderMessage = new HumanMessage('Example output:')
    this.addMessageWithTokens({ message: placeholderMessage, messageType: 'init' })
    // Create example tool call with demonstration of expected output format
    const exampleToolCall = new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'AgentOutput',
          args: {
            current_state: {
              evaluation_previous_goal: `
              Success - I successfully clicked on the 'Apple' link from the Google Search results page, 
              which directed me to the 'Apple' company homepage. This is a good start toward finding 
              the best place to buy a new iPhone as the Apple website often list iPhones for sale.
            `.trim(),
              memory: `
              I searched for 'iPhone retailers' on Google. From the Google Search results page, 
              I used the 'click_element_by_index' tool to click on element at index [45] labeled 'Best Buy' but calling 
              the tool did not direct me to a new page. I then used the 'click_element_by_index' tool to click 
              on element at index [82] labeled 'Apple' which redirected me to the 'Apple' company homepage. 
              Currently at step 3/15.
            `.trim(),
              next_goal: `
              Looking at reported structure of the current page, I can see the item '[127]<h3 iPhone/>' 
              in the content. I think this button will lead to more information and potentially prices 
              for iPhones. I'll click on the link at index [127] using the 'click_element_by_index' 
              tool and hope to see prices on the next page.
            `.trim(),
            },
            action: [{ click_element_by_index: { index: 127 } }],
          },
          id: String(this.state.toolId),
          type: 'tool_call',
        },
      ],
    })
    this.addMessageWithTokens({ message: exampleToolCall, messageType: 'init' })

    // Add browser started message
    this.addToolMessage({ message: 'Browser started', messageType: 'init' })

    // Add task history memory marker
    const memoryPlaceholderMessage = new HumanMessage('[Your task history memory starts here]')
    this.addMessageWithTokens({ message: memoryPlaceholderMessage })

    // Add available file paths if provided
    if (this.settings.availableFilePaths) {
      const filepathsMsg = new HumanMessage(`Here are file paths you can use: ${this.settings.availableFilePaths}`)
      this.addMessageWithTokens({ message: filepathsMsg, messageType: 'init' })
    }
  }

  addNewTask(newTask: string) {
    const content = `Your new ultimate task is: """${newTask}""". Take the previous context into account and finish your new ultimate task. `
    const msg = new HumanMessage(content)
    this.addMessageWithTokens({
      message: msg,
    })
    this.task = newTask
  }

  /**
   * Add browser state as human message
   *
   * @param state Current browser state
   * @param result Optional results from previous actions
   * @param stepInfo Optional information about the current step
   * @param useVision Whether to include screenshots in the message
   */
  public addStateMessage(
    {
      state,
      result,
      stepInfo,
      useVision = true,
    }: {
      state: BrowserStateSummary
      result?: ActionResult[]
      stepInfo?: AgentStepInfo
      useVision: boolean
    },
  ): void {
    // If there are results that should be kept in memory,
    // add them directly to history and then add state without result
    if (result) {
      for (const r of result) {
        if (r.includeInMemory) {
          // Add extracted content if available
          if (r.extractedContent) {
            const msg = new HumanMessage(`Action result: ${String(r.extractedContent)}`)
            this.addMessageWithTokens({
              message: msg,
            })
          }

          // Add error info if available
          if (r.error) {
            // Remove trailing newline if present
            let errorText = r.error
            if (errorText.endsWith('\n')) {
              errorText = errorText.slice(0, -1)
            }

            // Get only the last line of the error
            const lastLine = errorText.split('\n').pop() || ''
            const msg = new HumanMessage(`Action error: ${lastLine}`)
            this.addMessageWithTokens({
              message: msg,
            })
          }

          // Clear result so we don't add it again
          result = undefined
        }
      }
    }

    // Create and add state message with optional result
    // (this message will not stay in memory unless specifically requested)
    const stateMessage = new AgentMessagePrompt(
      {
        state,
        result,
        includeAttributes: this.settings.includeAttributes,
        stepInfo,
      },
    ).getUserMessage(useVision)

    this.addMessageWithTokens({
      message: stateMessage,
    })
  }

  addToolMessage({ message, messageType }: {
    message: string
    messageType?: string
  }) {
    const msg = new ToolMessage({
      content: message,
      tool_call_id: String(this.state.toolId),
    })
    this.state.toolId += 1
    this.addMessageWithTokens({
      message: msg,
      messageType,
    })
  }

  /**
   * Add model output as AI message
   *
   * @param modelOutput The agent output to add to the conversation
   */
  public addModelOutput(modelOutput: AgentOutput): void {
    // Create tool call structure
    const toolCalls: ToolCall[] = [
      {
        name: 'AgentOutput',
        args: modelOutput.toJSON(),
        id: String(this.state.toolId),
        type: 'tool_call',
      },
    ]

    // Create AI message with tool calls
    const msg = new AIMessage({
      content: '',
      tool_calls: toolCalls,
    })

    // Add the message with token counting
    this.addMessageWithTokens({
      message: msg,

    })

    // Add empty tool response
    this.addToolMessage({
      message: '',
    })
  }

  /**
   * Add planner output as AI message
   *
   * @param plan The plan text to add, or null if no plan
   * @param position Optional position to insert the message in the history
   */
  public addPlan({ plan, position }: { plan?: string, position?: number } = {}): void {
    if (plan) {
      const msg = new AIMessage(plan)
      this.addMessageWithTokens({
        message: msg,
        position,
      })
    }
  }

  /**
   * Get current message list, potentially trimmed to max tokens
   *
   * @returns List of base messages ready for the LLM
   */
  public getMessages(): BaseMessage[] {
    // Extract actual message objects from managed message wrappers
    const messages = this.state.history.messages.map(m => m.message)

    // Debug which messages are in history with token count
    let totalInputTokens = 0
    logger.debug(`Messages in history: ${this.state.history.messages.length}:`)

    for (const m of this.state.history.messages) {
      totalInputTokens += m.metadata.tokens
      logger.debug(`${m.message.constructor.name} - Token count: ${m.metadata.tokens}`)
    }

    logger.debug(`Total input tokens: ${totalInputTokens}`)

    return messages
  }

  /**
   * Add message with token count metadata
   * position: None for last, -1 for second last, etc.
   */
  addMessageWithTokens({
    message,
    position,
    messageType,
  }: {
    message: BaseMessage
    position?: number
    messageType?: string
  }) {
    if (this.settings.sensitiveData) {
      message = this.filterSensitiveData(message)
    }

    const tokenCount = this.countTokens(message)
    const metadata = new MessageMetadata({
      tokens: tokenCount,
      messageType,
    })
    this.state.history.addMessage(message, metadata, position)
  }

  /**
   * Filter out sensitive data from the message
   * @param message
   */
  @timeExecutionSync('--filter_sensitive_data')
  private filterSensitiveData(message: BaseMessage): BaseMessage {
    /**
     * Replace sensitive data in a string with placeholder tags
     *
     * @param value The string to search and replace sensitive data in
     * @returns String with sensitive data replaced by placeholder tags
     */
    const replaceSensitive = (value: string): string => {
      if (!this.settings.sensitiveData) {
        return value
      }

      // Create a dictionary with all key-value pairs from sensitiveData where value is not null/undefined or empty
      const validSensitiveData: Record<string, string> = {}
      for (const [key, val] of Object.entries(this.settings.sensitiveData)) {
        if (val) {
          validSensitiveData[key] = val
        }
      }

      // If there are no valid sensitive data entries, just return the original value
      if (Object.keys(validSensitiveData).length === 0) {
        logger.warn('No valid entries found in sensitiveData dictionary')
        return value
      }

      // Replace all valid sensitive data values with their placeholder tags
      let result = value
      for (const [key, val] of Object.entries(validSensitiveData)) {
        result = result.replace(new RegExp(escapeRegExp(val), 'g'), `<secret>${key}</secret>`)
      }

      return result
    }

    // Create a deep copy of the message
    const filteredMessage = message

    // Handle string content
    if (typeof filteredMessage.content === 'string') {
      filteredMessage.content = replaceSensitive(filteredMessage.content)
    } else if (Array.isArray(filteredMessage.content)) {
      // Handle array content (multimodal messages)
      filteredMessage.content = filteredMessage.content.map((item) => {
        if (typeof item === 'object' && item !== null && 'text' in item) {
          return {
            ...item,
            text: replaceSensitive(item.text as string),
          }
        }
        return item
      })
    }

    return filteredMessage
  }

  /**
   * Count tokens in a message using the model's tokenizer
   * @param message
   * @returns Number of tokens in the message
   */
  @timeExecutionSync('--count_tokens')
  countTokens(message: BaseMessage): number {
    let count = 0
    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if ('image_url' in item) {
          count += this.settings.imageTokens
        } else if (typeof item === 'object' && item !== null && 'text' in item) {
          count += this.countTextTokens(item.text)
        }
      }
    } else {
      let msg = message.content
      if ('tool_calls' in message) {
        msg += JSON.stringify(message.tool_calls)
      }
      count += this.countTextTokens(msg)
    }
    return count
  }

  /**
   * Count tokens in a text string
   * @param text
   */
  private countTextTokens(text: string): number {
    return Math.ceil(text.length / this.settings.estimatedCharactersPerToken)
  }

  /**
   * Get current message list, potentially trimmed to max tokens
   * Returns the result of trimming (null if no trimming was needed)
   */
  public cutMessages() {
    // Calculate how many tokens we need to remove
    let diff = this.state.history.currentTokens - this.settings.maxInputTokens

    // If we're under the limit, no need to trim
    if (diff <= 0) {
      return
    }

    // Get the last message
    const msg = this.state.history.messages[this.state.history.messages.length - 1]

    // If the message has multimodal content (list with image), remove images first
    if (Array.isArray(msg.message.content)) {
      let text = ''

      // Process each content item
      for (let i = 0; i < msg.message.content.length; i++) {
        const item = msg.message.content[i]

        // Remove images to save tokens
        if ('image_url' in item) {
          msg.message.content.splice(i, 1) // Remove the image from the array
          i-- // Adjust index after removal

          // Update token counts
          const imageTokens = this.settings.imageTokens
          diff -= imageTokens
          msg.metadata.tokens -= imageTokens
          this.state.history.currentTokens -= imageTokens

          logger.debug(
            `Removed image with ${this.settings.imageTokens} tokens - total tokens now: `
            + `${this.state.history.currentTokens}/${this.settings.maxInputTokens}`,
          )
        } else if ('text' in item && typeof item === 'object') {
          text += item.text
        }
      }

      // Convert list content to string content
      msg.message.content = text
      this.state.history.messages[this.state.history.messages.length - 1] = msg
    }

    // If we're now under the limit, we're done
    if (diff <= 0) {
      return
    }

    // If still over the limit, remove text from state message proportionally to the number of tokens needed
    // Calculate the proportion of content to remove
    const proportionToRemove = diff / msg.metadata.tokens

    if (proportionToRemove > 0.99) {
      throw new Error(
        `Max token limit reached - history is too long - reduce the system prompt or task. `
        + `proportion_to_remove: ${proportionToRemove}`,
      )
    }

    logger.debug(
      `Removing ${(proportionToRemove * 100).toFixed(2)}% of the last message `
      + `(${(proportionToRemove * msg.metadata.tokens).toFixed(2)} / ${msg.metadata.tokens.toFixed(2)} tokens)`,
    )

    // Get current content and calculate characters to remove
    const content = msg.message.content as string
    const charactersToRemove = Math.floor(content.length * proportionToRemove)
    const truncatedContent = content.substring(0, content.length - charactersToRemove)

    // Remove tokens and old long message
    this.state.history.removeLastStateMessage()

    // Create new message with updated content
    const newMsg = new HumanMessage(truncatedContent)
    this.addMessageWithTokens({
      message: newMsg,
    })

    // Get the new last message for logging
    const lastMsg = this.state.history.messages[this.state.history.messages.length - 1]

    logger.debug(
      `Added message with ${lastMsg.metadata.tokens} tokens - total tokens now: `
      + `${this.state.history.currentTokens}/${this.settings.maxInputTokens} - `
      + `total messages: ${this.state.history.messages.length}`,
    )

    return null
  }

  removeLastStateMessage() {
    this.state.history.removeLastStateMessage()
  }
}
