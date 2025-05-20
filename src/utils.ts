import EventEmitter from 'node:events'
import readline from 'node:readline'
import { Logger } from './logger' // 假设你有一个日志模块
import { AnyFunction } from './type'

const logger = Logger.getLogger(import.meta.filename)

// Global flag to prevent duplicate exit messages
let exiting = false

/**
 * A modular and reusable signal handling system for managing SIGINT (Ctrl+C), SIGTERM,
 * and other signals in asyncio applications.
 *
 * This class provides:
 * - Configurable signal handling for SIGINT and SIGTERM
 * - Support for custom pause/resume callbacks
 * - Management of event loop state across signals
 * - Standardized handling of first and second Ctrl+C presses
 * - Cross-platform compatibility (with simplified behavior on Windows)
 */
export class SignalHandler {
  /** Event emitter that serves as the loop in TypeScript/Node.js */
  private loop: EventEmitter

  /** Function to call when system is paused (first Ctrl+C) */
  private pauseCallback?: () => void

  /** Function to call when system is resumed */
  private resumeCallback?: () => Promise<void> | void

  /** Function to call on exit (second Ctrl+C or SIGTERM) */
  private customExitCallback?: () => void

  /** Whether to exit on second SIGINT (Ctrl+C) */
  private exitOnSecondInt: boolean

  /** List of patterns to match task names that should be canceled on first Ctrl+C */
  private interruptibleTaskPatterns: string[]

  /** Flag indicating if running on Windows */
  private isWindows: boolean

  /** Original SIGINT handler */
  private originalSigintHandler?: NodeJS.SignalsListener | null

  /** Original SIGTERM handler */
  private originalSigtermHandler?: NodeJS.SignalsListener | null

  private ctrlCPressed = false
  private waitingForInput = false

  /**
   * Initialize the signal handler.
   *
   * @param options Configuration options
   * @param options.loop The event emitter to use. Defaults to new EventEmitter
   * @param options.pauseCallback Function to call when system is paused (first Ctrl+C)
   * @param options.resumeCallback Function to call when system is resumed
   * @param options.customExitCallback Function to call on exit (second Ctrl+C or SIGTERM)
   * @param options.exitOnSecondInt Whether to exit on second SIGINT (Ctrl+C)
   * @param options.interruptibleTaskPatterns List of patterns to match task names that should be
   *                            canceled on first Ctrl+C
   */
  constructor(options: {
    loop?: EventEmitter
    pauseCallback?: () => void
    resumeCallback?: () => (Promise<void> | void)
    customExitCallback?: () => void
    exitOnSecondInt?: boolean
    interruptibleTaskPatterns?: string[]
  } = {}) {
    const {
      loop = new EventEmitter(),
      pauseCallback,
      resumeCallback,
      customExitCallback,
      exitOnSecondInt = true,
      interruptibleTaskPatterns = ['step', 'multi_act', 'get_next_action'],
    } = options

    this.loop = loop
    this.pauseCallback = pauseCallback
    this.resumeCallback = resumeCallback
    this.customExitCallback = customExitCallback
    this.exitOnSecondInt = exitOnSecondInt
    this.interruptibleTaskPatterns = interruptibleTaskPatterns
    this.isWindows = process.platform === 'win32'
  }

  /**
   * Register signal handlers for SIGINT and SIGTERM.
   */
  public register(): void {
    try {
      if (this.isWindows) {
        // On Windows, use simple signal handling with immediate exit on Ctrl+C
        const windowsHandler = (_sig: NodeJS.Signals) => {
          logger.error('\n\n🛑 Got Ctrl+C. Exiting immediately on Windows...\n')

          // Run the custom exit callback if provided
          if (this.customExitCallback) {
            this.customExitCallback()
          }
          process.exit(0)
        }

        this.originalSigintHandler = windowsHandler
        // Store original handler and set new one
        process.on('SIGINT', windowsHandler)
      } else {
        // On Unix-like systems, use Node's signal handling
        this.originalSigintHandler = () => {
          this.sigintHandler()
        }

        this.originalSigtermHandler = () => {
          this.sigtermHandler()
        }

        process.on('SIGINT', () => this.sigintHandler())
        process.on('SIGTERM', () => this.sigtermHandler())
      }
    } catch (error) {
      // there are situations where signal handlers are not supported, e.g.
      // - when running in a thread other than the main thread
      // - some operating systems
      // - inside jupyter notebooks
      logger.warn('Failed to register signal handlers:', error)
    }
  }

