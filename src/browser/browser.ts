import type { Browser as PlaywrightBrowser } from 'playwright'
import { spawn } from 'node:child_process'
import http from 'node:http'
import * as net from 'node:net'
import { Logger } from '@/logger'
import { timeExecutionAsync } from '@/utils'
import axios from 'axios'
import { chromium, firefox, webkit } from 'playwright'
import treeKill from 'tree-kill'
import { CHROME_ARGS, CHROME_DEBUG_PORT, CHROME_DETERMINISTIC_RENDERING_ARGS, CHROME_DISABLE_SECURITY_ARGS, CHROME_DOCKER_ARGS, CHROME_HEADLESS_ARGS } from './chrome'
import { BrowserContext, BrowserContextConfig } from './context'
import { getScreenResolution, getWindowAdjustments } from './utils/screen_resolution'

const logger = Logger.getLogger('browser.browser')

const IN_DOCKER = true

/**
 * ProxySettings - the same as playwright's ProxySettings, but as a TypeScript class
 * for better validation and compatibility
 */
export interface ProxySettings {
  server: string
  bypass?: string
  username?: string
  password?: string

}

const playwright = {
  chromium,
  firefox,
  webkit,
}

/**
 * Configuration for the Browser.
 *
 * Default values:
 *   headless: false
 *     Whether to run browser in headless mode (not recommended)
 *
 *   disable_security: false
 *     Disable browser security features (required for cross-origin iframe support)
 *
 *   extra_browser_args: []
 *     Extra arguments to pass to the browser
 *
 *   wss_url: null
 *     Connect to a browser instance via WebSocket
 *
 *   cdp_url: null
 *     Connect to a browser instance via CDP
 *
 *   browser_binary_path: null
 *     Path to a Browser instance to use to connect to your normal browser
 *     e.g. '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome'
 *
 *   chrome_remote_debugging_port: 9222
 *     Chrome remote debugging port to use to when browser_binary_path is supplied.
 *     This allows running multiple chrome browsers with same browser_binary_path but running on different ports.
 *     Also, makes it possible to launch new user provided chrome browser without closing already opened chrome instances,
 *     by providing non-default chrome debugging port.
 *
 *   keep_alive: false
 *     Keep the browser alive after the agent has finished running
 *
 *   deterministic_rendering: false
 *     Enable deterministic rendering (makes GPU/font rendering consistent across different OS's and docker)
 */
export class BrowserConfig {
  wssUrl?: string
  cdpUrl?: string

  browserClass: 'chromium' | 'firefox' | 'webkit' = 'chromium'

  // Supports multiple legacy field names with aliases
  browserBinaryPath?: string

  // Support legacy field names
  set browserInstancePath(value: string | undefined) {
    this.browserBinaryPath = value
  }

  get browserInstancePath() {
    return this.browserBinaryPath
  }

  set chromeInstancePath(value: string | undefined) {
    this.browserBinaryPath = value
  }

  get chromeInstancePath() {
    return this.browserBinaryPath
  }

  chromeRemoteDebuggingPort: number = CHROME_DEBUG_PORT
  extraBrowserArgs: string[] = []

  headless: boolean = false
  // disable_security=True is dangerous as any malicious URL visited could embed an iframe for the user's bank, and use their cookies to steal money
  disableSecurity: boolean = false
  deterministicRendering: boolean = false

  // used to be called _force_keep_browser_alive
  keepAlive: boolean = false

  proxy?: ProxySettings
  newContextConfig: BrowserContextConfig = new BrowserContextConfig()

  constructor(config?: Partial<BrowserConfig>) {
    if (config) {
      Object.assign(this, config)
    }
  }
}

/**
 * @singleton: TODO - think about id singleton makes sense here
 * @dev By default this is a singleton, but you can create multiple instances if you need to.
 */
/**
 * Playwright browser on steroids.
 * This is persistent browser factory that can spawn multiple browser contexts.
 * It is recommended to use only one instance of Browser per your application (RAM usage will grow otherwise).
 */
export class Browser {
  config: BrowserConfig
  playwrightBrowser?: PlaywrightBrowser
  chromeSubprocessId?: number
  // playwright:
  constructor(config: BrowserConfig = new BrowserConfig()) {
    this.config = config
  }

  /**
   * Create a browser context
   * @param config
   */
  async newContext(config?: BrowserContextConfig) {
    const browserConfig = new BrowserConfig(this.config)
    const contextConfig = new BrowserContextConfig(config)
    const context = new BrowserContext({
      browser: this,
      config: { ...browserConfig, ...contextConfig },
    })
    await context.initializeSession()
    return context
  }

  async getPlaywrightBrowser() {
    if (!this.playwrightBrowser) {
      this.playwrightBrowser = await this.setupBrowser()
    }
    return this.playwrightBrowser
  }

  @timeExecutionAsync('--init (browser)')
  private async init() {
    this.playwrightBrowser = await this.setupBrowser()
    return this.playwrightBrowser
  }

