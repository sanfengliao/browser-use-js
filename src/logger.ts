import * as path from 'node:path'
import * as dotenv from 'dotenv'
import * as winston from 'winston'

// Load environment variables
dotenv.config()

// Define custom log levels
const customLevels = {
  levels: {
    debug: 10,
    info: 20,
    result: 35,
    warn: 40,
    error: 50,
    fatal: 60,
  },
  colors: {
    debug: 'blue',
    info: 'green',
    result: 'cyan',
    warn: 'yellow',
    error: 'red',
    fatal: 'magenta',
  },
}

// Singleton to ensure initialization only once
let initialized = false

/**
 * Setup logging system
 */
export function setupLogging(): void {
  if (initialized) {
    return
  }

  // Try to get log level
  const logType = (process.env.BROWSER_USE_LOGGING_LEVEL || 'info').toLowerCase()

  // Create custom format
  const browserUseFormat = winston.format((info) => {
    if (typeof info.message === 'string' && info.message.startsWith('browser_use.')) {
      const parts = info.message.split('.')
      info.moduleName = parts.slice(0, -1).join('.')
      info.message = parts[parts.length - 1]
    }
    else {
      info.moduleName = info.moduleName || 'root'
    }
    return info
  })

  // Set formatters
  const formatters = {
    result: winston.format.printf(({ message }) => `${message}`),
    default: winston.format.printf(({ level, moduleName, message }) => {
      return `${level.padEnd(8)} [${moduleName}] ${message}`
    }),
  }

  // Console output
  const consoleTransport = new winston.transports.Console({
    level: logType,
    format: winston.format.combine(
      browserUseFormat(),
      logType === 'result' ? formatters.result : formatters.default,
    ),
  })

  // Create root logger
  const rootLogger = winston.createLogger({
    levels: customLevels.levels,
    transports: [consoleTransport],
  })

  // Add colors
  winston.addColors(customLevels.colors)

  // Set log level
  switch (logType) {
    case 'result':
      rootLogger.level = 'result'
      break
    case 'debug':
      rootLogger.level = 'debug'
      break
    default:
      rootLogger.level = 'info'
  }

  // Save to global
  setGlobalLogger(rootLogger)

  // Silence third-party library logs
  const silenceThirdPartyLoggers = [
    'WDM',
    'httpx',
    'selenium',
    'playwright',
    'urllib3',
    'asyncio',
    'langchain',
    'openai',
    'httpcore',
    'charset_normalizer',
    'anthropic._base_client',
    'PIL.PngImagePlugin',
    'trafilatura.htmlprocessing',
    'trafilatura',
  ]

  silenceThirdPartyLoggers.forEach((name) => {
    // In Winston, we "silence" by creating loggers with specific levels
    // But since Node.js logging system is different from Python, we just simulate this behavior
    Logger.silent(name)
  })

  initialized = true
}

// Save root logger
let globalLogger: winston.Logger

function setGlobalLogger(logger: winston.Logger): void {
  globalLogger = logger
}

function getGlobalLogger(): winston.Logger {
  if (!globalLogger) {
    setupLogging() // Ensure initialization
  }
  return globalLogger
}

// Custom Logger class, wrapping Winston
export class Logger {
  private logger: winston.Logger
  private moduleName: string
  private static instances: Map<string, Logger> = new Map()

  constructor(moduleName: string) {
    this.moduleName = moduleName
    this.logger = getGlobalLogger()
  }

  getEffectiveLevel() {
    // @ts-expect-error
    return customLevels.levels[this.logger.level as any]
  }

  /**
   * Get logger for specified module
   * @param moduleName Module name
   * @returns Logger instance
   */
  static getLogger(moduleName: string): Logger {
    if (!Logger.instances.has(moduleName)) {
      Logger.instances.set(moduleName, new Logger(moduleName))
    }
    return Logger.instances.get(moduleName)!
  }

  /**
   * Create silent logger
   * @param moduleName Module name
   */
  static silent(moduleName: string): void {
    const logger = new Logger(moduleName)
    logger.logger.level = 'error' // Only show error level logs
    Logger.instances.set(moduleName, logger)
  }

  /**
   * Debug level log
   * @param message Log message
   * @param args Additional parameters
   */
  debug(message: string, ...args: any[]): void {
    this.log('debug', message, ...args)
  }

  /**
   * Info level log
   * @param message Log message
   * @param args Additional parameters
   */
  info(message: string, ...args: any[]): void {
    this.log('info', message, ...args)
  }

  /**
   * Result level log
   * @param message Log message
   * @param args Additional parameters
   */
  result(message: string, ...args: any[]): void {
    this.log('result', message, ...args)
  }

  /**
   * Warning level log
   * @param message Log message
   * @param args Additional parameters
   */
  warn(message: string, ...args: any[]): void {
    this.log('warn', message, ...args)
  }

  /**
   * Error level log
   * @param message Log message
   * @param args Additional parameters
   */
  error(message: string, ...args: any[]): void {
    this.log('error', message, ...args)
  }

  /**
   * Fatal error level log
   * @param message Log message
   * @param args Additional parameters
   */
  fatal(message: string, ...args: any[]): void {
    this.log('fatal', message, ...args)
  }

  /**
   * General log method
   */
  private log(level: string, message: string, ...args: any[]): void {
    // Replace placeholder parameters, similar to Python's string formatting
    let formattedMessage = message
    if (args.length > 0) {
      formattedMessage = this.formatMessage(message, args)
    }

    this.logger.log(level, formattedMessage, { moduleName: this.moduleName })
  }

  /**
   * Simulate Python's string formatting
   */
  private formatMessage(message: string, args: any[]): string {
    // Implement simple %s, %d placeholder replacement
    let index = 0
    return message.replace(/%([sd])/g, (match, type) => {
      if (index >= args.length)
        return match
      const value = args[index++]
      switch (type) {
        case 's': return String(value)
        case 'd': return Number(value).toString()
        default: return match
      }
    })
  }
}

// Export default initialization method
export default setupLogging