  /**
   * Unregister signal handlers and restore original handlers if possible.
   */
  public unregister(): void {
    try {
      // Remove our signal handlers
      process.removeAllListeners('SIGINT')
      process.removeAllListeners('SIGTERM')

      // Restore original handlers if available
      if (this.originalSigintHandler) {
        process.on('SIGINT', this.originalSigintHandler)
      }
      if (this.originalSigtermHandler) {
        process.on('SIGTERM', this.originalSigtermHandler)
      }
    } catch (error) {
      logger.warn(`Error while unregistering signal handlers: ${error}`)
    }
  }

  /**
   * Handle a second Ctrl+C press by performing cleanup and exiting.
   * This is shared logic used by both sigintHandler and waitForResume.
   */
  private handleSecondCtrlC(): void {
    if (!exiting) {
      exiting = true

      // Call custom exit callback if provided
      if (this.customExitCallback) {
        try {
          this.customExitCallback()
        } catch (error) {
          logger.error(`Error in exit callback: ${error}`)
        }
      }
    }

    // Force immediate exit - more reliable than sys.exit()
    logger.info('\n\n🛑  Got second Ctrl+C. Exiting immediately...\n')

    process.exit(0)
  }

  /**
   * SIGINT (Ctrl+C) handler.
   *
   * First Ctrl+C: Cancel current step and pause.
   * Second Ctrl+C: Exit immediately if exitOnSecondInt is True.
   */
  public sigintHandler(): void {
    logger.info('SIGINT received')
    if (exiting) {
      // Already exiting, force exit immediately
      process.exit(0)
    }

    if (this.ctrlCPressed) {
      // If we're in the waiting for input state, let the pause method handle it
      if (this.waitingForInput) {
        return
      }

      // Second Ctrl+C - exit immediately if configured to do so
      if (this.exitOnSecondInt) {
        this.handleSecondCtrlC()
      }
    }

    // Mark that Ctrl+C was pressed
    this.ctrlCPressed = true

    // Cancel current tasks that should be interruptible - this is crucial for immediate pausing
    this.cancelInterruptibleTasks()

    // Call pause callback if provided - this sets the paused flag
    if (this.pauseCallback) {
      try {
        this.pauseCallback()
      } catch (error) {
        logger.error(`Error in pause callback: ${error}`)
      }
    }

    // Log pause message after pauseCallback is called (not before)
    logger.error('----------------------------------------------------------------------')
  }

  /**
   * SIGTERM handler.
   *
   * Always exits the program completely.
   */
  public sigtermHandler(): void {
    if (!exiting) {
      exiting = true
      logger.error('\n\n🛑 SIGTERM received. Exiting immediately...\n\n')

      // Call custom exit callback if provided
      if (this.customExitCallback) {
        this.customExitCallback()
      }
    }

    process.exit(0)
  }

  /**
   * Cancel current tasks that should be interruptible.
   * In Node.js, we'll emit an event to notify running tasks they should cancel.
   */
  private cancelInterruptibleTasks(): void {
    // In Node.js, we don't have direct access to tasks like in Python's asyncio
    // Instead, we'll emit a cancellation event that tasks can listen for
    this.loop.emit('cancellation_requested', this.interruptibleTaskPatterns)

    logger.debug('Cancellation event emitted for interruptible tasks')

    // Note: In a real implementation, tasks would need to listen for this event
    // and handle their own cancellation, as Node.js doesn't have built-in
    // task cancellation like Python's asyncio
  }