  private async setupRemoteCdpBrowser(): Promise<PlaywrightBrowser> {
    // Firefox no longer supports CDP
    if (this.config.browserBinaryPath?.toLowerCase().includes('firefox')) {
      throw new Error(
        'CDP has been deprecated for Firefox, check: https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/',
      )
    }

    if (!this.config.cdpUrl) {
      throw new Error('CDP URL is required')
    }

    logger.info(`🔌 Connecting to remote browser via CDP ${this.config.cdpUrl}`)
    // Get the browser class based on config (chromium, webkit)
    const browserClass = playwright[this.config.browserClass]

    // Connect to the browser via CDP
    const browser = await chromium.connectOverCDP(this.config.cdpUrl, {
      timeout: 20000, // 20 second timeout for connection
    })

    return browser
  }

  /**
   * Sets up and returns a Playwright Browser instance using WebSocket connection
   * @param playwright - Playwright instance
   * @returns Connected browser instance
   */
  private async setupRemoteWssBrowser(): Promise<PlaywrightBrowser> {
    if (!this.config.wssUrl) {
      throw new Error('WSS URL is required')
    }

    logger.info(`🔌 Connecting to remote browser via WSS ${this.config.wssUrl}`)

    // Get the browser class based on config (chromium, firefox, webkit)
    const browserClass = playwright[this.config.browserClass]

    // Connect to the browser via WebSocket
    const browser = await browserClass.connect(this.config.wssUrl)

    return browser
  }

  /**
   * Sets up and returns a Playwright Browser instance using user-provided browser binary
   * @param playwright - Playwright instance
   * @returns Connected browser instance
   */

