import type { SelectorMap } from '@/dom/views'
import type { BrowserContextOptions, ElementHandle, FrameLocator, Geolocation, HTTPCredentials, Page, Browser as PlaywrightBrowser, BrowserContext as PlaywrightBrowserContext, Request, Response } from 'playwright'

import type { Browser } from './browser'
import type { BrowserState } from './view'
import * as crypto from 'node:crypto'
import fs from 'node:fs'
import * as path from 'node:path'
import { ClickableElementProcessor } from '@/dom/clickable_element_processor/service'
import { DomService } from '@/dom/service'
import { DOMElementNode } from '@/dom/views'
import { timeExecutionAsync, timeExecutionSync } from '@/utils'
import { v4 as uuidV4 } from 'uuid'
import { Logger } from '../logger'
import { BrowserError, TabInfo, URLNotAllowedError } from './view'

const logger = Logger.getLogger('browser.context')

const BROWSER_NAVBAR_HEIGHT = {
  windows: 85,
  darwin: 80,
  linux: 90,
}[process.platform.toLowerCase()] || 85

export class BrowserContextConfig {
  // Path to cookies file for persistence
  cookiesFile?: string
  // Minimum time to wait before getting page state for LLM input
  minimumWaitPageLoadTime: number = 0.25
  // Time to wait for network requests to finish before getting page state.
  // Lower values may result in incomplete page loads.
  waitForNetworkIdlePageLoadTime: number = 0.5
  //  Maximum time to wait for page load before proceeding anyway
  maximumWaitPageLoadTime: number = 5
  waitBetweenActions: number = 0.5

  // Disable browser security features (dangerous, but cross-origin iframe support requires it)
  // disable_security=true is dangerous as any malicious URL visited
  // could embed an iframe for the user's bank, and use their cookies to steal money
  disableSecurity: boolean = false

  // Default browser window dimensions
  windowWidth: number = 1280
  windowHeight: number = 1100

  // When true (default), the browser window size determines the viewport.
  // When false, forces a fixed viewport size using window_width and window_height. (constraint of the rendered content to a smaller area than the default of the entire window size)
  noViewport: boolean = true // true is the default for headful mode - browser window size determines viewport

  // Path to save video recordings
  saveRecordingPath?: string
  // Path to save downloads to
  saveDownloadsPath?: string

  saveHarPath?: string
  tracePath?: string

  //  Specify user locale, for example en-GB, de-DE, etc. Locale will affect navigator.language value, Accept-Language request header value as well as number and date formatting rules. If not provided, defaults to the system default locale.
  locale?: string
  // 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.102 Safari/537.36'
  // custom user agent to use.
  userAgent?: string

  // Highlight elements in the DOM on the screen
  highlightElements: boolean = true
  //  Viewport expansion in pixels. This amount will increase the number of elements which are included in the state what the LLM will see. If set to -1, all elements will be included (this leads to high token usage). If set to 0, only the elements which are visible in the viewport will be included.
  viewportExpansion: number = 0
  // List of allowed domains that can be accessed. If null, all domains are allowed.
  // Example: ['example.com', 'api.example.com']
  allowedDomains?: string[]

  // Include dynamic attributes in the CSS selector. If you want to reuse the css_selectors, it might be better to set this to false.
  includeDynamicAttributes: boolean = true

  // Dictionary with HTTP basic authentication credentials for corporate intranets (only supports one set of credentials for all URLs at the moment), e.g.
  // {"username": "bill", "password": "pa55w0rd"}
  httpCredentials?: HTTPCredentials

  // used to be called _force_keep_context_alive
  keepAlive: boolean = false
  // Whether the meta viewport tag is taken into account and touch events are enabled.
  isMobile?: boolean
  // Whether to enable touch events in the browser.
  hasTouch?: boolean
  // Geolocation to be used in the browser context. Example: {'latitude': 59.95, 'longitude': 30.31667}
  geolocation?: Geolocation
  //  Browser permissions to grant. See full list here: https://playwright.dev/python/docs/api/class-browsercontext#browser-context-grant-permissions
  permissions: string[] = [
    'clipboard-read',
    'clipboard-write',
  ]

  // Changes the timezone of the browser. Example: 'Europe/Berlin'
  timezoneId?: string

  // Forces a new browser context to be created. Useful when running locally with branded browser (e.g Chrome, Edge) and setting a custom config.
  forceNewContext: boolean = false

  constructor(options?: Partial<BrowserContextConfig>) {
    if (options) {
      Object.assign(this, options)
    }
  }
}

// Use a WeakMap to store unique IDs for objects
const objectIdMap = new WeakMap<object, string>()
let nextId = 0

// Helper function to generate unique ID
function id(obj: any): string {
  // If obj is an object and not null
  if (obj !== null && typeof obj === 'object') {
    // Check if this object already has an ID
    let objId = objectIdMap.get(obj)
    if (!objId) {
      // Generate a new ID using current timestamp + random number
      objId = `${nextId}`
      nextId += 1
      objectIdMap.set(obj, objId)
    }
    return objId
  }

  if (typeof obj === 'string') {
    return crypto.createHash('sha256').update(obj).digest('hex')
  }

  // For numbers, booleans, etc.
  return String(obj)
}

/**
 * Clickable elements hashes for the last state
 */
interface CachedStateClickableElementsHashes {
  url: string
  hashes: Set<string>
}

interface BrowserSession {
  context: PlaywrightBrowserContext
  cachedState?: BrowserState
  cachedStateClickableElementsHashes?: CachedStateClickableElementsHashes
}

interface BrowserContextState {
  // CDP target ID
  targetId?: string
}

export class BrowserContext {
  browser: Browser
  config: BrowserContextConfig
  contextId: string = uuidV4()
  state: BrowserContextState
  // Initialize these as None - they'll be set up when needed
  session?: BrowserSession
  // Tab references - separate concepts for agent intent and browser state

  agentCurrentPage?: Page // The tab the agent intends to interact with
  humanCurrentPage?: Page // The tab currently shown in the browser UI

  currentState?: BrowserState

  pageEventHandler?: (page: Page) => void
  constructor(
    {
      browser,
      config,
      state,
    }:
      {
        browser: Browser
        config?: BrowserContextConfig
        state?: BrowserContextState
      },
  ) {
    this.browser = browser
    this.config = config || new BrowserContextConfig({ ...(this.browser.config || {}) })
    this.state = state || {}
  }

  /**
   * Close the browser instance
   */
  @timeExecutionSync('--close')
  async close() {
    try {
      if (!this.session) {
        return
      }

      if (this.session.context && this.pageEventHandler) {
        try {
          this.session.context.removeListener('page', this.pageEventHandler)
        }
        catch (e) {
          logger.error(`Failed to remove CDP listener: ${e}`)
        }
      }
      await this.saveCookies()

      if (this.config?.tracePath) {
        try {
          await this.session.context.tracing.stop({
            path: path.join(this.config.tracePath, `${this.contextId}.zip`),
          })
        }
        catch (e) {
          logger.debug(`Failed to stop tracing: #{e}`)
        }
      }

      if (!this.config.keepAlive) {
        logger.debug('Closing browser context')
        try {
          await this.session.context.close()
        }
        catch (e) {
          logger.error(`Failed to close context: ${e}`)
        }
      }
    }
    catch (e) {
      logger.error('Error closing browser context', e)
    }
    finally {
      this.humanCurrentPage = undefined
      this.agentCurrentPage = undefined
      this.session = undefined
      this.pageEventHandler = undefined
    }
  }