  /**
   * Wait for user input to resume or exit.
   *
   * This method should be called after handling the first Ctrl+C.
   * It temporarily restores default signal handling to allow catching
   * a second Ctrl+C directly.
   */
  public waitForResume() {
    // Set flag to indicate we're waiting for input
    this.waitingForInput = true

    // Store original handlers
    const originalHandlers = process.listeners('SIGINT').slice()

    // Clear and set temporary handler
    process.removeAllListeners('SIGINT')

    process.on('SIGINT', () => {
      // Use the shared method to handle second Ctrl+C
      this.handleSecondCtrlC()
    })

    const green = '\x1B[32;1m'
    const red = '\x1B[31m'

    const reset = '\x1B[0m'

    // Display prompt
    console.log(
      `➡️  Press ${green}[Enter]${reset} to resume or ${red}[Ctrl+C]${reset} again to exit...`,
    )

    // Read input (we'll use a simpler approach in Node.js)

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    return new Promise((resolve) => {
      rl.question('', async (input) => {
        console.log('answer----->', input)
        rl.close()

        // Call resume callback if provided
        if (this.resumeCallback) {
          try {
            await this.resumeCallback()
          } catch (error) {
            logger.error(`Error in resume callback: ${error}`)
          }
        }

        // Restore original handlers
        process.removeAllListeners('SIGINT')
        originalHandlers.forEach((handler) => {
          process.on('SIGINT', handler)
        })

        this.waitingForInput = false
        resolve(undefined)
      })
    })
  }

  /**
   * Reset state after resuming.
   */
  public reset(): void {
    // Clear the flags
    this.ctrlCPressed = false
    this.waitingForInput = false
  }
}

type MethodDecorator<T extends AnyFunction> = (target: T, context: ClassMethodDecoratorContext) => T

export function timeExecutionSync<T extends AnyFunction>(additionalText: string = ''): MethodDecorator<T> {
  return function (
    originalMethod: T,
    context: ClassMethodDecoratorContext,
  ): T {
    if (context.kind !== 'method') {
      throw new Error('timeExecutionSync only works on methods')
    }

    function replacementMethod(this: any, ...args: any[]) {
      const startTime = Date.now()
      const result = originalMethod.apply(this, args)
      const executionTime = (Date.now() - startTime)

      logger.debug(`${additionalText} Execution time: ${executionTime.toFixed(2)} ms`)

      return result
    }

    return replacementMethod as T
  }
}

export function timeExecutionAsync(additionalText: string = '') {
  return function (
    originalMethod: AnyFunction,
    context: ClassMethodDecoratorContext,
  ) {
    if (context.kind !== 'method') {
      throw new Error('timeExecutionAsync only works on methods')
    }

    return async function (this: any, ...args: any[]) {
      const startTime = performance.now()

      const result = await originalMethod.apply(this, args)

      const executionTime = (performance.now() - startTime) / 1000
      logger.debug(`${additionalText} Execution time: ${executionTime.toFixed(2)} seconds`)

      return result
    }
  }
}

export function checkEnvVariables(
  keys: string[],
  anyOrAll: 'any' | 'all' = 'all',
): boolean {
  if (anyOrAll === 'any') {
    return keys.some(key => (process.env[key] || '').trim() !== '')
  } else {
    return keys.every(key => (process.env[key] || '').trim() !== '')
  }
}

/**
 * Checks if setA is a subset of setB
 * Similar to Python's set.issubset() method
 *
 * @param setA The set that might be a subset
 * @param setB The set that might contain setA
 * @returns True if every element in setA exists in setB
 */
export function isSubset<T>(setA: Set<T>, setB: Set<T>): boolean {
  // A set A is a subset of a set B if all elements of A are also elements of B
  for (const elem of setA) {
    if (!setB.has(elem)) {
      return false
    }
  }
  return true
}

export const sleep = (second: number) => new Promise(resolve => setTimeout(resolve, second * 1000))
