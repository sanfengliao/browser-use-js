import { Logger } from '@/logger'
import { timeExecutionSync } from '@/utils'

import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { _convertMessagesToOpenAIParams } from '@langchain/openai'
import { MessageManager } from '../message_manager/service'
import { ManagedMessage, MessageMetadata } from '../message_manager/view'
import { MemoryConfig } from './views'

const logger = Logger.getLogger(import.meta.filename)

/**
 * Manages procedural memory for agents.
 *
 * This class implements a procedural memory management system using Mem0 that transforms agent interaction history
 * into concise, structured representations at specified intervals. It serves to optimize context window
 * utilization during extended task execution by converting verbose historical information into compact,
 * yet comprehensive memory constructs that preserve essential operational knowledge.
 */
export class Memory {
  /** Message manager containing conversation history */
  private messageManager: MessageManager

  /** LLM for memory operations */
  private llm: BaseChatModel

  /** Memory configuration */
  private config: MemoryConfig

  /** Mem0 memory instance */
  private mem0: any // Type for Mem0Memory

  /**
   * Initialize a new Memory manager
   *
   * @param params Configuration parameters
   * @param params.messageManager Message manager containing conversation history
   * @param params.llm LLM for memory operations
   * @param params.config Optional memory configuration
   */
  constructor(params: {
    messageManager: MessageManager
    llm: BaseChatModel
    config?: MemoryConfig
  }) {
    const { messageManager, llm, config } = params

    this.messageManager = messageManager
    this.llm = llm

    // Initialize configuration with defaults based on the LLM if not provided
    if (!config) {
      this.config = new MemoryConfig({
        llmInstance: llm,
        agentId: `agent_${Math.random().toString(36).substring(2, 11)}`,
      })

      // Set appropriate embedder based on LLM type
      const llmClass = llm.constructor.name
      // if (llmClass === 'ChatOpenAI') {
      this.config.embedderProvider = 'openai'
      this.config.embedderModel = 'text-embedding-3-small'
      this.config.embedderDims = 1536
      // } else if (llmClass === 'ChatGoogleGenerativeAI') {
      //   this.config.embedderProvider = 'gemini';
      //   this.config.embedderModel = 'models/text-embedding-004';
      //   this.config.embedderDims = 768;
      // } else if (llmClass === 'ChatOllama') {
      //   this.config.embedderProvider = 'ollama';
      //   this.config.embedderModel = 'nomic-embed-text';
      //   this.config.embedderDims = 512;
      // }
    }
    else {
      // Ensure LLM instance is set in the config
      this.config = new MemoryConfig(config) // re-validate user-provided config
      this.config.llmInstance = llm
    }

    // Check for required packages
    try {
      // Also disable mem0's telemetry when ANONYMIZED_TELEMETRY=False
      if (process.env.ANONYMIZED_TELEMETRY?.toLowerCase()[0] === 'f'
        || process.env.ANONYMIZED_TELEMETRY?.toLowerCase()[0] === 'n'
        || process.env.ANONYMIZED_TELEMETRY === '0') {
        process.env.MEM0_TELEMETRY = 'False'
      }

      // In TypeScript we'd dynamically import the package
      // This is just a placeholder for the actual implementation
      const Mem0Memory = this.importMem0()

      // Check for sentence-transformers if using huggingface
      if (this.config.embedderProvider === 'huggingface') {
        this.checkSentenceTransformers()
      }

      // Initialize Mem0 with the configuration
      this.mem0 = Mem0Memory.fromConfig(this.config.fullConfigDict)
    }
    catch (e) {
      if (e instanceof Error && e.message.includes('module not found')) {
        throw new Error('mem0 is required when enableMemory=true. Please install it with `npm install mem0`.')
      }
      throw e
    }
  }

