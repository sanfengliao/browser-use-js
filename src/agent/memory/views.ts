import { BaseChatModel } from '@langchain/core/language_models/chat_models'

/**
 * Provider types for embeddings
 */
export type EmbedderProvider = 'openai' | 'gemini' | 'ollama' | 'huggingface'

/**
 * Provider types for LLM
 */
export type LlmProvider = 'langchain'

/**
 * Provider types for vector stores
 */
export type VectorStoreProvider = 'faiss'

/**
 * Configuration for procedural memory.
 */
export class MemoryConfig {
  /**
   * Unique identifier for the agent using this memory
   * @default 'browser_use_agent'
   * @minimum 1 character
   */
  agentId: string

  /**
   * Interval for memory operations
   * @default 10
   * @minimum 2
   * @maximum 99
   */
  memoryInterval: number

  /**
   * Provider for embedding generation
   * @default 'huggingface'
   */
  embedderProvider: EmbedderProvider

  /**
   * Model name for embeddings
   * @default 'all-MiniLM-L6-v2'
   * @minimum 2 characters
   */
  embedderModel: string

  /**
   * Dimensions for the embedding vectors
   * @default 384
   * @minimum 11
   * @maximum 9999
   */
  embedderDims: number

  /**
   * Provider for the language model
   * @default 'langchain'
   */
  llmProvider: LlmProvider

  /**
   * Language model instance
   */
  llmInstance?: BaseChatModel

  /**
   * Provider for the vector store
   * @default 'faiss'
   */
  vectorStoreProvider: VectorStoreProvider

  /**
   * Base path for vector store files
   * @default '/tmp/mem0'
   */
  vectorStoreBasePath: string

  /**
   * Create a new MemoryConfig instance
   *
   * @param config Optional partial configuration
   */
  constructor(config: Partial<MemoryConfig> = {}) {
    // Set default values
    this.agentId = 'browser_use_agent'
    this.memoryInterval = 10
    this.embedderProvider = 'huggingface'
    this.embedderModel = 'all-MiniLM-L6-v2'
    this.embedderDims = 384
    this.llmProvider = 'langchain'
    this.llmInstance = undefined
    this.vectorStoreProvider = 'faiss'
    this.vectorStoreBasePath = '/tmp/mem0'

    // Override with provided values
    Object.assign(this, config)

    // Validate required constraints
    this.validate()
  }

  /**
   * Validate the configuration values
   */
  private validate(): void {
    if (!this.agentId || this.agentId.length < 1) {
      throw new Error('agentId must be at least 1 character')
    }

    if (this.memoryInterval <= 1 || this.memoryInterval >= 100) {
      throw new Error('memoryInterval must be between 2 and 99')
    }

    if (!this.embedderModel || this.embedderModel.length < 2) {
      throw new Error('embedderModel must be at least 2 characters')
    }

    if (this.embedderDims <= 10 || this.embedderDims >= 10000) {
      throw new Error('embedderDims must be between 11 and 9999')
    }
  }

  /**
   * Returns the full vector store path for the current configuration. e.g. /tmp/mem0_384_faiss
   */
  get vectorStorePath(): string {
    return `${this.vectorStoreBasePath}_${this.embedderDims}_${this.vectorStoreProvider}`
  }

  /**
   * Returns the embedder configuration dictionary.
   */
  get embedderConfigDict() {
    return {
      provider: this.embedderProvider,
      config: { model: this.embedderModel, embedding_dims: this.embedderDims },
    }
  }

  /**
   * Returns the LLM configuration dictionary.
   */
  get llmConfigDict() {
    return {
      provider: this.llmProvider,
      config: { model: this.llmInstance },
    }
  }

  /**
   * Returns the vector store configuration dictionary.
   */
  get vectorStoreConfigDict() {
    return {
      provider: this.vectorStoreProvider,
      config: {
        embedding_model_dims: this.embedderDims,
        path: this.vectorStorePath,
      },
    }
  }

  /**
   * Returns the complete configuration dictionary for Mem0.
   */
  get fullConfigDict() {
    return {
      embedder: this.embedderConfigDict,
      llm: this.llmConfigDict,
      vector_store: this.vectorStoreConfigDict,
    }
  }
}

/**
 * Create a memory configuration with default values
 * @param config Optional partial configuration
 * @returns Configured MemoryConfig instance
 */
export function createMemoryConfig(config: Partial<MemoryConfig> = {}): MemoryConfig {
  return new MemoryConfig(config)
}
