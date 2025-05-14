import type { BaseMessage } from '@langchain/core/dist/messages'
import type { ToolCall } from '@langchain/core/dist/messages/tool'
import type { AgentOutput } from '../views'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/dist/messages'

export class MessageMetadata {
  tokens: number
  messageType?: string

  constructor(data: Partial<MessageMetadata> = {}) {
    this.tokens = data.tokens || 0
    this.messageType = data.messageType
  }
}

export class ManagedMessage {
  message: BaseMessage
  metadata: MessageMetadata
  constructor(data: {
    message: BaseMessage
    metadata?: MessageMetadata
  }) {
    this.message = data.message
    this.metadata = data.metadata || new MessageMetadata()
  }
}

/**
 * History of messages with metadata
 */
export class MessageHistory {
  /** List of messages with metadata */
  messages: ManagedMessage[] = []
  /** Current token count */
  currentTokens: number = 0

  /**
   * Add message with metadata to history
   * @param message The message to add
   * @param metadata Metadata about the message
   * @param position Optional position to insert the message
   */
  addMessage(message: BaseMessage, metadata: MessageMetadata, position?: number): void {
    const managedMessage = new ManagedMessage({ message, metadata })

    if (position === undefined) {
      this.messages.push(managedMessage)
    }
    else {
      this.messages.splice(position, 0, managedMessage)
    }

    this.currentTokens += metadata.tokens
  }

  /**
   * Add model output as AI message
   * @param output The agent output to add
   */
  addModelOutput(output: AgentOutput): void {
    const toolCalls: ToolCall[] = [
      {
        name: 'AgentOutput',
        args: this.convertToJSON(output),
        id: '1',
        type: 'tool_call',
      },
    ]

    const msg = new AIMessage({
      content: '',
      tool_calls: toolCalls,
    })

    this.addMessage(msg, { tokens: 100, messageType: 'ai_tool_call' }) // Estimate tokens for tool calls

    // Empty tool response
    const toolMessage = new ToolMessage({
      content: '',
      tool_call_id: '1',
    })

    this.addMessage(toolMessage, { tokens: 10, messageType: 'tool_response' }) // Estimate tokens for empty response
  }

  /**
   * Get all messages
   * @returns List of base messages
   */
  getMessages(): BaseMessage[] {
    return this.messages.map(m => m.message)
  }

  /**
   * Get total tokens in history
   * @returns Total token count
   */
  getTotalTokens(): number {
    return this.currentTokens
  }

  /**
   * Remove oldest non-system message
   */
  removeOldestMessage(): void {
    for (let i = 0; i < this.messages.length; i++) {
      if (!(this.messages[i].message instanceof SystemMessage)) {
        this.currentTokens -= this.messages[i].metadata.tokens
        this.messages.splice(i, 1)
        break
      }
    }
  }

  /**
   * Remove last state message from history
   */
  removeLastStateMessage(): void {
    if (this.messages.length > 2 && this.messages[this.messages.length - 1].message instanceof HumanMessage) {
      this.currentTokens -= this.messages[this.messages.length - 1].metadata.tokens
      this.messages.pop()
    }
  }

  /**
   * Convert object to JSON, excluding undefined values
   */
  private convertToJSON(obj: any): Record<string, any> {
    return JSON.parse(JSON.stringify(obj, (key, value) =>
      value === undefined ? undefined : value))
  }
}

/**
 * Holds the state for MessageManager
 */
export class MessageManagerState {
  /** Message history */
  history: MessageHistory = new MessageHistory()
  /** Tool ID counter */
  toolId: number = 1
}