  /**
   * Create a procedural memory if needed based on the current step.
   *
   * @param currentStep The current step number of the agent
   */
  @timeExecutionSync('--create_procedural_memory')
  public createProceduralMemory(currentStep: number): void {
    logger.info(`Creating procedural memory at step ${currentStep}`)

    // Get all messages
    const allMessages = this.messageManager.state.history.messages

    // Separate messages into those to keep as-is and those to process for memory
    const newMessages: ManagedMessage[] = []
    const messagesToProcess: ManagedMessage[] = []

    for (const msg of allMessages) {
      if (msg.metadata.messageType === 'init' || msg.metadata.messageType === 'memory') {
        // Keep system and memory messages as they are
        newMessages.push(msg)
      }
      else {
        if (msg.message.content.length > 0) {
          messagesToProcess.push(msg)
        }
      }
    }

    // Need at least 2 messages to create a meaningful summary
    if (messagesToProcess.length <= 1) {
      logger.info('Not enough non-memory messages to summarize')
      return
    }

    // Create a procedural memory
    const memoryContent = this.create(
      messagesToProcess.map(m => m.message),
      currentStep,
    )

    if (!memoryContent) {
      logger.warn('Failed to create procedural memory')
      return
    }

    // Replace the processed messages with the consolidated memory
    const memoryMessage = new HumanMessage(memoryContent)
    const memoryTokens = this.messageManager.countTokens(memoryMessage)
    const memoryMetadata: MessageMetadata = { tokens: memoryTokens, messageType: 'memory' }

    // Calculate the total tokens being removed
    const removedTokens = messagesToProcess.reduce((sum, m) => sum + m.metadata.tokens, 0)

    // Add the memory message
    newMessages.push(new ManagedMessage({
      message: memoryMessage,
      metadata: memoryMetadata,
    }))

    // Update the history
    this.messageManager.state.history.messages = newMessages
    this.messageManager.state.history.currentTokens -= removedTokens
    this.messageManager.state.history.currentTokens += memoryTokens
    logger.info(`Messages consolidated: ${messagesToProcess.length} messages converted to procedural memory`)
  }

  /**
   * Create procedural memory from a list of messages
   *
   * @param messages List of messages to process
   * @param currentStep Current step number
   * @returns Memory content string or null if creation failed
   */
  private create(messages: BaseMessage[], currentStep: number): string | null {
    const parsedMessages = this.convertToOpenAIMessages(messages)
    try {
      const results = this.mem0.add({
        messages: parsedMessages,
        agent_id: this.config.agentId,
        memory_type: 'procedural_memory',
        metadata: { step: currentStep },
      })

      if (results?.results?.length) {
        return results.results[0].memory
      }
      return null
    }
    catch (e) {
      logger.error(`Error creating procedural memory: ${e}`)
      return null
    }
  }

  /**
   * Import Mem0 memory package
   * This is a placeholder for dynamic import
   */
  private importMem0(): any {
    try {
      // In a real implementation, we'd use dynamic import
      // return require('mem0').Memory;
      throw new Error('mem0 module not found')
    }
    catch (e) {
      throw new Error('mem0 module not found')
    }
  }

  /**
   * Check if sentence-transformers package is installed
   */
  private checkSentenceTransformers(): void {
    try {
      // In a real implementation, we'd check if the package exists
      // require('sentence-transformers');
    }
    catch (e) {
      throw new Error(
        'sentence-transformers is required when enableMemory=true and embedderProvider="huggingface". '
        + 'Please install it with `npm install sentence-transformers`.',
      )
    }
  }

  /**
   * Convert BaseMessage objects to OpenAI compatible format
   * Placeholder for the langchain function
   */
  private convertToOpenAIMessages(messages: BaseMessage[]) {
    // In a real implementation, we'd use langchain's utility
    return _convertMessagesToOpenAIParams(messages)
  }

  /**
   * Get message role based on message type
   */
  private getMessageRole(message: BaseMessage): string {
    const type = message.constructor.name
    if (message instanceof HumanMessage)
      return 'user'
    if (message instanceof AIMessage)
      return 'assistant'
    if (message instanceof SystemMessage)
      return 'system'
    if (message instanceof ToolMessage)
      return 'tool'
    return 'user'
  }

  /**
   * Get message content as string
   */
  private getMessageContent(message: BaseMessage) {
    if (typeof message.content === 'string') {
      return message.content
    }

    if (Array.isArray(message.content)) {
      return message.content
        .map((item) => {
          if (typeof item === 'string') {
            return item
          }
          return {
            ...item,
          }
        })
    }
  }
}
