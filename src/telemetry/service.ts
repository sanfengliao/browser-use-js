import type { BaseTelemetryEvent } from './view'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { config } from 'dotenv'
import { PostHog } from 'posthog-node'
import { v4 as uuidv4 } from 'uuid'
import { Logger } from '../logger'

config()

const logger = Logger.getLogger(import.meta.filename)

const POSTHOG_EVENT_SETTINGS = {
  process_person_profile: true,
}

function xdgCacheHome(): string {
  const homeDir = os.homedir()
  const defaultPath = path.join(homeDir, '.cache')
  const envVar = process.env.XDG_CACHE_HOME

  if (envVar && path.isAbsolute(envVar)) {
    return envVar
  }
  return defaultPath
}

export class ProductTelemetry {
  /**
   * Service for capturing anonymized telemetry data.
   *
   * If the environment variable `ANONYMIZED_TELEMETRY=False`, anonymized telemetry will be disabled.
   */
  private static readonly USER_ID_PATH = path.join(xdgCacheHome(), 'browser_use', 'telemetry_user_id')
  private static readonly PROJECT_API_KEY = 'phc_F8JMNjW1i2KbGUTaW1unnDdLSPCoyc52SGRU0JecaUh'
  private static readonly HOST = 'https://eu.i.posthog.com'
  private static readonly UNKNOWN_USER_ID = 'UNKNOWN'

  private currUserId: string | null = null
  private postHogClient: PostHog | null
  private debugLogging: boolean

  constructor() {
    const telemetryDisabled = (process.env.ANONYMIZED_TELEMETRY || 'true').toLowerCase() === 'false'
    this.debugLogging = (process.env.BROWSER_USE_LOGGING_LEVEL || 'info').toLowerCase() === 'debug'

    if (telemetryDisabled) {
      this.postHogClient = null
    } else {
      logger.info(
        'Anonymized telemetry enabled. See https://docs.browser-use.com/development/telemetry for more information.',
      )
      this.postHogClient = new PostHog(ProductTelemetry.PROJECT_API_KEY, {

        host: ProductTelemetry.HOST,
        disableGeoip: false,
        enableExceptionAutocapture: true,
      })

      // Silence posthog's logging
      // In TypeScript, you'd typically configure this differently
      if (!this.debugLogging) {
        // 在TypeScript中没有直接等同于Python的禁用logger的方式
        // 这里可能需要使用其他方式来实现
      }
    }

    if (this.postHogClient === null) {
      logger.debug('Telemetry disabled')
    }
  }

  capture(event: BaseTelemetryEvent): void {
    if (this.postHogClient === null) {
      return
    }

    if (this.debugLogging) {
      logger.debug(`Telemetry event: ${event.name} ${JSON.stringify(event.properties)}`)
    }
    this.directCapture(event)
  }

  flush() {
    if (!this.postHogClient) {
      logger.debug('PostHog client not available, skipping flush.')
      return
    }

    try {
      this.postHogClient.flush()
      logger.debug('PostHog client telemetry queue flushed.')
    } catch (e) {
      logger.error(`Failed to flush telemetry events: ${e}`)
    }
  }

  private directCapture(event: BaseTelemetryEvent): void {
    /**
     * Should not be thread blocking because posthog magically handles it
     */
    if (this.postHogClient === null) {
      return
    }

    try {
      this.postHogClient.capture({
        distinctId: this.userId,
        event: event.name,
        properties: { ...event.properties, ...POSTHOG_EVENT_SETTINGS },
      })
    } catch (e) {
      logger.error(`Failed to send telemetry event ${event.name}: ${e}`)
    }
  }

  get userId(): string {
    if (this.currUserId) {
      return this.currUserId
    }

    // File access may fail due to permissions or other reasons. We don't want to
    // crash so we catch all exceptions.
    try {
      if (!fs.existsSync(ProductTelemetry.USER_ID_PATH)) {
        fs.mkdirSync(path.dirname(ProductTelemetry.USER_ID_PATH), { recursive: true })
        const newUserId = uuidv4()
        fs.writeFileSync(ProductTelemetry.USER_ID_PATH, newUserId)
        this.currUserId = newUserId
      } else {
        this.currUserId = fs.readFileSync(ProductTelemetry.USER_ID_PATH, 'utf8')
      }
    } catch (e) {
      this.currUserId = 'UNKNOWN_USER_ID'
    }
    return this.currUserId!
  }
}