  /**
   * Initialize the browser session
   */
  async initializeSession() {
    logger.debug(`🌎  Initializing new browser context with id: ${this.contextId}`)
    const playwrightBrowser = await this.browser.getPlaywrightBrowser()

    const context = await this.createContext(playwrightBrowser)
    this.pageEventHandler = undefined

    // auto-attach the foregrounding-detection listener to all new pages opened
    context.on('page', this.addTabForegroundingListener)
    // Get or create a page to use
    const pages = context.pages()
    this.session = {
      context,
      cachedState: undefined,
    }

    let currentPage: Page | undefined

    if (this.browser.config.cdpUrl) {
      // If we have a saved target ID, try to find and activate it
      if (this.state.targetId) {
        const targets = await this.getCdpTargets()

        for (const target of targets) {
          if (target.targetId === this.state.targetId) {
            // Find matching page by URL
            for (const page of pages) {
              if (page.url() === target.url) {
                currentPage = page
                break
              }
            }
            break
          }
        }
      }
    }

    // If no target ID or couldn't find it, use existing page or create new
    if (!currentPage) {
      if (
        pages
        && pages.length > 0
        && pages[0].url()
        && !pages[0].url().startsWith('chrome://') // skip chrome internal pages e.g. settings, history, etc
        && !pages[0].url().startsWith('chrome-extension://') // skip hidden extension background pages
      ) {
        currentPage = pages[0]
        logger.debug('🔍 Using existing page: ', currentPage.url())
      }
      else {
        currentPage = await context.newPage()
        await currentPage.goto('about:blank')
        logger.debug('🆕 Created new page: ', currentPage.url())
      }

      // Get target ID for the active page
      if (this.browser.config.cdpUrl) {
        const targets = await this.getCdpTargets()
        for (const target of targets) {
          if (target.url === currentPage.url()) {
            this.state.targetId = target.targetId
            break
          }
        }
      }
    }

    // Bring page to front
    logger.debug(`🫨  Bringing tab to front: ${currentPage.url()}`)

    await currentPage.bringToFront()
    await currentPage.waitForLoadState('load')

    // Set the viewport size for the active page
    await this.setViewportSize(currentPage)

    // Initialize both tab references to the same page initially
    this.agentCurrentPage = currentPage
    this.humanCurrentPage = currentPage

    for (const page of pages) {
      if (!page.url().startsWith('chrome-extension://') && !page.url().startsWith('chrome://') && page.isClosed()) {
        await this.addTabForegroundingListener(page)
      }
    }
    return this.session
  }