  private async setupUserProvidedBrowser(): Promise<PlaywrightBrowser> {
    if (!this.config.browserBinaryPath) {
      throw new Error('A browser_binary_path is required')
    }

    if (this.config.browserClass !== 'chromium') {
      throw new Error(
        'browser_binary_path only supports chromium browsers (make sure browser_class=chromium)',
      )
    }

    try {
      // Check if browser is already running
      const isRunning = await this.checkBrowserIsRunning()

      if (isRunning) {
        logger.info(
          `🔌 Reusing existing browser found running on http://localhost:${this.config.chromeRemoteDebuggingPort}`,
        )
        const browserClass = playwright[this.config.browserClass]
        const browser = await browserClass.connectOverCDP({
          endpointURL: `http://localhost:${this.config.chromeRemoteDebuggingPort}`,
          timeout: 20000, // 20 second timeout for connection
        })
        return browser
      }
    }
    catch (err) {
      logger.debug('🌎 No existing Chrome instance found, starting a new one')
    }

    // Start a new Chrome instance
    const chromeLaunchArgs = Array.from(new Set([
      `--remote-debugging-port=${this.config.chromeRemoteDebuggingPort}`,
      ...CHROME_ARGS,
      ...(IN_DOCKER ? CHROME_DOCKER_ARGS : []),
      ...(this.config.headless ? CHROME_HEADLESS_ARGS : []),
      ...(this.config.disableSecurity ? CHROME_DISABLE_SECURITY_ARGS : []),
      ...(this.config.deterministicRendering ? CHROME_DETERMINISTIC_RENDERING_ARGS : []),
      ...this.config.extraBrowserArgs,
    ]))

    // Start Chrome process
    const chromeProcess = spawn(
      this.config.browserBinaryPath,
      chromeLaunchArgs,
      {
        stdio: 'ignore',
        shell: false,
      },
    )

    // Store process reference for later cleanup
    this.chromeSubprocessId = chromeProcess.pid

    // Attempt to connect again after starting a new instance
    for (let i = 0; i < 10; i++) {
      try {
        const isRunning = await this.checkBrowserIsRunning()
        if (isRunning) {
          break
        }
      }
      catch (err) {
        // Ignore errors and continue trying
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    // Try to connect to the new instance
    try {
      const browserClass = playwright[this.config.browserClass]
      const browser = await browserClass.connectOverCDP(`http://localhost:${this.config.chromeRemoteDebuggingPort}`, {

        timeout: 20000, // 20 second timeout for connection
      })
      return browser

      // const browser = await chromium.launch({
      //   executablePath: this.config.browserBinaryPath,
      //   args: chromeLaunchArgs,
      //   headless: this.config.headless,
      //   proxy: this.config.proxy,
      //   handleSIGTERM: false,
      //   handleSIGINT: false,
      // })

      // return browser
    }
    catch (err) {
      logger.error(`❌ Failed to start a new Chrome instance: ${err}`)
      throw new Error(
        'To start chrome in Debug mode, you need to close all existing Chrome instances and try again otherwise we can not connect to the instance.',
      )
    }
  }

  /**
   * Sets up and returns a Playwright Browser instance using built-in browser
   * @param playwright - Playwright instance
   * @returns Connected browser instance
   */
  private async setupBuiltinBrowser(): Promise<PlaywrightBrowser> {
    if (this.config.browserBinaryPath) {
      throw new Error('browser_binary_path should be undefined if trying to use the builtin browsers')
    }

    // Use the configured window size from newContextConfig if available
    let screenSize: { width: number, height: number }
    let offsetX: number, offsetY: number

    if (
      !this.config.headless
      && this.config.newContextConfig
      && this.config.newContextConfig.windowWidth
      && this.config.newContextConfig.windowHeight
    ) {
      screenSize = {
        width: this.config.newContextConfig.windowWidth,
        height: this.config.newContextConfig.windowHeight,
      };
      [offsetX, offsetY] = getWindowAdjustments()
    }
    else if (this.config.headless) {
      screenSize = { width: 1920, height: 1080 }
      offsetX = 0
      offsetY = 0
    }
    else {
      screenSize = getScreenResolution();
      [offsetX, offsetY] = getWindowAdjustments()
    }

    // Build chrome args
    const chromeArgs = new Set([
      `--remote-debugging-port=${this.config.chromeRemoteDebuggingPort}`,
      ...CHROME_ARGS,
      ...(IN_DOCKER ? CHROME_DOCKER_ARGS : []),
      ...(this.config.headless ? CHROME_HEADLESS_ARGS : []),
      ...(this.config.disableSecurity ? CHROME_DISABLE_SECURITY_ARGS : []),
      ...(this.config.deterministicRendering ? CHROME_DETERMINISTIC_RENDERING_ARGS : []),
      `--window-position=${offsetX},${offsetY}`,
      `--window-size=${screenSize.width},${screenSize.height}`,
      ...this.config.extraBrowserArgs,
    ])

    // Check if chrome remote debugging port is already taken,
    // if so remove the remote-debugging-port arg to prevent conflicts
    const portInUse = await this.isPortInUse(this.config.chromeRemoteDebuggingPort || CHROME_DEBUG_PORT)
    if (portInUse) {
      chromeArgs.delete(`--remote-debugging-port=${this.config.chromeRemoteDebuggingPort}`)
    }

    // Define browser-specific arguments
    const browserClass = playwright[this.config.browserClass]
    const args = {
      chromium: [...chromeArgs],
      firefox: [
        '-no-remote',
        ...this.config.extraBrowserArgs,
      ],
      webkit: [
        '--no-startup-window',
        ...this.config.extraBrowserArgs,
      ],
    }

    // Launch the browser
    const browser = await browserClass.launch({
      headless: this.config.headless,
      args: args[this.config.browserClass],
      proxy: this.config.proxy,
      handleSIGTERM: false,
      handleSIGINT: false,
    })

    return browser
  }

  /**
   * Sets up and returns a Playwright Browser instance with anti-detection measures.
   */
  private async setupBrowser(): Promise<PlaywrightBrowser> {
    try {
      if (this.config.cdpUrl) {
        return await this.setupRemoteCdpBrowser()
      }

      if (this.config.wssUrl) {
        return await this.setupRemoteWssBrowser()
      }

      if (this.config.headless) {
        logger.warn('⚠️ Headless mode is not recommended. Many sites will detect and block all headless browsers.')
      }

      if (this.config.browserBinaryPath) {
        return await this.setupUserProvidedBrowser()
      }

      return await this.setupBuiltinBrowser()
    }
    catch (error) {
      logger.error('Failed to initialize Playwright browser', error)
      throw error
    }
  }

  // Helper method to check if browser is running
  private async checkBrowserIsRunning(): Promise<boolean> {
    const res = await axios.get(
      `http://localhost:${this.config.chromeRemoteDebuggingPort}/json/version`,
      {
        timeout: 2000,
      },
    )

    return res.status === 200
  }

  /**
   * Close the browser instance
   */
  async close() {
    if (this.config.keepAlive) {
      logger.info('Keeping browser alive')
      return
    }

    try {
      if (this.playwrightBrowser) {
        await this.playwrightBrowser.close()
      }
      if (this.chromeSubprocessId) {
        treeKill(this.chromeSubprocessId, 'SIGKILL', (err) => {
          if (err) {
            logger.error('Failed to kill Chrome subprocess', err)
          }
          else {
            logger.info('Killed Chrome subprocess')
          }
        })
      }
    }
    catch (e: any) {
      if (!e.message.include('OpenAI error')) {
        logger.debug(`Failed to close browser properly: ${e}`)
      }
    }
    finally {
      this.playwrightBrowser = undefined
      this.chromeSubprocessId = undefined
    }
  }

  // Helper method to check if port is in use
  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()

      server.once('error', () => {
      // Port is in use
        resolve(true)
      })

      server.once('listening', () => {
      // Port is free, close the server
        server.close()
        resolve(false)
      })

      server.listen(port, 'localhost')
    })
  }
}