  /**
   * Attaches listeners that detect when the human steals active tab focus away from the agent.
   *
   * Uses a combination of:
   * - visibilitychange events
   * - window focus/blur events
   * - pointermove events
   *
   * This multi-method approach provides more reliable detection across browsers.
   *
   * TODO: pester the playwright team to add a new event that fires when a headful tab is focused.
   * OR implement a browser-use chrome extension that acts as a bridge to the chrome.tabs API.
   *
   *     - https://github.com/microsoft/playwright/issues/1290
   *     - https://github.com/microsoft/playwright/issues/2286
   *     - https://github.com/microsoft/playwright/issues/3570
   *     - https://github.com/microsoft/playwright/issues/13989
   */
  private addTabForegroundingListener = async (page: Page): Promise<void> => {
    function trunc(s: string, maxLen?: number): string {
      s = s.replace('https://', '').replace('http://', '').replace('www.', '')
      if (maxLen !== undefined && s.length > maxLen) {
        return `${s.slice(0, maxLen)}…`
      }
      return s
    }

    try {
      // Generate a unique function name for this page
      const visibilityFuncName = `onVisibilityChange_${id(page)}${id(page.url())}`

      // Define the callback that will be called from browser when tab becomes visible
      const onVisibilityChange = async (data: { source: string }): Promise<void> => {
        const source = data.source || 'unknown'

        // Log before and after for debugging
        const oldForeground = this.humanCurrentPage
        if (oldForeground?.url() !== page.url()) {
          logger.warn(
            `👁️ Foregound tab changed by human from ${oldForeground ? trunc(oldForeground.url(), 22) : 'about:blank'} to ${trunc(page.url(), 22)} (${source}) but agent will stay on ${trunc(this.agentCurrentPage?.url() || '', 22)}`,
          )
        }

        // Update foreground tab
        this.humanCurrentPage = page
      }

      // Expose the function to the browser
      await page.exposeFunction(visibilityFuncName, onVisibilityChange)

      // multiple reasons for doing it this way: stealth, uniqueness, sometimes pageload is cancelled and it runs twice, etc.
      const res = await page.evaluate((visibilityFuncName) => {
        // Set up multiple visibility detection methods in the browser
        // --- Method 1: visibilitychange event (unfortunately *all* tabs are always marked visible by playwright, usually does not fire) ---
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            // @ts-expect-error
            window[visibilityFuncName]({ source: 'visibilitychange' })
          }
        })

        // --- Method 2: focus/blur events, most reliable method for headful browsers ---
        window.addEventListener('focus', () => {
          // @ts-expect-error
          window[visibilityFuncName]({ source: 'focus' })
        })
        // @ts-expect-error
        return window[visibilityFuncName]

      // --- Method 3: pointermove events (may be fired by agent if we implement AI hover movements) ---
      // Use a throttled handler to avoid excessive calls
      // let lastMove = 0;
      // window.addEventListener('pointermove', () => {
      //  const now = Date.now();
      //  if (now - lastMove > 1000) {  // Throttle to once per second
      //    lastMove = now;
      //    window.${visibilityFuncName}({ source: 'pointermove' });
      //  }
      // });
      }, visibilityFuncName)

      // re-add listener to the page for when it navigates to a new url, because previous listeners will be cleared
      page.on('domcontentloaded', this.addTabForegroundingListener)
      logger.debug(`👀 Added tab focus listeners to tab: ${page.url()}`)

      if (page.url() !== this.agentCurrentPage?.url()) {
        await onVisibilityChange({ source: 'navigation' })
      }
    }
    catch (e) {
      logger.debug(`Failed to add tab focus listener to ${page.url()}: ${e}`)
    }
  }

  /**
   * Lazy initialization of the browser and related components
   */
  async getSession() {
    if (!this.session) {
      try {
        return await this.initializeSession()
      }
      catch (e) {
        logger.error(`❌  Failed to create new browser session: ${e} (did the browser process quit?)`)
        throw e
      }
    }
    return this.session
  }

  /**
   * Legacy method for backwards compatibility, prefer get_agent_current_page()
   */
  async getCurrentPage() {
    return await this.getAgentCurrentPage()
  }

  /**
   * Reconcile tab state when tabs might be out of sync.
   *
   * This method ensures that:
   * 1. Both tab references (agentCurrentPage and humanCurrentPage) are valid
   * 2. Recovers invalid tab references using valid ones
   * 3. Handles the case where both references are invalid
   */
  async reconcileTabState(): Promise<void> {
    const session = await this.getSession()

    const agentTabValid = (
      this.agentCurrentPage
      && session.context.pages().includes(this.agentCurrentPage)
      && !this.agentCurrentPage.isClosed()
    )

    const humanCurrentPageValid = (
      this.humanCurrentPage
      && session.context.pages().includes(this.humanCurrentPage)
      && !this.humanCurrentPage.isClosed()
    )

    // Case 1: Both references are valid - nothing to do
    if (agentTabValid && humanCurrentPageValid) {
      return
    }

    // Case 2: Only agentCurrentPage is valid - update humanCurrentPage
    if (agentTabValid && !humanCurrentPageValid) {
      this.humanCurrentPage = this.agentCurrentPage
      return
    }

    // Case 3: Only humanCurrentPage is valid - update agentCurrentPage
    if (humanCurrentPageValid && !agentTabValid) {
      this.agentCurrentPage = this.humanCurrentPage
      return
    }

    // Case 4: Neither reference is valid - recover from available tabs
    const nonExtensionPages = session.context.pages().filter(
      page => !page.url().startsWith('chrome-extension://') && !page.url().startsWith('chrome://'),
    )

    if (nonExtensionPages.length > 0) {
      // Update both tab references to the most recently opened non-extension page
      const recoveredPage = nonExtensionPages[nonExtensionPages.length - 1]
      this.agentCurrentPage = recoveredPage
      this.humanCurrentPage = recoveredPage
      return
    }

    // Case 5: No valid pages at all - create a new page
    try {
      const newPage = await session.context.newPage()
      this.agentCurrentPage = newPage
      this.humanCurrentPage = newPage
    }
    catch (e) {
      // Last resort - recreate the session
      logger.warn('⚠️ No browser window available, recreating session')
      await this.initializeSession()
      if (session.context.pages().length > 0) {
        const page = session.context.pages()[0]
        this.agentCurrentPage = page
        this.humanCurrentPage = page
      }
    }
  }

  /**
   * Get the page that the agent is currently working with.
   *
   * This method prioritizes agent_current_page over human_current_page, ensuring
   * that agent operations happen on the intended tab regardless of user
   * interaction with the browser.
   *
   * If agent_current_page is invalid or closed, it will attempt to recover
   * with a valid tab reference by reconciling the tab state.
   */
  async getAgentCurrentPage() {
    const session = await this.getSession()

    // First check if agent_current_page is valid
    if (this.agentCurrentPage && session.context.pages().includes(this.agentCurrentPage) && !this.agentCurrentPage.isClosed()) {
      return this.agentCurrentPage
    }

    // If we're here, reconcile tab state and try again
    await this.reconcileTabState()

    // After reconciliation, agent_current_page should be valid

    if (this.agentCurrentPage && session.context.pages().includes(this.agentCurrentPage) && !this.agentCurrentPage.isClosed()) {
      return this.agentCurrentPage
    }

    // If still invalid, fall back to first page method as last resort

    logger.warn('⚠️  Failed to get agent current page, falling back to first page')

    if (session.context.pages()) {
      const page = session.context.pages()[0]
      this.agentCurrentPage = page
      this.humanCurrentPage = page
      return page
    }

    return await session.context.newPage()
  }

  /**
   * Creates a new browser context with anti-detection measures and loads cookies if available.
   * @param playwrightBrowser
   */
  private async createContext(browser: PlaywrightBrowser) {
    let context: PlaywrightBrowserContext
    if (this.browser.config.cdpUrl && browser.contexts().length > 0 && !this.config.forceNewContext) {
      context = browser.contexts()[0]
      if (context.pages().length > 0 && !this.browser.config.headless) {
        for (const page of context.pages()) {
          await this.setViewportSize(page)
        }
      }
    }
    else if (this.browser.config.browserBinaryPath && browser.contexts().length > 0 && !this.config.forceNewContext) {
      context = browser.contexts()[0]
      if (context.pages().length > 0 && !this.browser.config.headless) {
        for (const page of context.pages()) {
          await this.setViewportSize(page)
        }
      }
    }
    else {
      const args: BrowserContextOptions = {}
      // set viewport for both headless and non-headless modes
      if (this.browser.config.headless) {
        // on headless mode, always set viewport and no_viewport=False
        args.viewport = {
          width: this.config.windowWidth,
          height: this.config.windowHeight,
        }
      }
      else {
        args.viewport = this.config.noViewport
          ? undefined
          : {
              width: this.config.windowWidth,
              height: this.config.windowHeight,
            }
        if (this.config.userAgent) {
          args.userAgent = this.config.userAgent
        }
      }

      context = await browser.newContext({
        ...args,
        javaScriptEnabled: true,
        bypassCSP: this.config.disableSecurity,
        ignoreHTTPSErrors: this.config.disableSecurity,
        recordVideo: this.config.saveRecordingPath
          ? {
              dir: this.config.saveRecordingPath,
              size: {
                width: this.config.windowWidth,
                height: this.config.windowHeight,
              },
            }
          : undefined,
        recordHar: this.config.saveHarPath
          ? {
              path: this.config.saveHarPath,
            }
          : undefined,
        locale: this.config.locale,
        httpCredentials: this.config.httpCredentials,
        isMobile: this.config.isMobile,
        hasTouch: this.config.hasTouch,
        geolocation: this.config.geolocation,
        permissions: this.config.permissions,
        timezoneId: this.config.timezoneId,
      })
    }

    // Ensure required permissions are granted
    const requiredPermissions = ['clipboard-read', 'clipboard-write'] // needed for google sheets automation
    if (this.config.geolocation) {
      requiredPermissions.push('geolocation')
    }

    // Check missing permissions
    const missingPermissions = requiredPermissions.filter(p => !this.config.permissions.includes(p))
    if (missingPermissions.length > 0) {
      logger.warn(
        `⚠️ Some permissions required by browser-use ${missingPermissions} are missing from BrowserContextConfig(permissions=${this.config.permissions}), some features may not work properly!`,
      )
    }
    await context.grantPermissions(this.config.permissions)

    // Start tracing if trace path is set
    if (this.config.tracePath) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    }

    // Resize the window for non-headless mode
    if (!this.browser.config.headless) {
      await this.resizeWindow(context)
    }

    // Load cookies if they exist
    if (this.config.cookiesFile && fs.existsSync(this.config.cookiesFile)) {
      try {
        const fileContent = await fs.promises.readFile(this.config.cookiesFile, 'utf8')
        const cookies = JSON.parse(fileContent)

        const validSameSiteValues = ['Strict', 'Lax', 'None']
        for (const cookie of cookies) {
          if ('sameSite' in cookie) {
            if (!validSameSiteValues.includes(cookie.sameSite)) {
              logger.warn(
                `Fixed invalid sameSite value '${cookie.sameSite}' to 'None' for cookie ${cookie.name}`,
              )
              cookie.sameSite = 'None'
            }
          }
        }
        logger.info(`🍪 Loaded ${cookies.length} cookies from ${this.config.cookiesFile}`)
        await context.addCookies(cookies)
      }
      catch (e) {
        if (e instanceof SyntaxError) {
          logger.error(`Failed to parse cookies file: ${e.toString()}`)
        }
        else {
          logger.error(`Error loading cookies: ${e}`)
        }
      }
    }
    // Anti-detection scripts to inject into browser context
    const initScript = `

  ;
  `

    // Expose anti-detection scripts
    await context.addInitScript(() => {
      // Permissions
      const originalQuery = window.navigator.permissions.query
      // @ts-expect-error
      window.navigator.permissions.query = parameters => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
      (() => {
        // @ts-expect-error
        if (window._eventListenerTrackerInitialized)
          return
        // @ts-expect-error
        window._eventListenerTrackerInitialized = true

        const originalAddEventListener = EventTarget.prototype.addEventListener
        const eventListenersMap = new WeakMap()

        EventTarget.prototype.addEventListener = function (type, listener, options) {
          if (typeof listener === 'function') {
            let listeners = eventListenersMap.get(this)
            if (!listeners) {
              listeners = []
              eventListenersMap.set(this, listeners)
            }

            listeners.push({
              type,
              listener,
              listenerPreview: listener.toString().slice(0, 100),
              options,
            })
          }

          return originalAddEventListener.call(this, type, listener, options)
        }

        // @ts-expect-error
        window.getEventListenersForNode = (node) => {
          const listeners = eventListenersMap.get(node) || []
          return listeners.map(({ type, listenerPreview, options }: any) => ({
            type,
            listenerPreview,
            options,
          }))
        }
      })()
    })
    return context
  }

  private async waitForStableNetwork(): Promise<void> {
    const page = await this.getAgentCurrentPage()

    const pendingRequests = new Set<Request>()
    let lastActivity = performance.now()

    // Define relevant resource types and content types
    const RELEVANT_RESOURCE_TYPES = new Set([
      'document',
      'stylesheet',
      'image',
      'font',
      'script',
      'iframe',
    ])

    const RELEVANT_CONTENT_TYPES = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ])

    // Additional patterns to filter out
    const IGNORED_URL_PATTERNS = new Set([
      // Analytics and tracking
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      // Ad-related
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      // Social media widgets
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      // Live chat and support
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      // Push notifications
      'push-notifications',
      'onesignal',
      'pushwoosh',
      // Background sync/heartbeat
      'heartbeat',
      'ping',
      'alive',
      // WebRTC and streaming
      'webrtc',
      'rtmp://',
      'wss://',
      // Common CDNs for dynamic content
      'cloudfront.net',
      'fastly.net',
    ])

    const onRequest = async (request: Request): Promise<void> => {
      // Filter by resource type
      if (!RELEVANT_RESOURCE_TYPES.has(request.resourceType())) {
        return
      }

      // Filter out streaming, websocket, and other real-time requests
      if (['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(request.resourceType())) {
        return
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase()
      if (Array.from(IGNORED_URL_PATTERNS).some(pattern => url.includes(pattern))) {
        return
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return
      }

      // Filter out requests with certain headers
      const headers = request.headers()
      if (headers.purpose === 'prefetch'
        || ['video', 'audio'].includes(headers['sec-fetch-dest'])) {
        return
      }

      pendingRequests.add(request)
      lastActivity = performance.now()
      // logger.debug(`Request started: ${request.url()} (${request.resourceType()})`);
    }

    const onResponse = async (response: Response): Promise<void> => {
      const request = response.request()
      if (!pendingRequests.has(request)) {
        return
      }

      // Filter by content type if available
      const contentType = response.headers()['content-type']?.toLowerCase() || ''

      // Skip if content type indicates streaming or real-time data
      if (['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf'].some(t => contentType.includes(t))) {
        pendingRequests.delete(request)
        return
      }

      // Only process relevant content types
      if (!Array.from(RELEVANT_CONTENT_TYPES).some(ct => contentType.includes(ct))) {
        pendingRequests.delete(request)
        return
      }

      // Skip if response is too large (likely not essential for page load)
      const contentLength = response.headers()['content-length']
      if (contentLength && Number.parseInt(contentLength) > 5 * 1024 * 1024) { // 5MB
        pendingRequests.delete(request)
        return
      }

      pendingRequests.delete(request)
      lastActivity = performance.now()
      // logger.debug(`Request resolved: ${request.url()} (${contentType})`);
    }

    // Attach event listeners
    page.on('request', onRequest)
    page.on('response', onResponse)

    try {
      // Wait for idle time
      const startTime = performance.now()
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100)) // Sleep 100ms
        const now = performance.now()
        if (pendingRequests.size === 0
          && (now - lastActivity) >= this.config.waitForNetworkIdlePageLoadTime * 1000) {
          break
        }
        if (now - startTime > this.config.maximumWaitPageLoadTime * 1000) {
          logger.debug(
            `Network timeout after ${this.config.maximumWaitPageLoadTime}s with ${pendingRequests.size} `
            + `pending requests: ${Array.from(pendingRequests).map(r => r.url())}`,
          )
          break
        }
      }
    }
    finally {
      // Clean up event listeners
      page.removeListener('request', onRequest)
      page.removeListener('response', onResponse)
    }

    logger.debug(`⚖️ Network stabilized for ${this.config.waitForNetworkIdlePageLoadTime} seconds`)
  }

  /**
   * Ensures page is fully loaded before continuing.
   * Waits for either network to be idle or minimum WAIT_TIME, whichever is longer.
   * Also checks if the loaded URL is allowed.
   *
   * @param timeoutOverwrite Optional timeout value to override the config value
   */
  private async waitForPageAndFramesLoad(timeoutOverwrite?: number): Promise<void> {
    // Start timing
    const startTime = performance.now()

    // Wait for page load
    try {
      await this.waitForStableNetwork()

      // Check if the loaded URL is allowed
      const page = await this.getAgentCurrentPage()
      await this.checkAndHandleNavigation(page)
    }
    catch (e) {
      if (e instanceof URLNotAllowedError) {
        throw e
      }
      else {
        logger.warn('⚠️ Page load failed, continuing...')
      }
    }

    // Calculate remaining time to meet minimum WAIT_TIME
    const elapsed = (performance.now() - startTime) / 1000 // Convert ms to seconds
    const configTimeout = timeoutOverwrite ?? this.config.minimumWaitPageLoadTime
    const remaining = Math.max(configTimeout - elapsed, 0)

    logger.debug(`--Page loaded in ${elapsed.toFixed(2)} seconds, waiting for additional ${remaining.toFixed(2)} seconds`)

    // Sleep remaining time if needed
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining * 1000))
    }
  }

  /**
   * Check if a URL is allowed based on the whitelist configuration.
   * @param url - URL string to check
   * @returns boolean indicating if the URL is allowed
   */
  isUrlAllowed(url: string): boolean {
    if (!this.config.allowedDomains) {
      return true
    }

    try {
      // Special case: Allow 'about:blank' explicitly
      if (url === 'about:blank') {
        return true
      }

      const parsedUrl = new URL(url)

      // Extract only the hostname component (without auth credentials or port)
      // Hostname returns only the domain portion, ignoring username:password and port
      const domain = parsedUrl.hostname.toLowerCase()

      // Check if domain matches any allowed domain pattern
      return this.config.allowedDomains.some(
        allowedDomain =>
          domain === allowedDomain.toLowerCase()
          || domain.endsWith(`.${allowedDomain.toLowerCase()}`),
      )
    }
    catch (e) {
      logger.error(`⛔️ Error checking URL allowlist: ${e}`)
      return false
    }
  }

  /**
   * Check if current page URL is allowed and handle if not.
   * @param page - The current page to check
   */
  private async checkAndHandleNavigation(page: Page): Promise<void> {
    if (!this.isUrlAllowed(page.url())) {
      logger.warn(`⛔️ Navigation to non-allowed URL detected: ${page.url()}`)
      try {
        await this.goBack()
      }
      catch (e) {
        logger.error(`⛔️ Failed to go back after detecting non-allowed URL: ${e}`)
      }
      throw new URLNotAllowedError(`Navigation to non-allowed URL: ${page.url()}`)
    }
  }

  /**
   * Navigate the agent's current tab to a URL
   * @param url
   */
  async navigateTo(url: string) {
    if (!this.isUrlAllowed(url)) {
      throw new BrowserError(`Navigation to non-allowed URL: ${url}`)
    }

    const page = await this.getAgentCurrentPage()
    await page.goto(url)
    await page.waitForLoadState()
  }

  /**
   * Refresh the agent's current page
   */
  async refreshPage() {
    const page = await this.getAgentCurrentPage()
    await page.reload()
    await page.waitForLoadState()
  }

  /**
   * Navigate the agent's tab back in browser history
   */
  async goBack() {
    const page = await this.getAgentCurrentPage()
    try {
      // 10 ms timeout
      await page.goBack({
        timeout: 10,
        waitUntil: 'domcontentloaded',
      })
    }
    catch (e) {
      // Continue even if its not fully loaded, because we wait later for the page to load
      logger.debug(`⏮️  Error during goBack: ${e}`)
    }
  }

  /**
   * Navigate the agent's tab forward in browser history
   */
  async goForward() {
    const page = await this.getAgentCurrentPage()
    try {
      // 10 ms timeout
      await page.goForward({
        timeout: 10,
        waitUntil: 'domcontentloaded',
      })
    }
    catch (e) {
      // Continue even if its not fully loaded, because we wait later for the page to load
      logger.debug(`⏮️  Error during goForward: ${e}`)
    }
  }

  /**
   * Close the current tab that the agent is working with.
   *
   * This closes the tab that the agent is currently using (agentCurrentPage),
   * not necessarily the tab that is visible to the user (humanCurrentPage).
   * If they are the same tab, both references will be updated.
   */
  async closeCurrentTab(): Promise<void> {
    const session = await this.getSession()
    const page = await this.getAgentCurrentPage()

    // Check if this is the foreground tab as well
    const isForeground = page === this.humanCurrentPage

    // Close the tab
    await page.close()

    // Clear agent's reference to the closed tab
    this.agentCurrentPage = undefined

    // Clear foreground reference if needed
    if (isForeground) {
      this.humanCurrentPage = undefined
    }

    // Switch to the first available tab if any exist
    if (session.context.pages().length > 0) {
      await this.switchToTab(0)
      // switch_to_tab already updates both tab references
    }

    // Otherwise, the browser will be closed
  }

  /**
   * Get the HTML content of the agent's current page
   */
  async getPageHtml(): Promise<string> {
    const page = await this.getAgentCurrentPage()
    return await page.content()
  }

  /**
   * Execute JavaScript code on the agent's current page
   * @param script - JavaScript code to execute
   */
  async executeJavaScript(script: Parameters<Page['evaluate']>[0]) {
    const page = await this.getAgentCurrentPage()
    return await page.evaluate(script)
  }

  /**
   * Get a debug view of the page structure including iframes
   * @returns A string representation of the page structure
   */
  async getPageStructure(): Promise<string> {
    const page = await this.getAgentCurrentPage()
    const structure = await page.evaluate(() => {
      function getPageStructure(element: HTMLElement | Document = document, depth = 0, maxDepth = 10) {
        if (depth >= maxDepth)
          return ''

        const indent = '  '.repeat(depth)
        let structure = ''

        // Skip certain elements that clutter the output
        const skipTags = new Set(['script', 'style', 'link', 'meta', 'noscript'])

        // Add current element info if it's not the document
        if (element instanceof HTMLElement) {
          const tagName = element.tagName.toLowerCase()

          // Skip uninteresting elements
          if (skipTags.has(tagName))
            return ''

          const id = element.id ? `#${element.id}` : ''
          const classes = element.className && typeof element.className === 'string'
            ? `.${element.className.split(' ').filter(c => c).join('.')}`
            : ''

          // Get additional useful attributes
          const attrs = []
          if (element.getAttribute('role'))
            attrs.push(`role="${element.getAttribute('role')}"`)
          if (element.getAttribute('aria-label'))
            attrs.push(`aria-label="${element.getAttribute('aria-label')}"`)
          if (element.getAttribute('type'))
            attrs.push(`type="${element.getAttribute('type')}"`)
          if (element.getAttribute('name'))
            attrs.push(`name="${element.getAttribute('name')}"`)
          if (element.getAttribute('src')) {
            const src = element.getAttribute('src')!
            attrs.push(`src="${src.substring(0, 50)}${src.length > 50 ? '...' : ''}"`)
          }

          // Add element info
          structure += `${indent}${tagName}${id}${classes}${attrs.length ? ` [${attrs.join(', ')}]` : ''}\n`

          // Handle iframes specially
          if (tagName === 'iframe') {
            try {
              const iframeDoc = (element as HTMLIFrameElement).contentDocument || (element as HTMLIFrameElement).contentWindow?.document
              if (iframeDoc) {
                structure += `${indent}  [IFRAME CONTENT]:\n`
                structure += getPageStructure(iframeDoc, depth + 2, maxDepth)
              }
              else {
                structure += `${indent}  [IFRAME: No access - likely cross-origin]\n`
              }
            }
            catch (e: any) {
              structure += `${indent}  [IFRAME: Access denied - ${e.message}]\n`
            }
          }
        }

        // Get all child elements
        const children = element.children || element.childNodes
        for (const child of children) {
          if (child.nodeType === 1) { // Element nodes only
            structure += getPageStructure(child as HTMLElement, depth + 1, maxDepth)
          }
        }

        return structure
      }

      return getPageStructure()
    })
    return structure
  }

  /**
   * Get the current state of the browser
   *
   * @param cacheClickableElementsHashes - If true, cache the clickable elements hashes for the current state.
   *                                       This is used to calculate which elements are new to the llm
   *                                       (from last message) -> reduces token usage.
   * @returns The current browser state
   */
  @timeExecutionAsync('--get_state') // This decorator might need to be updated to handle async
  async getState(cacheClickableElementsHashes: boolean): Promise<BrowserState> {
    await this.waitForPageAndFramesLoad()
    const session = await this.getSession()
    const updatedState = await this.getUpdatedState()

    // Find out which elements are new
    // Do this only if url has not changed
    if (cacheClickableElementsHashes) {
      // If we are on the same url as the last state, we can use the cached hashes
      if (
        session.cachedStateClickableElementsHashes
        && session.cachedStateClickableElementsHashes.url === updatedState.url
      ) {
        // Pointers, feel free to edit in place
        const updatedStateClickableElements = ClickableElementProcessor.getClickableElements(updatedState.elementTree!)

        for (const domElement of updatedStateClickableElements) {
          domElement.isNew = (
            !session.cachedStateClickableElementsHashes.hashes.has(
              ClickableElementProcessor.hashDomElement(domElement),
            ) // See which elements are new from the last state where we cached the hashes
          )
        }
      }
      // In any case, we need to cache the new hashes
      session.cachedStateClickableElementsHashes = {
        url: updatedState.url,
        hashes: ClickableElementProcessor.getClickableElementsHashes(updatedState.elementTree!),
      }
    }

    session.cachedState = updatedState

    // Save cookies if a file is specified
    if (this.config.cookiesFile) {
      // Use Promise.resolve to avoid blocking
      await this.saveCookies()
    }

    return session.cachedState!
  }

  /**
   * Update and return browser state.
   * @param focusElement - Index of element to focus on
   * @returns Updated browser state
   */
  private async getUpdatedState(focusElement: number = -1): Promise<BrowserState> {
    const session = await this.getSession()

    let page: Page
    // Check if current page is still valid, if not switch to another available page
    try {
      page = await this.getAgentCurrentPage()
      // Test if page is still accessible
      await page.evaluate('1')
    }
    catch (e) {
      logger.debug(`👋 Current page is no longer accessible: ${e}`)
      throw new BrowserError('Browser closed: no valid pages available')
    }

    try {
      await this.removeHighlights()
      const domService = new DomService(page)
      const content = await domService.getClickableElements(
        this.config.highlightElements,
        focusElement,
        this.config.viewportExpansion,
      )

      const tabsInfo = await this.getTabsInfo()

      // Get all cross-origin iframes within the page and open them in new tabs
      // mark the titles of the new tabs so the LLM knows to check them for additional content
      // unfortunately too buggy for now, too many sites use invisible cross-origin iframes for ads, tracking, youtube videos, social media, etc.
      // and it distracts the bot by opening a lot of new tabs
      // const iframeUrls = await domService.getCrossOriginIframes();
      // for (const url of iframeUrls) {
      //   if (tabsInfo.some(tab => tab.url === url)) {
      //     continue;  // skip if the iframe if we already have it open in a tab
      //   }
      //   const newPageId = tabsInfo[tabsInfo.length - 1].pageId + 1;
      //   this.logger.debug(`Opening cross-origin iframe in new tab #${newPageId}: ${url}`);
      //   await this.createNewTab(url);
      //   tabsInfo.push(
      //     new TabInfo(
      //       newPageId,
      //       url,
      //       `iFrame opened as new tab, treat as if embedded inside page #${this.state.targetId}: ${page.url()}`,
      //       this.state.targetId
      //     )
      //   );
      // }

      const screenshotBase64 = await this.takeScreenshot()
      const [pixelsAbove, pixelsBelow] = await this.getScrollInfo(page)

      // Find the agent's active tab ID
      let agentCurrentPageId = 0
      if (this.agentCurrentPage) {
        for (const tabInfo of tabsInfo) {
          if (tabInfo.url === this.agentCurrentPage.url()) {
            agentCurrentPageId = tabInfo.pageId
            break
          }
        }
      }

      this.currentState = {
        elementTree: content.elementTree,
        selectorMap: content.selectorMap,
        url: page.url(),
        title: await page.title(),
        tabs: tabsInfo,
        screenshot: screenshotBase64,
        pixelsAbove,
        pixelsBelow,
      }

      return this.currentState
    }
    catch (e) {
      logger.error(`❌ Failed to update state: ${e}`)
      // Return last known good state if available
      if (this.currentState) {
        return this.currentState
      }
      throw e
    }
  }

  /**
   * Returns a base64 encoded screenshot of the current page.
   * @param fullPage - Whether to take a screenshot of the full page or just the viewport
   * @returns A base64 encoded string of the screenshot
   */
  @timeExecutionAsync('--take_screenshot')
  async takeScreenshot(fullPage: boolean = false): Promise<string> {
    const page = await this.getAgentCurrentPage()

    // We no longer force tabs to the foreground as it disrupts user focus
    // await page.bringToFront();
    await page.waitForLoadState()

    const screenshot = await page.screenshot({
      fullPage,
      animations: 'disabled',
    })

    // Convert buffer to base64 string
    const screenshotB64 = Buffer.from(screenshot).toString('base64')

    // await this.removeHighlights();

    return screenshotB64
  }

  /**
   * Removes all highlight overlays and labels created by the highlightElement function.
   * Handles cases where the page might be closed or inaccessible.
   */
  @timeExecutionAsync('--remove_highlights')
  async removeHighlights(): Promise<void> {
    try {
      const page = await this.getAgentCurrentPage()
      await page.evaluate(() => {
        try {
        // Remove the highlight container and all its contents
          const container = document.getElementById('playwright-highlight-container')
          if (container) {
            container.remove()
          }

          // Remove highlight attributes from elements
          const highlightedElements = document.querySelectorAll('[browser-user-highlight-id^="playwright-highlight-"]')
          highlightedElements.forEach((el) => {
            el.removeAttribute('browser-user-highlight-id')
          })
        }
        catch (e) {
          console.error('Failed to remove highlights:', e)
        }
      })
    }
    catch (e) {
      logger.debug(`⚠ Failed to remove highlights (this is usually ok): ${e}`)
      // Don't raise the error since this is not critical functionality
    }
  }

  /**
   * Converts simple XPath expressions to CSS selectors.
   * @param xpath - The XPath expression to convert
   * @returns Equivalent CSS selector
   */
  static _convertSimpleXpathToCssSelector(xpath: string): string {
    if (!xpath) {
      return ''
    }

    // Remove leading slash if present
    xpath = xpath.startsWith('/') ? xpath.substring(1) : xpath

    // Split into parts
    const parts = xpath.split('/')
    const cssParts: string[] = []

    for (const part of parts) {
      if (!part) {
        continue
      }

      // Handle custom elements with colons by escaping them
      if (part.includes(':') && !part.includes('[')) {
        const basePart = part.replace(/:/g, '\\:')
        cssParts.push(basePart)
        continue
      }

      // Handle index notation [n]
      if (part.includes('[')) {
        const basePart = part.substring(0, part.indexOf('['))
        // Handle custom elements with colons in the base part
        const basePartEscaped = basePart.includes(':') ? basePart.replace(/:/g, '\\:') : basePart
        const indexPart = part.substring(part.indexOf('['))

        // Handle multiple indices
        const indices = indexPart.split(']')
          .slice(0, -1)
          .map(i => i.trim().replace('[', ''))

        let finalPart = basePartEscaped
        for (const idx of indices) {
          try {
            // Handle numeric indices
            if (/^\d+$/.test(idx)) {
              const index = Number.parseInt(idx) - 1
              finalPart += `:nth-of-type(${index + 1})`
            }
            // Handle last() function
            else if (idx === 'last()') {
              finalPart += ':last-of-type'
            }
            // Handle position() functions
            else if (idx.includes('position()')) {
              if (idx.includes('>1')) {
                finalPart += ':nth-of-type(n+2)'
              }
            }
          }
          catch (e) {
            continue
          }
        }

        cssParts.push(finalPart)
      }
      else {
        cssParts.push(part)
      }
    }

    const baseSelector = cssParts.join(' > ')
    return baseSelector
  }

  /**
   * Creates a CSS selector for a DOM element, handling various edge cases and special characters.
   *
   * @param element - The DOM element to create a selector for
   * @param includeDynamicAttributes - Whether to include dynamic attributes that might change between page loads
   * @returns A valid CSS selector string
   */
  static enhancedCssSelectorForElement(element: DOMElementNode, includeDynamicAttributes: boolean = true): string {
    try {
      // Get base selector from XPath
      let cssSelector = this._convertSimpleXpathToCssSelector(element.xpath)

      // Handle class attributes
      if ('class' in element.attributes && element.attributes.class && includeDynamicAttributes) {
        // Define a regex pattern for valid class names in CSS
        const validClassNamePattern = /^[a-z_][\w-]*$/i

        // Iterate through the class attribute values
        const classes = element.attributes.class.split(/\s+/)
        for (const className of classes) {
          // Skip empty class names
          if (!className.trim()) {
            continue
          }

          // Check if the class name is valid
          if (validClassNamePattern.test(className)) {
            // Append the valid class name to the CSS selector
            cssSelector += `.${className}`
          }
          else {
            // Skip invalid class names
            continue
          }
        }
      }

      // Expanded set of safe attributes that are stable and useful for selection
      const SAFE_ATTRIBUTES = new Set([
        // Data attributes (if they're stable in your application)
        'id',
        // Standard HTML attributes
        'name',
        'type',
        'placeholder',
        // Accessibility attributes
        'aria-label',
        'aria-labelledby',
        'aria-describedby',
        'role',
        // Common form attributes
        'for',
        'autocomplete',
        'required',
        'readonly',
        // Media attributes
        'alt',
        'title',
        'src',
        // Custom stable attributes (add any application-specific ones)
        'href',
        'target',
      ])

      if (includeDynamicAttributes) {
        const dynamicAttributes = new Set([
          'data-id',
          'data-qa',
          'data-cy',
          'data-testid',
        ])

        for (const attr of dynamicAttributes) {
          SAFE_ATTRIBUTES.add(attr)
        }
      }

      // Handle other attributes
      for (const [attribute, value] of Object.entries<string>(element.attributes)) {
        if (attribute === 'class') {
          continue
        }

        // Skip invalid attribute names
        if (!attribute.trim()) {
          continue
        }

        if (!SAFE_ATTRIBUTES.has(attribute)) {
          continue
        }

        // Escape special characters in attribute names
        const safeAttribute = attribute.replace(':', '\\:')

        // Handle different value cases
        if (value === '') {
          cssSelector += `[${safeAttribute}]`
        }
        else if (/["'<>`\n\r\t]/.test(value)) {
          // Use contains for values with special characters
          // For newline-containing text, only use the part before the newline
          let processedValue = value
          if (value.includes('\n')) {
            processedValue = value.split('\n')[0]
          }
          // Regex-substitute *any* whitespace with a single space, then strip.
          const collapsedValue = processedValue.replace(/\s+/g, ' ').trim()
          // Escape embedded double-quotes.
          const safeValue = collapsedValue.replace(/"/g, '\\"')
          cssSelector += `[${safeAttribute}*="${safeValue}"]`
        }
        else {
          cssSelector += `[${safeAttribute}="${value}"]`
        }
      }

      return cssSelector
    }
    catch (e) {
      // Fallback to a more basic selector if something goes wrong
      const tagName = element.tagName || '*'
      return `${tagName}[highlightIndex='${element.highlightIndex}']`
    }
  }

  @timeExecutionAsync('--get_locate_element')
  async getLocateElement(element: DOMElementNode): Promise<ElementHandle | null> {
    let currentFrame: Page | FrameLocator = await this.getAgentCurrentPage()

    // Start with the target element and collect all parents
    const parents: DOMElementNode[] = []
    let current = element
    while (current.parent !== undefined) {
      const parent = current.parent
      parents.push(parent)
      current = parent
    }

    // Reverse the parents list to process from top to bottom
    parents.reverse()

    // Process all iframe parents in sequence
    const iframes = parents.filter(item => item.tagName === 'iframe')
    for (const parent of iframes) {
      const cssSelector = BrowserContext.enhancedCssSelectorForElement(
        parent,
        this.config.includeDynamicAttributes,
      )
      currentFrame = currentFrame.frameLocator(cssSelector)
    }

    const cssSelector = BrowserContext.enhancedCssSelectorForElement(
      element,
      this.config.includeDynamicAttributes,
    )

    try {
      if ('first' in currentFrame) {
        const elementHandle = await currentFrame.locator(cssSelector).elementHandle()
        return elementHandle
      }
      else {
        // Try to scroll into view if hidden
        const elementHandle = await currentFrame.$(cssSelector)
        if (elementHandle) {
          const isHidden = await elementHandle.isHidden()
          if (!isHidden) {
            await elementHandle.scrollIntoViewIfNeeded()
          }
          return elementHandle
        }
        return null
      }
    }
    catch (e) {
      logger.error(`❌ Failed to locate element: ${e}`)
      return null
    }
  }

  @timeExecutionAsync('--get_locate_element_by_xpath')
  async getLocateElementByXpath(xpath: string): Promise<ElementHandle | null> {
    /**
     * Locates an element on the page using the provided XPath.
     */
    const currentFrame = await this.getAgentCurrentPage()

    try {
      // Use XPath to locate the element
      const elementHandle = await currentFrame.$(`xpath=${xpath}`)
      if (elementHandle) {
        const isHidden = await elementHandle.isHidden()
        if (!isHidden) {
          await elementHandle.scrollIntoViewIfNeeded()
        }
        return elementHandle
      }
      return null
    }
    catch (e) {
      logger.error(`❌ Failed to locate element by XPath ${xpath}: ${e}`)
      return null
    }
  }

  @timeExecutionAsync('--get_locate_element_by_css_selector')
  async getLocateElementByCssSelector(cssSelector: string): Promise<ElementHandle | null> {
    /**
     * Locates an element on the page using the provided CSS selector.
     */
    const currentFrame = await this.getAgentCurrentPage()

    try {
      // Use CSS selector to locate the element
      const elementHandle = await currentFrame.$(cssSelector)
      if (elementHandle) {
        const isHidden = await elementHandle.isHidden()
        if (!isHidden) {
          await elementHandle.scrollIntoViewIfNeeded()
        }
        return elementHandle
      }
      return null
    }
    catch (e) {
      logger.error(`❌ Failed to locate element by CSS selector ${cssSelector}: ${e}`)
      return null
    }
  }

  @timeExecutionAsync('--get_locate_element_by_text')
  async getLocateElementByText(
    text: string,
    nth: number | null = 0,
    elementType: string | null = null,
  ): Promise<ElementHandle | null> {
    /**
     * Locates an element on the page using the provided text.
     * If `nth` is provided, it returns the nth matching element (0-based).
     * If `elementType` is provided, filters by tag name (e.g., 'button', 'span').
     */
    const currentFrame = await this.getAgentCurrentPage()
    try {
      // handle also specific element type or use any type.
      const selector = `${elementType || '*'}:text("${text}")`
      const elements = await currentFrame.$$(selector)

      if (!elements) {
        return null
      }

      // considering only visible elements
      const visibleElements = []
      for (const el of elements) {
        if (await el.isVisible()) {
          visibleElements.push(el)
        }
      }

      if (visibleElements.length === 0) {
        logger.error(`No visible element with text '${text}' found.`)
        return null
      }

      let elementHandle
      if (nth !== null) {
        if (nth >= 0 && nth < visibleElements.length) {
          elementHandle = visibleElements[nth]
        }
        else {
          logger.error(`Visible element with text '${text}' not found at index ${nth}.`)
          return null
        }
      }
      else {
        elementHandle = visibleElements[0]
      }

      const isHidden = await elementHandle.isHidden()
      if (!isHidden) {
        await elementHandle.scrollIntoViewIfNeeded()
      }
      return elementHandle
    }
    catch (e) {
      logger.error(`❌ Failed to locate element by text '${text}': ${e}`)
      return null
    }
  }

  @timeExecutionAsync('--input_text_element_node')
  async _inputTextElementNode(elementNode: DOMElementNode, text: string): Promise<void> {
    /**
     * Input text into an element with proper error handling and state management.
     * Handles different types of input fields and ensures proper element state before input.
     */
    try {
      // Highlight before typing
      // if (elementNode.highlightIndex !== undefined) {
      //   await this._updateState(focusElement: elementNode.highlightIndex);
      // }

      const elementHandle = await this.getLocateElement(elementNode)

      if (elementHandle === null) {
        throw new BrowserError(`Element: ${elementNode} not found`)
      }

      // Ensure element is ready for input
      try {
        await elementHandle.waitForElementState('stable', { timeout: 1000 })
        const isHidden = await elementHandle.isHidden()
        if (!isHidden) {
          await elementHandle.scrollIntoViewIfNeeded({ timeout: 1000 })
        }
      }
      catch (e) {
        // Continue even if this fails
      }

      // Get element properties to determine input method
      const tagHandle = await elementHandle.getProperty('tagName')
      const tagName = (await tagHandle.jsonValue() as string).toLowerCase()
      const isContentEditable = await elementHandle.getProperty('isContentEditable')
      const readonlyHandle = await elementHandle.getProperty('readOnly')
      const disabledHandle = await elementHandle.getProperty('disabled')

      const readonly = readonlyHandle ? await readonlyHandle.jsonValue() : false
      const disabled = disabledHandle ? await disabledHandle.jsonValue() : false

      if ((await isContentEditable.jsonValue() || tagName === 'input') && !(readonly || disabled)) {
        await elementHandle.evaluate((el) => {
          el.textContent = ''
          // @ts-expect-error
          el.value = ''
        })
        await elementHandle.type(text, { delay: 5 })
      }
      else {
        await elementHandle.fill(text)
      }
    }
    catch (e) {
      logger.debug(`❌ Failed to input text into element: ${elementNode}. Error: ${e}`)
      throw new BrowserError(`Failed to input text into index ${elementNode.highlightIndex}`)
    }
  }

  @timeExecutionAsync('--click_element_node')
  async clickElementNode(elementNode: DOMElementNode): Promise<string | null> {
    /**
     * Optimized method to click an element using xpath.
     */
    const page = await this.getAgentCurrentPage()

    try {
      // Highlight before clicking
      // if (elementNode.highlightIndex !== undefined) {
      //   await this._updateState(focusElement: elementNode.highlightIndex);
      // }

      const elementHandle = await this.getLocateElement(elementNode)

      if (elementHandle === null) {
        throw new Error(`Element: ${elementNode} not found`)
      }

      const performClick = async (clickFunc: () => Promise<void>): Promise<string | null> => {
        /** Performs the actual click, handling both download and navigation scenarios. */
        if (this.config.saveDownloadsPath) {
          try {
            // Try short-timeout expect_download to detect a file download has been been triggered
            const downloadPromise = page.waitForEvent('download', { timeout: 5000 })
            await clickFunc()
            const download = await downloadPromise

            // Determine file path
            const suggestedFilename = download.suggestedFilename()
            const uniqueFilename = await this.getUniqueFilename(this.config.saveDownloadsPath, suggestedFilename)
            const downloadPath = path.join(this.config.saveDownloadsPath, uniqueFilename)

            await download.saveAs(downloadPath)
            logger.debug(`⬇️ Download triggered. Saved file to: ${downloadPath}`)
            return downloadPath
          }
          catch (e) {
            // If no download is triggered, treat as normal click
            logger.debug('No download triggered within timeout. Checking navigation...')
            await page.waitForLoadState()
            await this.checkAndHandleNavigation(page)
            return null
          }
        }
        else {
          // Standard click logic if no download is expected
          await clickFunc()
          await page.waitForLoadState()
          await this.checkAndHandleNavigation(page)
          return null
        }
      }

      try {
        return await performClick(() => elementHandle.click({ timeout: 1500 }))
      }
      catch (e) {
        if (e instanceof URLNotAllowedError) {
          throw e
        }
        try {
          return performClick(() => page.evaluate((el) => {
            // @ts-expect-error
            el.click()
          }, elementHandle))
        }
        catch (e) {
          if (e instanceof URLNotAllowedError) {
            throw e
          }
          throw new Error(`Failed to click element: ${e}`)
        }
      }
    }
    catch (e) {
      if (e instanceof URLNotAllowedError) {
        throw e
      }
      throw new Error(`Failed to click element: ${elementNode}. Error: ${e}`)
    }
  }

  @timeExecutionAsync('--get_tabs_info')
  async getTabsInfo(): Promise<TabInfo[]> {
    /** Get information about all tabs */
    const session = await this.getSession()

    const tabsInfo: TabInfo[] = []
    for (let pageId = 0; pageId < session.context.pages().length; pageId++) {
      const page = session.context.pages()[pageId]
      try {
        // Use a Promise with timeout to avoid hanging
        const titlePromise = new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Title fetch timeout'))
          }, 1000)

          page.title().then((title) => {
            clearTimeout(timeout)
            resolve(title)
          }).catch((err) => {
            clearTimeout(timeout)
            reject(err)
          })
        })

        const title = await titlePromise
        const tabInfo = new TabInfo({
          pageId,
          url: page.url(),
          title,
        })
        tabsInfo.push(tabInfo)
      }
      catch (e) {
        // page.title() can hang forever on tabs that are crashed/disappeared/about:blank
        // we dont want to try automating those tabs because they will hang the whole script
        logger.debug(`⚠ Failed to get tab info for tab #${pageId}: ${page.url()} (ignoring)`)
        const tabInfo = new TabInfo({
          pageId,
          url: 'about:blank',
          title: 'ignore this tab and do not use it',
        })
        tabsInfo.push(tabInfo)
      }
    }

    return tabsInfo
  }

  @timeExecutionAsync('--switch_to_tab')
  async switchToTab(pageId: number): Promise<void> {
    /** Switch to a specific tab by its page_id */
    const session = await this.getSession()
    const pages = session.context.pages()

    if (pageId >= pages.length) {
      throw new BrowserError(`No tab found with page_id: ${pageId}`)
    }

    const page = pages[pageId]

    // Check if the tab's URL is allowed before switching
    if (!this.isUrlAllowed(page.url())) {
      throw new BrowserError(`Cannot switch to tab with non-allowed URL: ${page.url()}`)
    }

    // Update target ID if using CDP
    if (this.browser.config.cdpUrl) {
      const targets = await this.getCdpTargets()
      for (const target of targets) {
        if (target.url === page.url()) {
          this.state.targetId = target.targetId
          break
        }
      }
    }

    // Update both tab references - agent wants this tab, and it's now in the foreground
    this.agentCurrentPage = page
    this.humanCurrentPage = page

    // Bring tab to front and wait for it to load
    await page.bringToFront()
    await page.waitForLoadState()

    // Set the viewport size for the tab
    await this.setViewportSize(page)
  }

  @timeExecutionAsync('--create_new_tab')
  async createNewTab(url?: string): Promise<void> {
    /** Create a new tab and optionally navigate to a URL */
    if (url && !this.isUrlAllowed(url)) {
      throw new BrowserError(`Cannot create new tab with non-allowed URL: ${url}`)
    }

    const session = await this.getSession()
    const newPage = await session.context.newPage()

    // Update both tab references - agent wants this tab, and it's now in the foreground
    this.agentCurrentPage = newPage
    this.humanCurrentPage = newPage

    await newPage.waitForLoadState()

    // Set the viewport size for the new tab
    await this.setViewportSize(newPage)

    if (url) {
      await newPage.goto(url)
      await this.waitForPageAndFramesLoad(1)
    }

    // Get target ID for new page if using CDP
    if (this.browser.config.cdpUrl) {
      const targets = await this.getCdpTargets()
      for (const target of targets) {
        if (target.url === newPage.url()) {
          this.state.targetId = target.targetId
          break
        }
      }
    }
  }

  /**
   * Helper methods for easier access to the DOM
   */

  /**
   * Get the selector map from the cached state
   * @returns The current selector map or an empty object if no cached state exists
   */
  async getSelectorMap(): Promise<SelectorMap> {
    const session = await this.getSession()
    if (!session.cachedState) {
      return {}
    }
    return session.cachedState.selectorMap
  }

  /**
   * Get an element handle by its index in the selector map
   * @param index - The index of the element in the selector map
   * @returns The element handle or null if not found
   */
  async getElementsByIndex(index: number): Promise<ElementHandle | null> {
    const selectorMap = await this.getSelectorMap()
    if (!selectorMap[index]) {
      return null
    }
    const elementHandle = await this.getLocateElement(selectorMap[index]!)
    return elementHandle
  }

  /**
   * Get a DOM element node by its index in the selector map
   * @param index - The index of the element in the selector map
   * @returns The DOM element node
   */
  async getDomElementByIndex(index: number): Promise<DOMElementNode> {
    const selectorMap = await this.getSelectorMap()
    return selectorMap[index]!
  }

  /**
   * Save current browser cookies to file
   */
  async saveCookies(): Promise<void> {
    if (this.session && this.session.context && this.config.cookiesFile) {
      try {
        const cookies = await this.session.context.cookies()
        logger.debug(`🍪 Saving ${cookies.length} cookies to ${this.config.cookiesFile}`)

        // Check if the path is a directory and create it if necessary
        const dirname = path.dirname(this.config.cookiesFile)
        if (dirname) {
          fs.mkdirSync(dirname, { recursive: true })
        }

        await fs.promises.writeFile(
          this.config.cookiesFile,
          JSON.stringify(cookies),
        )
      }
      catch (e) {
        logger.warn(`❌ Failed to save cookies: ${e}`)
      }
    }
  }

  /**
   * Check if element or its children are file uploaders
   * @param elementNode - The DOM element to check
   * @param maxDepth - Maximum recursion depth
   * @param currentDepth - Current recursion depth
   * @returns Boolean indicating if the element is a file uploader
   */
  async isFileUploader(
    elementNode: DOMElementNode,
    maxDepth: number = 3,
    currentDepth: number = 0,
  ): Promise<boolean> {
    if (currentDepth > maxDepth) {
      return false
    }

    // Check current element
    let isUploader = false

    if (!(elementNode instanceof DOMElementNode)) {
      return false
    }

    // Check for file input attributes
    if (elementNode.tagName === 'input') {
      isUploader
        = elementNode.attributes.type === 'file'
          || elementNode.attributes.accept !== undefined
    }

    if (isUploader) {
      return true
    }

    // Recursively check children
    if (elementNode.children && currentDepth < maxDepth) {
      for (const child of elementNode.children) {
        if (child instanceof DOMElementNode) {
          if (await this.isFileUploader(child, maxDepth, currentDepth + 1)) {
            return true
          }
        }
      }
    }

    return false
  }

  /**
   * Get scroll position information for the current page
   * @param page - The page to get scroll info from
   * @returns Tuple containing pixels above and below the viewport
   */
  async getScrollInfo(page: Page): Promise<[number, number]> {
    const scrollY = await page.evaluate(() => {
      return window.scrollY
    })
    const viewportHeight = await page.evaluate(() => {
      return window.innerHeight
    })
    const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight)

    const pixelsAbove = scrollY
    const pixelsBelow = totalHeight - (scrollY + viewportHeight)

    return [pixelsAbove, pixelsBelow]
  }

  /**
   * Reset the browser session
   * Call this when you don't want to kill the context but just kill the state
   */
  async resetContext(): Promise<void> {
    // close all tabs and clear cached state
    const session = await this.getSession()

    const pages = session.context.pages()
    for (const page of pages) {
      await page.close()
    }

    session.cachedState = undefined
    this.state.targetId = undefined
  }

  /**
   * Generate a unique filename by appending (1), (2), etc., if a file already exists.
   * @param directory - Directory where the file will be saved
   * @param filename - Original filename
   * @returns Unique filename that doesn't exist in the directory
   */
  private async getUniqueFilename(directory: string, filename: string): Promise<string> {
    const [base, ext] = [
      path.basename(filename, path.extname(filename)),
      path.extname(filename),
    ]

    let counter = 1
    let newFilename = filename

    while (fs.existsSync(path.join(directory, newFilename))) {
      newFilename = `${base} (${counter})${ext}`
      counter++
    }

    return newFilename
  }

  /**
   * Central method to set viewport size for a page.
   * Simple for now, but we may need to add more logic here in the future to rezise surrounding window, change recording options, etc.
   * @param page
   */
  async setViewportSize(page: Page) {
    try {
      // Only set viewport size if no_viewport is False (aka viewport=True)
      if (this.config.noViewport) {
        const viewportSize = {
          width: this.config.windowWidth,
          height: this.config.windowHeight,
        }
        await page.setViewportSize(viewportSize)
        logger.debug(`Set viewport size to ${this.config.windowWidth}x${this.config.windowHeight}`)
      }
    }
    catch (e) {
      logger.error(`Failed to set viewport size for page: ${e}`)
    }
  }

  /**
   * Get all CDP targets directly using CDP protocol
   */
  private async getCdpTargets() {
    if (!this.browser.config.cdpUrl && !this.session) {
      return []
    }
    try {
      const pages = this.session?.context.pages()
      if (!pages) {
        return []
      }

      const cdpSession = await pages[0].context().newCDPSession(pages[0])
      const result = await cdpSession.send('Target.getTargets')
      await cdpSession.detach()
      return result.targetInfos
    }
    catch (e) {
      logger.debug('Failed to get CDP targets: ', e)
      return []
    }
  }

  /**
   * Resize the browser window to match the configured size
   * @param context - Playwright browser context
   */
  private async resizeWindow(context: PlaywrightBrowserContext): Promise<void> {
    try {
      if (!context.pages().length) {
        return
      }

      const page = context.pages()[0]
      const windowSize = { width: this.config.windowWidth, height: this.config.windowHeight }

      // First, set the viewport size
      await this.setViewportSize(page)

      // Then, try to set the actual window size using CDP
      try {
        const cdpSession = await context.newCDPSession(page)

        // Get the window ID
        const windowIdResult = await cdpSession.send('Browser.getWindowForTarget')

        // Set the window bounds
        await cdpSession.send(
          'Browser.setWindowBounds',
          {
            windowId: windowIdResult.windowId,
            bounds: {
              width: windowSize.width,
              height: windowSize.height + BROWSER_NAVBAR_HEIGHT, // Add height for browser chrome
              windowState: 'normal', // Ensure window is not minimized/maximized
            },
          },
        )

        await cdpSession.detach()
        logger.debug(`Set window size to ${windowSize.width}x${windowSize.height + BROWSER_NAVBAR_HEIGHT}`)
      }
      catch (e) {
        logger.debug(`CDP window resize failed: ${e}`)

        // Fallback to using JavaScript
        try {
          await page.evaluate(
            `
          ({width, height}) => {
            window.resizeTo(width, height);
          }
          `,
            {
              width: windowSize.width,
              height: windowSize.height + BROWSER_NAVBAR_HEIGHT, // Add height for browser chrome
            },
          )
          logger.debug(
            `Used JavaScript to set window size to ${windowSize.width}x${windowSize.height + BROWSER_NAVBAR_HEIGHT}`,
          )
        }
        catch (e) {
          logger.debug(`JavaScript window resize failed: ${e}`)
        }
      }

      logger.debug(`Attempted to resize window to ${windowSize.width}x${windowSize.height}`)
    }
    catch (e) {
      logger.debug(`Failed to resize browser window: ${e}`)
      // Non-critical error, continue execution
    }
  }

  /**
   * Waits for an element matching the given CSS selector to become visible.
   *
   * @param selector - The CSS selector of the element.
   * @param timeout - The maximum time to wait for the element to be visible (in milliseconds).
   * @throws TimeoutError - If the element does not become visible within the specified timeout.
   */
  async waitForElement(selector: string, timeout: number): Promise<void> {
    const page = await this.getAgentCurrentPage()
    await page.waitForSelector(selector, { state: 'visible', timeout })
  }
}
