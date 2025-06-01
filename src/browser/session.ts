import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Browser, BrowserContext, BrowserContextOptions, chromium, ElementHandle, FrameLocator, Page, Request, Response } from 'playwright'

import { Logger } from '@/logger'
import { AnyFunction } from '@/type'
import { ClickableElementProcessor } from '../dom/clickable_element_processor/service'
import { DomService } from '../dom/service'
import { DOMElementNode, SelectorMap } from '../dom/views'
import { matchUrlWithDomainPattern, sleep, timeExecutionAsync, timeExecutionSync } from '../utils'
import { BrowserProfile } from './profile'
import {
  BrowserError,
  BrowserStateSummary,
  TabInfo,
  URLNotAllowedError,
} from './views'

// https://github.com/microsoft/playwright/issues/35972
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1'

const logger = Logger.getLogger(import.meta.filename)

// Check if running in Docker
const IN_DOCKER = 'ty1'.includes((process.env.IN_DOCKER || 'false').toLowerCase()[0])

let GLOB_WARNING_SHOWN = false // used inside _isUrlAllowed to avoid spamming the logs with the same warning multiple times

function logGlobWarning(domain: string, glob: string): void {
  if (!GLOB_WARNING_SHOWN) {
    logger.warn(
      // glob patterns are very easy to mess up and match too many domains by accident
      // e.g. if you only need to access gmail, don't use *.google.com because an attacker could convince the agent to visit a malicious doc
      // on docs.google.com/s/some/evil/doc to set up a prompt injection attack
      `⚠️ Allowing agent to visit ${domain} based on allowed_domains=['${glob}', ...]. Set allowed_domains=['${domain}', ...] explicitly to avoid matching too many domains!`,
    )
    GLOB_WARNING_SHOWN = true
  }
}

export {
  BrowserProfile,
}

/**
 * Truncate/pretty-print a URL with a maximum length, removing the protocol and www. prefix
 */
function logPrettyUrl(s: string, maxLen: number = 22): string {
  s = s.replace('https://', '').replace('http://', '').replace('www.', '')
  if (s.length > maxLen) {
    return `${s.slice(0, maxLen)}…`
  }
  return s
}

/**
 * Pretty-print a path, shorten home dir to ~ and cwd to .
 */
function logPrettyPath(pathStr: string): string {
  return (pathStr || '').replace(os.homedir(), '~').replace(process.cwd(), '.')
}

/** decorator for BrowserSession methods to require the BrowserSession be already active */
function requireInitialization<T extends AnyFunction>(
  originalMethod: T,
  context: ClassMethodDecoratorContext,
): T {
  return async function (this: BrowserSession, ...args: Parameters<T>): Promise<ReturnType<T>> {
    try {
      if (!this.initialized) {
        // raise RuntimeError('BrowserSession(...).start() must be called first to launch or connect to the browser')
        await this.start() // just start it automatically if not already started
      }

      if (!this.agentCurrentPage || this.agentCurrentPage.isClosed()) {
        this.agentCurrentPage = (
          this.browserContext && this.browserContext.pages().length > 0
            ? this.browserContext.pages()[0]
            : undefined
        )
      }

      if (!this.agentCurrentPage || this.agentCurrentPage.isClosed()) {
        await this.createNewTab()
      }

      if (!this.agentCurrentPage || this.agentCurrentPage.isClosed()) {
        throw new Error('Failed to get or create a valid page')
      }

      // if (!this.cachedBrowserStateSummary) {
      //   throw new Error('BrowserSession(...).start() must be called first to initialize the browser session')
      // }

      return await originalMethod.apply(this, args)
    } catch (e: any) {
      // Check if this is a TargetClosedError or similar connection error
      if (e.message.includes('TargetClosedError') || e.message.includes('context or browser has been closed')) {
        logger.debug(`Detected closed browser connection in ${context.name.toString()}, resetting connection state`)
        this.resetConnectionState()
        // Re-raise the error so the caller can handle it appropriately
        throw e
      } else {
        // Re-raise other exceptions unchanged
        throw e
      }
    }
  } as T
}

export const DEFAULT_BROWSER_PROFILE = new BrowserProfile()

/**
 * Clickable elements hashes for the last state
 */
interface CachedClickableElementHashes {
  url: string
  hashes: Set<string>
}

/**
 * Represents an active browser session with a running browser process somewhere.
 *
 * Chromium flags should be passed via extra_launch_args.
 * Extra Playwright launch options (e.g., handle_sigterm, handle_sigint) can be passed as kwargs to BrowserSession and will be forwarded to the launch() call.
 */
export class BrowserSession {
  // template profile for the BrowserSession, will be copied at init/validation time, and overrides applied to the copy
  /** BrowserProfile() instance containing config for the BrowserSession */
  browserProfile: BrowserProfile = DEFAULT_BROWSER_PROFILE

  // runtime props/state: these can be passed in as props at init, or get auto-setup by BrowserSession.start()
  /** WSS URL of the node.js playwright browser server to connect to, outputted by (await chromium.launchServer()).wsEndpoint() */
  wssUrl?: string
  /** CDP URL of the browser to connect to, e.g. http://localhost:9222 or ws://127.0.0.1:9222/devtools/browser/387adf4c-243f-4051-a181-46798f4a46f4 */
  cdpUrl?: string
  /** pid of a running chromium-based browser process to connect to on localhost */
  browserPid?: number
  /** Playwright library object returned by: await (playwright or patchright).async_playwright().start() */
  playwright?: Browser
  /** playwright Browser object to use (optional) */
  browser?: Browser
  /** playwright BrowserContext object to use (optional) */
  browserContext?: BrowserContext

  // runtime state: state that changes during the lifecycle of a BrowserSession(), updated by the methods below
  /** Mark BrowserSession launch/connection as already ready and skip setup (not recommended) */
  initialized: boolean = false
  /** Foreground Page that the agent is focused on */
  agentCurrentPage?: Page // mutated by this.createNewTab(url)
  /** Foreground Page that the human is focused on */
  humanCurrentPage?: Page // mutated by this._setupCurrentPageChangeListeners()

  cachedBrowserStateSummary?: BrowserStateSummary

  browserStateSummary?: BrowserStateSummary
  private cachedClickableElementHashes?: CachedClickableElementHashes
  private _startLock = new Map() // Simple lock implementation
  private startPromise?: Promise<void>

  constructor(options: Partial<BrowserSession> = {}) {
    Object.assign(this, options)
    this.applySessionOverridesToProfile()
  }

  /** Apply any extra **kwargs passed to BrowserSession(...) as config overrides on top of browser_profile */
  private applySessionOverridesToProfile(): void {
    // In TypeScript, this would be handled differently since we don't have dynamic model fields
    // For now, we'll assume the profile is properly configured

    // Only create a copy if there are actual overrides to apply
    // This would need to be implemented based on specific requirements
  }

  getSession() {
    return this
  }

  /**
   * Starts the browser session by either connecting to an existing browser or launching a new one.
   * Precedence order for launching/connecting:
   *  1. page=Page playwright object, will use its page.context as browser_context
   *  2. browser_context=PlaywrightBrowserContext object, will use its browser
   *  3. browser=PlaywrightBrowser object, will use its first available context
   *  4. browser_pid=int, will connect to a local chromium-based browser via pid
   *  5. wss_url=str, will connect to a remote playwright browser server via WSS
   *  6. cdp_url=str, will connect to a remote chromium-based browser via CDP
   *  7. playwright=Playwright object, will use its chromium instance to launch a new browser
   */
  async start(): Promise<BrowserSession> {
    // Simple lock implementation
    if (this.startPromise) {
      await this.startPromise
      return this
    }

    // eslint-disable-next-line no-async-promise-executor
    this.startPromise = new Promise<void>(async (resolve, reject) => {
      try {
        // if we're already initialized and the connection is still valid, return the existing session state and start from scratch
        if (this.initialized && this.isConnected()) {
          resolve()
          return
        }
        this.resetConnectionState()

        this.initialized = true // set this first to ensure two parallel calls to start() don't clash with each other

        // apply last-minute runtime-computed options to the the browser_profile, validate profile, set up folders on disk
        this.browserProfile.prepareUserDataDir() // create/unlock the <user_data_dir>/SingletonLock
        this.browserProfile.detectDisplayConfiguration() // adjusts config values, must come before launch/connect

        // launch/connect to the browser:

        await this.setupBrowserViaPassedObjects()
        await this.setupBrowserViaBrowserPid()
        await this.setupBrowserViaWssUrl()
        await this.setupBrowserViaCdpUrl()
        await this.setupNewBrowserContext() // creates a new context in existing browser or launches a new persistent context

        if (!this.browserContext) {
          throw new Error(`Failed to connect to or create a new BrowserContext for browser=${this.browser}`)
        }

        // resize the existing pages and set up foreground tab detection
        await this.setupViewports()
        await this.setupCurrentPageChangeListeners()

        resolve()
      } catch (error) {
        this.initialized = false
        reject(error)
      }
    })

    await this.startPromise

    return this
  }

  /** Shuts down the BrowserSession, killing the browser process if keep_alive=False */
  async stop(): Promise<void> {
    this.initialized = false

    if (this.browserProfile.keepAlive) {
      return // nothing to do if keep_alive=True, leave the browser running
    }

    if (this.browserContext || this.browser) {
      try {
        await (this.browserContext || this.browser)?.close()
        logger.info(
          `🛑 Stopped the ${this.browserProfile.channel.toLowerCase()} browser `
          + `keep_alive=false user_data_dir=${logPrettyPath(this.browserProfile.userDataDir || '') || '<incognito>'} cdp_url=${this.cdpUrl || this.wssUrl} pid=${this.browserPid}`,
        )
        this.browserContext = undefined
      } catch (e: any) {
        logger.debug(`❌ Error closing playwright BrowserContext ${this.browserContext}: ${e.constructor.name}: ${e.message}`)
      }
    }

    // kill the chrome subprocess if we were the ones that started it
    if (this.browserPid) {
      try {
        process.kill(this.browserPid, 'SIGTERM')
        logger.info(`↳ Killed browser subprocess with browser_pid=${this.browserPid} keep_alive=false`)
        this.browserPid = undefined
      } catch (e: any) {
        if (!e.message.includes('ESRCH')) { // No such process
          logger.debug(`❌ Error terminating subprocess with browser_pid=${this.browserPid}: ${e.constructor.name}: ${e.message}`)
        }
      }
    }
  }

  /** Deprecated: Provides backwards-compatibility with old class method Browser().close() */
  async close(): Promise<void> {
    await this.stop()
  }

  /** Deprecated: Provides backwards-compatibility with old class method Browser().new_context() */
  async newContext(): Promise<BrowserSession> {
    return this
  }

  /**
   * Override to customize the set up of the connection to an existing browser
   */
  async setupBrowserViaPassedObjects(): Promise<void> {
    // 1. check for a passed Page object, if present, it always takes priority, set browser_context = page.context
    this.browserContext = (this.agentCurrentPage && this.agentCurrentPage.context()) || this.browserContext || undefined

    // 2. Check if the current browser connection is valid, if not clear the invalid objects
    if (this.browserContext) {
      try {
        // Try to access a property that would fail if the context is closed
        this.browserContext.pages()
        // Additional check: verify the browser is still connected
        if (this.browserContext.browser() && !this.browserContext.browser()?.isConnected()) {
          this.browserContext = undefined
        }
      } catch {
        // Context is closed, clear it
        this.browserContext = undefined
      }
    }

    // 3. if we have a browser object but it's disconnected, clear it and the context because we cant use either
    if (this.browser && !this.browser.isConnected()) {
      if (this.browserContext && (this.browserContext.browser() === this.browser)) {
        this.browserContext = undefined
      }
      this.browser = undefined
    }

    // 4. if we have a context now, it always takes precedence, set browser = context.browser, otherwise use the passed browser
    const browserFromContext = this.browserContext && this.browserContext.browser()
    if (browserFromContext && browserFromContext.isConnected()) {
      this.browser = browserFromContext
    }

    if (this.browser || this.browserContext) {
      logger.info(`🌎 Connected to existing user-provided browser_context: ${this.browserContext}`)
      this.setBrowserKeepAlive(true) // we connected to an existing browser, dont kill it at the end
    }
  }

  /** if browser_pid is provided, calcuclate its CDP URL by looking for --remote-debugging-port=... in its CLI args, then connect to it */
  async setupBrowserViaBrowserPid(): Promise<void> {
    if (this.browser || this.browserContext) {
      return // already connected to a browser
    }
    if (!this.browserPid) {
      // no browser_pid provided, nothing to do
    }

    // TODO: Implement this in TypeScript
    // Note: In Node.js, we'd need to use process management libraries to get process info
    // This is a simplified implementation
  }

  /** check for a passed wss_url, connect to a remote playwright browser server via WSS */
  async setupBrowserViaWssUrl(): Promise<void> {
    if (this.browser || this.browserContext) {
      return // already connected to a browser
    }
    if (!this.wssUrl) {
      return // no wss_url provided, nothing to do
    }

    logger.info(`🌎 Connecting to existing remote chromium playwright node.js server over WSS: ${this.wssUrl}`)
    this.browser = this.browser || await chromium.connect(this.wssUrl, this.browserProfile.kwargsForConnect())
    this.setBrowserKeepAlive(true) // we connected to an existing browser, dont kill it at the end
  }

  /** check for a passed cdp_url, connect to a remote chromium-based browser via CDP */
  async setupBrowserViaCdpUrl(): Promise<void> {
    if (this.browser || this.browserContext) {
      return // already connected to a browser
    }
    if (!this.cdpUrl) {
      return // no cdp_url provided, nothing to do
    }

    logger.info(`🌎 Connecting to existing remote chromium-based browser over CDP: ${this.cdpUrl}`)
    this.browser = this.browser || await chromium.connectOverCDP(this.cdpUrl, this.browserProfile.kwargsForConnect())
    this.setBrowserKeepAlive(true) // we connected to an existing browser, dont kill it at the end
  }

  /** Launch a new browser and browser_context */
  async setupNewBrowserContext(): Promise<void> {
    // if we have a browser object but no browser_context, use the first context discovered or make a new one
    if (this.browser && !this.browserContext) {
      const contexts = this.browser.contexts()
      if (contexts.length > 0) {
        this.browserContext = contexts[0]
        logger.info(`🌎 Using first browser_context available in existing browser: ${this.browserContext}`)
      } else {
        this.browserContext = await this.browser.newContext(this.browserProfile.kwargsForNewContext())
        const storageInfo = this.browserProfile.storageState
          ? ` + loaded storage_state=${Object.keys(this.browserProfile.storageState).length} cookies`
          : ''
        logger.info(`🌎 Created new empty browser_context in existing browser${storageInfo}: ${this.browserContext}`)
      }
    }

    // if we still have no browser_context by now, launch a new local one using launch_persistent_context()
    if (!this.browserContext) {
      logger.info(
        `🌎 Launching local browser `
        + `driver=${this.playwright?.constructor.name || 'playwright'} channel=${this.browserProfile.channel.toLowerCase()} `
        + `user_data_dir=${logPrettyPath(this.browserProfile.userDataDir || '') || '<incognito>'}`,
      )

      if (!this.browserProfile.userDataDir) {
        // if no user_data_dir is provided, launch an incognito context with no persistent user_data_dir
        this.browser = this.browser || await chromium.launch(this.browserProfile.kwargsForLaunch())
        this.browserContext = await this.browser.newContext()
      } else {
        // user data dir was provided, prepare it for use
        this.browserProfile.prepareUserDataDir()

        // if a user_data_dir is provided, launch a persistent context with that user_data_dir
        this.browserContext = await chromium.launchPersistentContext(
          this.browserProfile.userDataDir,
          this.browserProfile.kwargsForLaunchPersistentContext(),
        )
      }
    }

    // Only restore browser from context if it's connected, otherwise keep it None to force new launch
    const browserFromContext = this.browserContext && this.browserContext.browser()
    if (browserFromContext && browserFromContext.isConnected()) {
      this.browser = browserFromContext
    }
    // ^ self.browser can unfortunately still be None at the end ^
    // playwright does not give us a browser object at all when we use launch_persistent_context()!

    // Detect any new child chrome processes that we might have launched above
    // try {
    //     const currentProcess = process.pid;
    //     const childPidsAfterLaunch = new Set((await fs.readdir('/proc')).filter((file) => {
    //         try {
    //             return parseInt(file) > 0;
    //         } catch {
    //             return false;
    //         }
    //     }).map((pid) => parseInt(pid)));
    //     const newChildPids = Array.from(childPidsAfterLaunch).filter(pid => !this._startLock.has(pid.toString()));
    //     const newChildProcs = newChildPids.map(pid => process.kill(pid, 0));
    //     const newChromeProcs = newChildProcs.filter(proc => proc && proc.status === 'running');

    //     if (newChromeProcs.length > 0 && !this.browserPid) {
    //         this.browserPid = newChromeProcs[0].pid;
    //         logger.debug(
    //             ` ↳ Spawned browser subprocess: browser_pid=${this.browserPid} ${newChromeProcs[0].cmdline().join(' ')}`
    //         );
    //         this._setBrowserKeepAlive(false); // close the browser at the end because we launched it
    //     }
    // } catch (e) {
    //     logger.debug(`❌ Error trying to find child chrome processes after launching new browser: ${e.constructor.name}: ${e.message}`);
    // }

    if (this.browser) {
      const connectionMethod = this.wssUrl ? 'WSS' : (this.cdpUrl && !this.browserPid) ? 'CDP' : 'Local'
      if (!this.browser.isConnected()) {
        throw new Error(
          `Browser is not connected, did the browser process crash or get killed? (connection method: ${connectionMethod})`,
        )
      }
      logger.debug(
        `🌎 ${connectionMethod} browser connected: v${this.browser.version()} ${this.cdpUrl || this.wssUrl || this.browserProfile.executablePath || '(playwright)'}`,
      )
    }

    if (!this.browserContext) {
      throw new Error(`Failed to create a playwright BrowserContext ${this.browserContext} for browser=${this.browser}`)
    }

    // Expose anti-detection scripts
    await this.browserContext.addInitScript(() => {
      // check to make sure we're not inside the PDF viewer
      window.isPdfViewer = !!document?.body?.querySelector('body > embed[type="application/pdf"][width="100%"]')
      if (!window.isPdfViewer) {
        // Permissions
        const originalQuery = window.navigator.permissions.query
        window.navigator.permissions.query = parameters => (
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : originalQuery(parameters)
        );
        (() => {
          if (window._eventListenerTrackerInitialized)
            return
          window._eventListenerTrackerInitialized = true

          const originalAddEventListener = EventTarget.prototype.addEventListener
          const eventListenersMap = new WeakMap<EventTarget, Array<{ type: string, listener: AnyFunction, listenerPreview: string, options: AddEventListenerOptions | boolean | undefined }>>()

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

          window.getEventListenersForNode = (node) => {
            const listeners = eventListenersMap.get(node) || []
            return listeners.map(({ type, listenerPreview, options }) => ({
              type,
              listenerPreview,
              options,
            }))
          }
        })()
      }
    })

    // Load cookies from file if specified
    await this.loadCookiesFromFile()
  }

  // Uses a combination of:
  // - visibilitychange events
  // - window focus/blur events
  // - pointermove events

  // This annoying multi-method approach is needed for more reliable detection across browsers because playwright provides no API for this.

  // TODO: pester the playwright team to add a new event that fires when a headful tab is focused.
  // OR implement a browser-use chrome extension that acts as a bridge to the chrome.tabs API.

  //         - https://github.com/microsoft/playwright/issues/1290
  //         - https://github.com/microsoft/playwright/issues/2286
  //         - https://github.com/microsoft/playwright/issues/3570
  //         - https://github.com/microsoft/playwright/issues/13989

  // set up / detect foreground page
  async setupCurrentPageChangeListeners(): Promise<void> {
    if (!this.browserContext) {
      throw new Error('BrowserContext object is not set')
    }

    const pages = this.browserContext.pages()
    let foregroundPage: Page | null = null

    if (pages.length > 0) {
      foregroundPage = pages[0]
      logger.debug(
        `📜 Found ${pages.length} existing tabs in browser, agent will start focused on Tab [${pages.indexOf(foregroundPage)}]: ${foregroundPage.url()}`,
      )
    } else {
      foregroundPage = await this.browserContext.newPage()
      logger.debug('➕ Opened new tab in empty browser context...')
    }

    this.agentCurrentPage = this.agentCurrentPage || foregroundPage
    this.humanCurrentPage = this.humanCurrentPage || foregroundPage

    const BrowserUseonTabVisibilityChange = (source: { page: Page }) => {
      /** hook callback fired when init script injected into a page detects a focus event */
      const newPage = source.page

      // Update human foreground tab state
      const oldForeground = this.humanCurrentPage
      if (!this.browserContext || !oldForeground) {
        throw new Error('BrowserContext or old foreground page is not set')
      }

      const oldTabIdx = this.browserContext.pages().indexOf(oldForeground)
      this.humanCurrentPage = newPage
      const newTabIdx = this.browserContext.pages().indexOf(newPage)

      // Log before and after for debugging
      const oldUrl = oldForeground ? oldForeground.url() : 'about:blank'
      const newUrl = newPage ? newPage.url() : 'about:blank'
      const agentUrl = this.agentCurrentPage ? this.agentCurrentPage.url() : 'about:blank'
      const agentTabIdx = this.browserContext.pages().indexOf(this.agentCurrentPage!)

      if (oldUrl !== newUrl) {
        logger.info(
          `👁️ Foregound tab changed by human from [${oldTabIdx}]${logPrettyUrl(oldUrl)} `
          + `➡️ [${newTabIdx}]${logPrettyUrl(newUrl)} `
          + `(agent will stay on [${agentTabIdx}]${logPrettyUrl(agentUrl)})`,
        )
      }
    }

    try {
      await this.browserContext.exposeBinding('_BrowserUseonTabVisibilityChange', BrowserUseonTabVisibilityChange)
    } catch (e: any) {
      if (e.message.includes('Function "_BrowserUseonTabVisibilityChange" has been already registered')) {
        logger.debug(
          '⚠️ Function "_BrowserUseonTabVisibilityChange" has been already registered, '
          + 'this is likely because the browser was already started with an existing BrowserSession()',
        )
      } else {
        throw e
      }
    }

    const updateTabFocusScript = () => {
      // --- Method 1: visibilitychange event (unfortunately *all* tabs are always marked visible by playwright, usually does not fire) ---
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          await window._BrowserUseonTabVisibilityChange({ source: 'visibilitychange', url: document.location.href })
          console.log('BrowserUse Foreground tab change event fired', document.location.href)
        }
      })

      // --- Method 2: focus/blur events, most reliable method for headful browsers ---
      window.addEventListener('focus', async () => {
        await window._BrowserUseonTabVisibilityChange({ source: 'focus', url: document.location.href })
        console.log('BrowserUse Foreground tab change event fired', document.location.href)
      })
    }

    await this.browserContext.addInitScript(updateTabFocusScript)

    // Set up visibility listeners for all existing tabs
    for (const page of this.browserContext.pages()) {
      try {
        await page.evaluate(updateTabFocusScript)
      } catch (e: any) {
        const pageIdx = this.browserContext.pages().indexOf(page)
        logger.debug(
          `⚠️ Failed to add visibility listener to existing tab, is it crashed or ignoring CDP commands?: [${pageIdx}]${page.url()}: ${e.constructor.name}: ${e.message}`,
        )
      }
    }
  }

  /**
   * Resize any existing page viewports to match the configured size
   * @returns
   */
  async setupViewports(): Promise<void> {
    // log the viewport settings to terminal
    const viewport = this.browserProfile.viewport
    logger.debug(
      `📐 Setting up viewport: `
      + `headless=${this.browserProfile.headless} ${
        this.browserProfile.windowSize
          ? `window=${this.browserProfile.windowSize.width}x${this.browserProfile.windowSize.height}px `
          : '(no window) '
      }${this.browserProfile.screen
        ? `screen=${this.browserProfile.screen.width}x${this.browserProfile.screen.height}px `
        : ''
      }${viewport ? `viewport=${viewport.width}x${viewport.height}px ` : '(no viewport) '
      }device_scale_factor=${this.browserProfile.deviceScaleFactor || 1.0} `
      + `is_mobile=${this.browserProfile.isMobile} ${
        this.browserProfile.colorScheme ? `color_scheme=${this.browserProfile.colorScheme} ` : ''
      }${this.browserProfile.locale ? `locale=${this.browserProfile.locale} ` : ''
      }${this.browserProfile.timezoneId ? `timezone_id=${this.browserProfile.timezoneId} ` : ''
      }${this.browserProfile.geolocation ? `geolocation=${JSON.stringify(this.browserProfile.geolocation)} ` : ''
      }permissions=${(this.browserProfile.permissions || ['<none>']).join(',')} `,
    )

    // if we have any viewport settings in the profile, make sure to apply them to the entire browser_context as defaults
    if (this.browserProfile.permissions) {
      try {
        await this.browserContext!.grantPermissions(this.browserProfile.permissions)
      } catch (e: any) {
        logger.warn(
          `⚠️ Failed to grant browser permissions ${this.browserProfile.permissions}: ${e.constructor.name}: ${e.message}`,
        )
      }
    }

    try {
      if (this.browserProfile.defaultTimeout) {
        this.browserContext!.setDefaultTimeout(this.browserProfile.defaultTimeout)
      }
      if (this.browserProfile.defaultNavigationTimeout) {
        this.browserContext!.setDefaultNavigationTimeout(this.browserProfile.defaultNavigationTimeout)
      }
    } catch (e: any) {
      logger.warn(
        `⚠️ Failed to set playwright timeout settings `
        + `cdp_api=${this.browserProfile.defaultTimeout} `
        + `navigation=${this.browserProfile.defaultNavigationTimeout}: ${e.constructor.name}: ${e.message}`,
      )
    }

    try {
      if (this.browserProfile.extraHttpHeaders) {
        await this.browserContext!.setExtraHTTPHeaders(this.browserProfile.extraHttpHeaders)
      }
    } catch (e: any) {
      logger.warn(
        `⚠️ Failed to setup playwright extra_http_headers: ${e.constructor.name}: ${e.message}`,
      ) // dont print the secret header contents in the logs!
    }

    try {
      if (this.browserProfile.geolocation) {
        await this.browserContext!.setGeolocation(this.browserProfile.geolocation)
      }
    } catch (e: any) {
      logger.warn(`⚠️ Failed to update browser geolocation ${JSON.stringify(this.browserProfile.geolocation)}: ${e.constructor.name}: ${e.message}`)
    }

    let page: Page | null = null

    for (page of this.browserContext!.pages()) {
      // apply viewport size settings to any existing pages
      if (viewport) {
        await page.setViewportSize(viewport)
      }

      // show browser-use dvd screensaver-style bouncing loading animation on any about:blank pages
      if (page.url() === 'about:blank') {
        await this.showDvdScreensaverLoadingAnimation(page)
      }
    }

    page = page || (await this.browserContext!.newPage())

    if ((!viewport) && (this.browserProfile.windowSize) && !this.browserProfile.headless) {
      // attempt to resize the actual browser window
      // cdp api: https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setWindowBounds
      try {
        const cdpSession = await page.context().newCDPSession(page)
        const windowIdResult = await cdpSession.send('Browser.getWindowForTarget')
        await cdpSession.send('Browser.setWindowBounds', {
          windowId: windowIdResult.windowId,
          bounds: {
            ...this.browserProfile.windowSize,
            windowState: 'normal', // Ensure window is not minimized/maximized
          },
        })
        await cdpSession.detach()
      } catch (e: any) {
        const logSize = (size: any) => `${size.width}x${size.height}px`
        try {
          // fallback to javascript resize if cdp setWindowBounds fails
          await page.evaluate(
            ({
              width,
              height,
            }) => { window.resizeTo(width, height) },
            {
              width: this.browserProfile.windowSize!.width,
              height: this.browserProfile.windowSize!.height,
            },
          )
          return
        } catch (e: any) {
          // ignore fallback error
        }

        logger.warn(
          `⚠️ Failed to resize browser window to ${logSize(this.browserProfile.windowSize)} using CDP setWindowBounds: ${e.constructor.name}: ${e.message}`,
        )
      }
    }
  }

  /**
   * set the keep_alive flag on the browser_profile, defaulting to True if keep_alive is None
   */
  private setBrowserKeepAlive(keepAlive?: boolean): void {
    if (this.browserProfile.keepAlive === undefined) {
      this.browserProfile.keepAlive = keepAlive
    }
  }

  /**
   * Check if the browser session has valid, connected browser and context objects.
   * Returns False if any of the following conditions are met:
   * - No browser_context exists
   * - Browser exists but is disconnected
   * - Browser_context's browser exists but is disconnected
   * - Browser_context itself is closed/unusable
   */
  isConnected(): boolean {
    // Check if browser_context is missing
    if (!this.browserContext) {
      return false
    }

    // Check if browser exists but is disconnected
    if (this.browser && !this.browser.isConnected()) {
      return false
    }

    // Check if browser_context's browser exists but is disconnected
    if (this.browserContext.browser() && !this.browserContext.browser()!.isConnected()) {
      return false
    }

    // Check if the browser_context itself is closed/unusable
    try {
      // Try to access a property that would fail if the context is closed
      this.browserContext.pages()
      // Additional check: try to access the browser property which might fail if context is closed
      if (this.browserContext.browser() && !this.browserContext.browser()!.isConnected()) {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  /** Reset the browser connection state when disconnection is detected */
  resetConnectionState(): void {
    this.initialized = false
    this.browser = undefined
    this.browserContext = undefined
    // Also clear browser_pid since the process may no longer exist
    this.browserPid = undefined
  }

  // --- Tab management ---
  /**
   * Get the current page + ensure it's not None / closed
   * @returns The current page
   */
  async getCurrentPage(): Promise<Page> {
    if (!this.initialized) {
      await this.start()
    }

    // get-or-create the browser_context if it's not already set up
    if (!this.browserContext) {
      await this.start()
      if (!this.browserContext) {
        throw new Error('BrowserContext is not set up')
      }
    }

    // if either focused page is closed, clear it so we dont use a dead object
    if ((!this.humanCurrentPage) || this.humanCurrentPage.isClosed()) {
      this.humanCurrentPage = undefined
    }
    if ((!this.agentCurrentPage) || this.agentCurrentPage.isClosed()) {
      this.agentCurrentPage = undefined
    }

    // if either one is None, fallback to using the other one for both
    this.agentCurrentPage = this.agentCurrentPage || this.humanCurrentPage || undefined
    this.humanCurrentPage = this.humanCurrentPage || this.agentCurrentPage || undefined

    // if both are still None, fallback to using the first open tab we can find
    if (this.agentCurrentPage === undefined) {
      const pages = this.browserContext.pages()
      if (pages.length > 0) {
        const firstAvailableTab = pages[0]
        this.agentCurrentPage = firstAvailableTab
        this.humanCurrentPage = firstAvailableTab
      } else {
        // if all tabs are closed, open a new one
        const newTab = await this.createNewTab()
        this.agentCurrentPage = newTab
        this.humanCurrentPage = newTab
      }
    }

    if (!this.agentCurrentPage) {
      throw new Error('Failed to find or create a new page for the agent')
    }
    if (!this.humanCurrentPage) {
      throw new Error('Failed to find or create a new page for the human')
    }

    return this.agentCurrentPage
  }

  get tabs(): Page[] {
    if (!this.browserContext) {
      return []
    }
    return this.browserContext.pages()
  }

  @requireInitialization
  async newTab(url?: string): Promise<Page> {
    return await this.createNewTab(url)
  }

  @requireInitialization
  async switchTab(tabIndex: number): Promise<Page> {
    const pages = this.browserContext!.pages()
    if (!pages || tabIndex >= pages.length) {
      throw new Error('Tab index out of range')
    }
    const page = pages[tabIndex]
    this.agentCurrentPage = page
    return page
  }

  @requireInitialization
  async waitForElement(selector: string, timeout: number = 10000): Promise<void> {
    const page = await this.getCurrentPage()
    await page.waitForSelector(selector, { state: 'visible', timeout })
  }

  /**
   * Removes all highlight overlays and labels created by the highlightElement function.
   * Handles cases where the page might be closed or inaccessible.
   */
  @requireInitialization
  @timeExecutionAsync('--remove_highlights')
  async removeHighlights(): Promise<void> {
    const page = await this.getCurrentPage()
    try {
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
        } catch (e) {
          logger.error('Failed to remove highlights:', e)
        }
      })
    } catch (e: any) {
      logger.debug(`⚠  Failed to remove highlights (this is usually ok): ${e.constructor.name}: ${e.message}`)
      // Don't raise the error since this is not critical functionality
    }
  }

  /**
   * Get DOM element by index.
   */
  @requireInitialization
  async getDomElementByIndex(index: number): Promise<any | null> {
    const selectorMap = await this.getSelectorMap()
    return selectorMap[index]
  }

  /**
   * Optimized method to click an element using xpath.
   */
  @requireInitialization
  @timeExecutionAsync('--click_element_node')
  async clickElementNode(elementNode: DOMElementNode) {
    const page = await this.getCurrentPage()
    try {
      // Highlight before clicking
      // if element_node.highlight_index is not None:
      // await this._update_state(focus_element=element_node.highlight_index)

      const elementHandle = await this.getLocateElement(elementNode)

      if (!elementHandle) {
        throw new Error(`Element: ${JSON.stringify(elementNode)} not found`)
      }

      /**
       * Performs the actual click, handling both download
       * and navigation scenarios.
       */
      const performClick = async (clickFunc: () => Promise<void>) => {
        if (this.browserProfile.downloadsDir) {
          try {
            // Try short-timeout expect_download to detect a file download has been been triggered
            const downloadInfoPromise = page.waitForEvent('download', { timeout: 5000 })
            await clickFunc()
            const downloadInfo = await downloadInfoPromise

            // Determine file path
            const suggestedFilename = downloadInfo.suggestedFilename()
            const uniqueFilename = await BrowserSession.getUniqueFilename(
              this.browserProfile.downloadsDir,
              suggestedFilename,
            )
            const downloadPath = path.join(this.browserProfile.downloadsDir, uniqueFilename)
            await downloadInfo.saveAs(downloadPath)
            logger.debug(`⬇️  Download triggered. Saved file to: ${downloadPath}`)
            return downloadPath
          } catch (e: any) {
            if (e.message.includes('TimeoutError')) {
              // If no download is triggered, treat as normal click
              logger.debug('No download triggered within timeout. Checking navigation...')
              await page.waitForLoadState()
              await this.checkAndHandleNavigation(page)
            } else {
              throw e
            }
          }
        } else {
          // Standard click logic if no download is expected
          await clickFunc()
          await page.waitForLoadState()
          await this.checkAndHandleNavigation(page)
        }
      }

      try {
        return await performClick.call(this, () => elementHandle.click({ timeout: 1500 }))
      } catch (e: any) {
        if (e instanceof URLNotAllowedError) {
          throw e
        }
        try {
          return await performClick.call(this, () => page.evaluate(el => (el as HTMLElement).click(), elementHandle))
        } catch (e: any) {
          if (e instanceof URLNotAllowedError) {
            throw e
          }
          throw new Error(`Failed to click element: ${e.message}`)
        }
      }
    } catch (e: any) {
      throw new Error(`Failed to click element: ${JSON.stringify(elementNode)}. Error: ${e.message}`)
    }
  }

  @requireInitialization
  @timeExecutionAsync('--get_tabs_info')
  async getTabsInfo(): Promise<TabInfo[]> {
    /** Get information about all tabs */

    const tabsInfo: TabInfo[] = []
    for (const [pageId, page] of this.browserContext!.pages().entries()) {
      try {
        const title = await page.title()
        tabsInfo.push({ pageId, url: page.url(), title })
      } catch {
        // page.title() can hang forever on tabs that are crashed/disappeared/about:blank
        // we dont want to try automating those tabs because they will hang the whole script
        logger.debug(`⚠  Failed to get tab info for tab #${pageId}: ${page.url()} (ignoring)`)
        tabsInfo.push({ pageId, url: 'about:blank', title: 'ignore this tab and do not use it' })
      }
    }

    return tabsInfo
  }

  @requireInitialization
  async closeTab(tabIndex?: number): Promise<void> {
    const pages = this.browserContext!.pages()
    if (!pages) {
      return
    }

    let page: Page
    if (tabIndex === undefined) {
      // to tabIndex passed, just close the current agent page
      page = await this.getCurrentPage()
    } else {
      // otherwise close the tab at the given index
      page = pages[tabIndex]
    }

    await page.close()

    // reset the self.agentCurrentPage and self.humanCurrentPage references to first available tab
    await this.getCurrentPage()
  }

  //  --- Page navigation ---
  /**
   * Navigate the agent's current tab to a URL
   */
  @requireInitialization
  async navigate(url: string): Promise<void> {
    if (!this.isUrlAllowed(url)) {
      throw new BrowserError(`Navigation to non-allowed URL: ${url}`)
    }

    const page = await this.getCurrentPage()
    await page.goto(url)
    await page.waitForLoadState()
  }

  @requireInitialization
  async refresh() {
    if (this.agentCurrentPage && !this.agentCurrentPage.isClosed()) {
      await this.agentCurrentPage.reload()
    } else {
      await this.createNewTab()
    }
  }

  @requireInitialization
  async executeJavascript<
    R,
    Args,
  >(pageFunction: (args: Args) => R,
    args?: Args,
  ): Promise<R> {
    const page = await this.getCurrentPage()
    return page.evaluate(pageFunction as any, args)
  }

  async getCookies() {
    if (this.browserContext) {
      return this.browserContext.cookies()
    }
    return []
  }

  /**
   * Old name for the new save_storage_state() function.
   */
  async saveCookies(pathArg?: string): Promise<void> {
    await this.saveStorageState(pathArg)
  }

  /**
   * Save cookies to the specified path or the configured cookies_file and/or storage_state.
   */
  @requireInitialization
  async saveStorageState(filePath?: string): Promise<void> {
    const storageState = await this.browserContext!.storageState()
    const cookies = storageState.cookies

    if (cookies && this.browserProfile.cookiesFile) {
      logger.warn(
        '⚠️ cookies_file is deprecated and will be removed in a future version. '
        + 'Please use storage_state instead for loading cookies and other browser state. '
        + 'See: https://playwright.dev/python/docs/api/class-browsercontext#browser-context-storage-state',
      )
    }

    const pathIsStorageState = filePath && filePath.toString().endsWith('storage_state.json')
    if ((filePath && !pathIsStorageState) || this.browserProfile.cookiesFile) {
      let cookiesFilePath: string
      try {
        cookiesFilePath = path.resolve(filePath || this.browserProfile.cookiesFile!)
        fs.mkdirSync(path.dirname(cookiesFilePath), { recursive: true })
        fs.writeFileSync(cookiesFilePath, JSON.stringify(cookies, null, 4))
        logger.info(`🍪 Saved ${cookies.length} cookies to cookies_file=${logPrettyPath(cookiesFilePath)}`)
      } catch (e: any) {
        logger.warn(
          `❌ Failed to save cookies to cookies_file=${logPrettyPath(cookiesFilePath!)}: ${e.message}`,
        )
      }
    }

    let storageStatePath: BrowserContextOptions['storageState']
    if (filePath) {
      storageStatePath = path.resolve(path.dirname(filePath), 'storage_state.json')
    } else {
      storageStatePath = this.browserProfile.storageState
    }

    if (!storageStatePath) {
      return
    }

    if (!(typeof storageStatePath === 'string')) {
      logger.warn('⚠️ storage_state must be a json file path to be able to update it, skipping...')
      return
    }

    try {
      fs.mkdirSync(path.dirname(storageStatePath), { recursive: true })
      const storageState = await this.browserContext!.storageState()

      if (fs.existsSync(storageStatePath)) {
        try {
          const existingStorageState = JSON.parse(fs.readFileSync(storageStatePath, 'utf-8'))
          const mergedStorageState = Object.assign(existingStorageState, storageState)
          fs.writeFileSync(storageStatePath, JSON.stringify(mergedStorageState, null, 4))
        } catch (e: any) {
          logger.warn(
            `❌ Failed to merge storage state with existing storage_state=${logPrettyPath(storageStatePath)}: ${e.message}`,
          )
          return
        }
      }

      fs.writeFileSync(storageStatePath, JSON.stringify(storageState, null, 4))
      logger.info(
        `🍪 Saved ${storageState.cookies.length} cookies to storage_state=${logPrettyPath(storageStatePath)}`,
      )
    } catch (e: any) {
      logger.warn(
        `❌ Failed to save storage state to storage_state=${logPrettyPath(storageStatePath)}: ${e.message}`,
      )
    }
  }

  /**
   * Load cookies from the storage_state or cookies_file and apply them to the browser context.
   */
  @requireInitialization
  async loadStorageState(): Promise<void> {
    if (this.browserProfile.cookiesFile) {
      // Show deprecation warning
      logger.warn(
        '⚠️ cookies_file is deprecated and will be removed in a future version. '
        + 'Please use storage_state instead for loading cookies and other browser state. '
        + 'See: https://playwright.dev/python/docs/api/class-browsercontext#browser-context-storage-state',
      )

      let cookiesPath = path.resolve(this.browserProfile.cookiesFile)
      if (!path.isAbsolute(this.browserProfile.cookiesFile)) {
        cookiesPath = path.join(this.browserProfile.downloadsDir || '.', this.browserProfile.cookiesFile)
      }

      try {
        const cookiesData = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'))
        if (cookiesData) {
          await this.browserContext!.addCookies(cookiesData)
          logger.info(`🍪 Loaded ${cookiesData.length} cookies from cookies_file=${logPrettyPath(cookiesPath)}`)
        }
      } catch (e: any) {
        logger.warn(
          `❌ Failed to load cookies from cookies_file=${logPrettyPath(cookiesPath)}: : ${e.message}`,
        )
      }
    }

    if (this.browserProfile.storageState) {
      let storageState = this.browserProfile.storageState
      if (typeof storageState === 'string') {
        try {
          storageState = JSON.parse(fs.readFileSync(storageState.toString(), 'utf-8'))
        } catch (e: any) {
          logger.warn(
            `❌ Failed to load cookies from storage_state=${logPrettyPath(storageState as string)}: ${e.message}`,
          )
          return
        }
      }

      try {
        if (typeof storageState !== 'object' || storageState === null) {
          throw new Error(`Got unexpected type for storage_state: ${typeof storageState}`)
        }

        await this.browserContext!.addCookies(storageState.cookies)
        // TODO: also handle localStroage, IndexedDB, SessionStorage
        // playwright doesn't provide an API for setting these before launch
        // https://playwright.dev/python/docs/auth#session-storage
        // await this.browserContext.add_local_storage(storage_state['localStorage'])
        logger.info(
          `🍪 Loaded ${storageState.cookies.length} cookies from storage_state=${logPrettyPath(this.browserProfile.storageState as string)}`,
        )
      } catch (e: any) {
        logger.warn(
          `❌ Failed to load cookies from storage_state=${logPrettyPath(this.browserProfile.storageState as string)}: ${e.message}`,
        )
      }
    }
  }

  /**
   * Old name for the new load_storage_state() function.
   */
  async loadCookiesFromFile(): Promise<void> {
    await this.loadStorageState()
  }

  async waitForStableNetwork(): Promise<void> {
    const pendingRequests = new Set<Request>()
    let lastActivity = Date.now()

    const page = await this.getCurrentPage()

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

    const onRequest = async (request: Request) => {
      // Filter by resource type
      if (!RELEVANT_RESOURCE_TYPES.has(request.resourceType())) {
        return
      }

      // Filter out streaming, websocket, and other real-time requests
      if (new Set([
        'websocket',
        'media',
        'eventsource',
        'manifest',
        'other',
      ]).has(request.resourceType())) {
        return
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase()
      if ([...IGNORED_URL_PATTERNS].some(pattern => url.includes(pattern))) {
        return
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return
      }

      // Filter out requests with certain headers
      const headers = request.headers()
      if (headers.purpose === 'prefetch'
        || headers['sec-fetch-dest'] === 'video'
        || headers['sec-fetch-dest'] === 'audio') {
        return
      }

      pendingRequests.add(request)
      lastActivity = Date.now()
    }

    const onResponse = async (response: Response) => {
      const request = response.request()
      if (!pendingRequests.has(request)) {
        return
      }

      // Filter by content type if available
      const contentType = response.headers()['content-type']?.toLowerCase() || ''

      // Skip if content type indicates streaming or real-time data
      if (['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf']
        .some(type => contentType.includes(type))) {
        pendingRequests.delete(request)
        return
      }

      // Only process relevant content types
      if (![...RELEVANT_CONTENT_TYPES].some(ct => contentType.includes(ct))) {
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
      lastActivity = Date.now()
    }

    // Attach event listeners
    page.on('request', onRequest)
    page.on('response', onResponse)

    let startTime: number
    try {
      // Wait for idle time
      startTime = Date.now()
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100))

        const currentTime = Date.now()
        if (pendingRequests.size === 0
          && (currentTime - lastActivity) >= this.browserProfile.waitForNetworkIdlePageLoadTime) {
          break
        }
        if (currentTime - startTime > this.browserProfile.maximumWaitPageLoadTime) {
          logger.debug(
            `Network timeout after ${this.browserProfile.maximumWaitPageLoadTime}s with ${pendingRequests.size} `
            + `pending requests: ${[...pendingRequests].map(r => r.url())}`,
          )
          break
        }
      }
    } finally {
      // Clean up event listeners
      page.removeListener('request', onRequest)
      page.removeListener('response', onResponse)
    }

    const elapsed = Date.now() - startTime
    if (elapsed > 1000) {
      logger.debug(`💤 Page network traffic calmed down after ${(Date.now() - startTime) / 1000} seconds`)
    }
  }

  /**
   * Ensures page is fully loaded before continuing.
   * Waits for either network to be idle or minimum WAIT_TIME, whichever is longer.
   * Also checks if the loaded URL is allowed.
   * @param timeoutOverride
   */
  async waitForPageAndFramesLoad(timeoutOverride?: number): Promise<void> {
    const startTime = Date.now()

    const page = await this.getCurrentPage()

    try {
      await this.waitForStableNetwork()
      await this.checkAndHandleNavigation(page)
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error // Re-throw URLNotAllowedError to be handled by the caller
      }
      logger.warn('⚠️  Page load failed, continuing...')
    }

    const elapsed = Date.now() - startTime
    const remaining = Math.max((timeoutOverride || this.browserProfile.minimumWaitPageLoadTime) - elapsed, 0)
    let byteUsed: number | undefined
    try {
      byteUsed = await page.evaluate(() => {
        let total = 0
        for (const entry of performance.getEntriesByType('resource')) {
          total += (entry as any).transferSize || 0
        }
        for (const nav of performance.getEntriesByType('navigation')) {
          total += (nav as any).transferSize || 0
        }
        return total
      })
    } catch (error) {
      byteUsed = undefined
    }

    const tabIdx = this.tabs.indexOf(page)
    if (byteUsed) {
      logger.debug(
        `➡️ Page navigation [${tabIdx}]: ${logPrettyUrl(page.url(), 40)} used ${(byteUsed / 1024).toFixed(1)} KB in ${elapsed.toFixed(2)}s, waiting +${remaining.toFixed(2)}s for all frames to finish`,
      )
    } else {
      logger.debug(
        `➡️ Page navigation [${tabIdx}]: ${logPrettyUrl(page.url(), 40)} took ${elapsed.toFixed(2)}s, waiting +${remaining.toFixed(2)}s for all frames to finish`,
      )
    }

    if (remaining > 0) {
      await sleep(remaining)
    }
  }

  /**
   * Check if a URL is allowed based on the whitelist configuration. SECURITY CRITICAL.
   * Supports optional glob patterns and schemes in allowed_domains:
   * - *.example.com will match sub.example.com and example.com
   * - *google.com will match google.com, agoogle.com, and www.google.com
   * - http*://example.com will match http://example.com, https://example.com
   * - chrome-extension://* will match chrome-extension://aaaaaaaaaaaa and chrome-extension://bbbbbbbbbbbbb
   */
  isUrlAllowed(url: string): boolean {
    if (!this.browserProfile.allowedDomains) {
      return true // allowed_domains are not configured, allow everything by default
    }

    if (url === 'about:blank') {
      return true // allow about:blank for initial page load
    }

    for (const allowDomain of this.browserProfile.allowedDomains) {
      try {
        if (matchUrlWithDomainPattern(url, allowDomain, true)) {
          if (allowDomain.includes('*')) {
            const parsedUrl = new URL(url)
            const domain = parsedUrl.hostname.toLowerCase()
            logGlobWarning(domain, allowDomain)
          }
          return true // URL matches an allowed domain pattern
        }
      } catch (error) {

      }
    }
    return false
  }

  /**
   * Check if current page URL is allowed and handle if not.
   * @param page
   */
  async checkAndHandleNavigation(page: Page) {
    if (!this.isUrlAllowed(page.url())) {
      logger.warn(`⛔️  Navigation to non-allowed URL detected:${page.url()}`)
      try {
        await this.goBack()
      } catch (error: any) {
        logger.error(`⛔️  Failed to go back after detecting non-allowed URL: ${error.message}`)
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

    const page = await this.getCurrentPage()
    await page.goto(url)
    await page.waitForLoadState()
  }

  /**
   * Refresh the current page.
   */
  async refreshPage() {
    const page = await this.getCurrentPage()
    await page.reload()
    await page.waitForLoadState()
  }

  /**
   * Navigate the agent's tab back in browser history
   */
  async goBack() {
    try {
      // 10ms timeout
      const page = await this.getCurrentPage()
      await page.goBack({ timeout: 10 * 1000, waitUntil: 'domcontentloaded' })
    } catch (error: any) {
      // Continue even if its not fully loaded, because we wait later for the page to load
      logger.debug(`⏮️  Error during go_back: ${error.message}`)
    }
  }

  /**
   * Navigate the agent's tab forward in browser history
   */
  async goForward() {
    try {
      // 10ms timeout
      const page = await this.getCurrentPage()
      await page.goForward({ timeout: 10 * 1000, waitUntil: 'domcontentloaded' })
    } catch (error: any) {
      // Continue even if its not fully loaded, because we wait later for the page to load
      logger.debug(`⏭️  Error during go_forward: ${error.message}`)
    }
  }

  /**
   * Close the current tab that the agent is working with.
   *
   * This closes the tab that the agent is currently using (agent_current_page),
   * not necessarily the tab that is visible to the user (human_current_page).
   * If they are the same tab, both references will be updated.
   * If no tabs are left, the browser will be closed.
   */
  async closeCurrentTab(): Promise<void> {
    if (!this.browserContext) {
      throw new Error('Browser context is not set')
    }

    if (!this.agentCurrentPage) {
      throw new Error('Agent current page is not set')
      return
    }

    // Check if this is the foreground tab as well
    const isForeground = this.agentCurrentPage === this.humanCurrentPage

    // Close the tab
    try {
      await this.agentCurrentPage.close()
    } catch (e: any) {
      logger.debug(`⛔️  Error during closeCurrentTab: ${e.message}`)
    }

    // Clear agent's reference to the closed tab
    this.agentCurrentPage = undefined

    // Clear foreground reference if needed
    if (isForeground) {
      this.humanCurrentPage = undefined
    }

    // Switch to the first available tab if any exist
    if (this.browserContext.pages().length > 0) {
      await this.switchTab(0)
      // switch_to_tab already updates both tab references
    }
  }

  /**
   * Get the HTML content of the agent's current page
   */
  async getPageHtml() {
    const page = await this.getCurrentPage()
    try {
      return page.content()
    } catch (e: any) {
      logger.debug(`⚠️  Error getting page HTML: ${e.message}`)
      return ''
    }
  }

  /**
   * Get a debug view of the page structure including iframes"
   */
  async getPageStructure() {
    const debugScript = () => {
      function getPageStructure(element: Document | Element = document, depth = 0, maxDepth = 10) {
        if (depth >= maxDepth)
          return ''

        const indent = '  '.repeat(depth)
        let structure = ''

        // Skip certain elements that clutter the output
        const skipTags = new Set(['script', 'style', 'link', 'meta', 'noscript'])

        // Add current element info if it's not the document
        if (!(element instanceof Document)) {
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
          structure += `${indent}${tagName}${id}${classes}${attrs.length ? ` [${attrs.join(', ')}]` : ''}\\n`

          // Handle iframes specially
          if (tagName === 'iframe') {
            try {
              const iframeDoc = (element as HTMLIFrameElement).contentDocument || (element as HTMLIFrameElement).contentWindow?.document
              if (iframeDoc) {
                structure += `${indent}  [IFRAME CONTENT]:\\n`
                structure += getPageStructure(iframeDoc, depth + 2, maxDepth)
              } else {
                structure += `${indent}  [IFRAME: No access - likely cross-origin]\\n`
              }
            } catch (e: any) {
              structure += `${indent}  [IFRAME: Access denied - ${e.message}]\\n`
            }
          }
        }

        // Get all child elements
        const children = (element as Element).children || element.childNodes
        for (const child of children) {
          if (child.nodeType === 1) { // Element nodes only
            structure += getPageStructure(child, depth + 1, maxDepth)
          }
        }

        return structure
      }

      return getPageStructure()
    }
    const page = await this.getCurrentPage()

    const structure = await page.evaluate(debugScript)
    return structure
  }

  /**
   * Get a summary of the current browser state
   *
   * This method builds a BrowserStateSummary object that captures the current state
   * of the browser, including url, title, tabs, screenshot, and DOM tree.
   *
   * @param cache_clickable_elements_hashes - If True, cache the clickable elements hashes for the current state.
   * This is used to calculate which elements are new to the LLM since the last message,
   * which helps reduce token usage.
   */
  @timeExecutionSync('--get_state_summary')
  async getStateSummary(cacheClickableElementsHashes: boolean): Promise<BrowserStateSummary> {
    await this.waitForPageAndFramesLoad()
    const updatedState = await this.getUpdatedState()

    // Find out which elements are new
    // Do this only if url has not changed
    if (cacheClickableElementsHashes) {
      // if we are on the same url as the last state, we can use the cached hashes
      if (this.cachedClickableElementHashes && this.cachedClickableElementHashes.url === updatedState.url) {
        // Pointers, feel free to edit in place
        const updatedStateClickableElements = ClickableElementProcessor.getClickableElements(updatedState.elementTree)

        for (const domElement of updatedStateClickableElements) {
          domElement.isNew = this.cachedClickableElementHashes.hashes.has(ClickableElementProcessor.hashDomElement(domElement)) // see which elements are new from the last state where we cached the hashes
        }
      }
      // in any case, we need to cache the new hashes
      this.cachedClickableElementHashes = {
        url: updatedState.url,
        hashes: ClickableElementProcessor.getClickableElementsHashes(updatedState.elementTree),
      }
    }

    this.cachedBrowserStateSummary = updatedState

    // Save cookies if a file is specified
    if (this.browserProfile.cookiesFile) {
      await this.saveCookies()
    }

    return this.cachedBrowserStateSummary
  }

  /**
   * Update and return state.
   * @param focusElement
   * @returns
   */
  private async getUpdatedState(focusElement: number = -1): Promise<BrowserStateSummary> {
    const page = await this.getCurrentPage()

    // Check if current page is still valid, if not switch to another available page
    try {
      // Test if page is still accessible
      await page.evaluate('1')
    } catch (e: any) {
      logger.debug(`👋  Current page is no longer accessible: ${e.message}`)
      throw new BrowserError('Browser closed: no valid pages available')
    }

    try {
      await this.removeHighlights()
      const domService = new DomService(page)
      const content = await domService.getClickableElements(
        {
          focusElement,
          viewportExpansion: this.browserProfile.viewportExpansion,
          highlightElements: this.browserProfile.highlightElements,
        },
      )

      const tabsInfo = await this.getTabsInfo()

      // Get all cross-origin iframes within the page and open them in new tabs
      // mark the titles of the new tabs so the LLM knows to check them for additional content
      // unfortunately too buggy for now, too many sites use invisible cross-origin iframes for ads, tracking, youtube videos, social media, etc.
      // and it distracts the bot by opening a lot of new tabs
      // iframe_urls = await dom_service.get_cross_origin_iframes()
      // outer_page = this.agentCurrentPage
      // for url in iframe_urls:
      //  if url in [tab.url for tab in tabs_info]:
      //    continue  # skip if the iframe if we already have it open in a tab
      //  new_page_id = tabs_info[-1].page_id + 1
      //  logger.debug(f'Opening cross-origin iframe in new tab #{new_page_id}: {url}')
      //  await this.createNewTab(url)
      //  tabs_info.append(
      //   TabInfo(
      //      page_id=new_page_id,
      //      url=url,
      //      title=f'iFrame opened as new tab, treat as if embedded inside page {outer_page.url}: {page.url}',
      //      parent_page_url=outer_page.url,
      //    )
      //  )

      const screenshotB64 = await this.takeScreenshot()
      const { pixelsAbove, pixelsBelow } = await this.getScrollInfo(page)

      this.browserStateSummary = {
        elementTree: content.elementTree,
        selectorMap: content.selectorMap,
        url: page.url(),
        title: await page.title(),
        tabs: tabsInfo,
        screenshot: screenshotB64,
        pixelsAbove,
        pixelsBelow,
      }

      return this.browserStateSummary
    } catch (e: any) {
      logger.error(`❌  Failed to update state: ${e.message}`)
      // Return last known good state if available
      if (this.browserStateSummary) {
        return this.browserStateSummary
      }
      throw e
    }
  }

  // region - Browser Actions
  /**
   * Get a base64 encoded screenshot of the current page.
   */
  @requireInitialization
  @timeExecutionAsync('--take_screenshot')
  async takeScreenshot(fullPage: boolean = false): Promise<string> {
    const page = await this.getCurrentPage()
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 })

    // 0. Attempt full-page screenshot (sometimes times out for huge pages)
    try {
      const screenshot = await page.screenshot({
        fullPage,
        scale: 'css',
        timeout: 15000,
        animations: 'disabled',
        caret: 'initial',
      })

      return screenshot.toString('base64')
    } catch (e: any) {
      logger.error(`❌  Failed to take full-page screenshot: ${e.message} falling back to viewport-only screenshot`)
    }

    // Fallback method: manually expand the viewport and take a screenshot of the entire viewport

    // 1. Get current page dimensions
    const dimensions = await page.evaluate(() => {
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      }
    })

    // 2. Save current viewport state and calculate expanded dimensions
    const originalViewport = page.viewportSize()
    const viewportExpansion = this.browserProfile.viewportExpansion || 0

    const expandedWidth = dimensions.width // Keep width unchanged
    const expandedHeight = dimensions.height + viewportExpansion

    // 3. Expand the viewport if we are using one
    if (originalViewport) {
      await page.setViewportSize({ width: expandedWidth, height: expandedHeight })
    }

    try {
      // 4. Take full-viewport screenshot
      const screenshot = await page.screenshot({
        fullPage: false,
        scale: 'css',
        timeout: 30000,
        clip: { x: 0, y: 0, width: expandedWidth, height: expandedHeight },
      })

      const screenshotB64 = screenshot.toString('base64')
      return screenshotB64
    } finally {
      // 5. Restore original viewport state if we expanded it
      if (originalViewport) {
        // Viewport was originally enabled, restore to original dimensions
        await page.setViewportSize(originalViewport)
      } else {
        // Viewport was originally disabled, no need to restore it
        // await page.setViewportSize(null);  // unfortunately this is not supported by playwright

      }
    }
  }

  // region - User Actions

  /**
   * Generate a unique filename for downloads by appending (1), (2), etc., if a file already exists.
   */
  static async getUniqueFilename(directory: string, filename: string): Promise<string> {
    const base = path.basename(filename, path.extname(filename))
    const ext = path.extname(filename)
    let counter = 1
    let newFilename = filename
    while (fs.existsSync(path.join(directory, newFilename))) {
      newFilename = `${base} (${counter})${ext}`
      counter += 1
    }
    return newFilename
  }

  static convertSimpleXPathToCssSelector(xpath: string): string {
    /** Converts simple XPath expressions to CSS selectors. */
    if (!xpath) {
      return ''
    }

    // Remove leading slash if present
    xpath = xpath.replace(/^\/+/, '')

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
        let basePart = part.substring(0, part.indexOf('['))
        // Handle custom elements with colons in the base part
        if (basePart.includes(':')) {
          basePart = basePart.replace(/:/g, '\\:')
        }
        const indexPart = part.substring(part.indexOf('['))

        // Handle multiple indices
        const indices = indexPart.split(']').slice(0, -1).map(i => i.replace(/^\[|\]$/g, ''))

        for (const idx of indices) {
          try {
            // Handle numeric indices
            if (/^\d+$/.test(idx)) {
              const index = Number.parseInt(idx, 10) - 1
              basePart += `:nth-of-type(${index + 1})`
            } else if (idx === 'last()') {
              // Handle last() function
              basePart += ':last-of-type'
            } else if (idx.includes('position()')) {
              // Handle position() functions
              if (idx.includes('>1')) {
                basePart += ':nth-of-type(n+2)'
              }
            }
          } catch (error) {
            continue
          }
        }

        cssParts.push(basePart)
      } else {
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
   * @param includeDynamicAttributes - Whether to include dynamic attributes (data-id, data-qa, etc.) in the selector
   * @returns A valid CSS selector string
   */
  static enhancedCssSelectorForElement(element: DOMElementNode, includeDynamicAttributes: boolean = true): string {
    try {
      // Get base selector from XPath
      let cssSelector = this.convertSimpleXPathToCssSelector(element.xpath)

      // Handle class attributes
      if ('class' in element.attributes && element.attributes.class && includeDynamicAttributes) {
        // Define a regex pattern for valid class names in CSS
        const validClassNamePattern = /^[a-z_][\w-]*$/i

        // Iterate through the class attribute values
        const classes = element.attributes.class.split(' ')
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
      for (const [attribute, value] of Object.entries(element.attributes)) {
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
        const safeAttribute = attribute.replace(/:/g, '\\:')

        // Handle different value cases
        if (value === '') {
          cssSelector += `[${safeAttribute}]`
        } else if (['"', '\'', '<', '>', '`', '\n', '\r', '\t'].some(char => value.includes(char))) {
          // Use contains for values with special characters
          // For newline-containing text, only use the part before the newline
          let collapsedValue = value.split('\n')[0]
          // Regex-substitute *any* whitespace with a single space, then strip.
          collapsedValue = collapsedValue.replace(/\s+/g, ' ').trim()
          // Escape embedded double-quotes.
          const safeValue = collapsedValue.replace(/"/g, '\\"')
          cssSelector += `[${safeAttribute}*="${safeValue}"]`
        } else {
          cssSelector += `[${safeAttribute}="${value}"]`
        }
      }

      return cssSelector
    } catch {
      // Fallback to a more basic selector if something goes wrong
      const tagName = element.tagName || '*'
      return `${tagName}[highlight_index='${element.highlightIndex}']`
    }
  }

  /**
   * Checks if an element is visible on the page.
   * We use our own implementation instead of relying solely on Playwright's is_visible() because
   * of edge cases with CSS frameworks like Tailwind. When elements use Tailwind's 'hidden' class,
   * the computed style may return display as '' (empty string) instead of 'none', causing Playwright
   * to incorrectly consider hidden elements as visible. By additionally checking the bounding box
   * dimensions, we catch elements that have zero width/height regardless of how they were hidden.
   */
  @requireInitialization
  @timeExecutionAsync('--is_visible')
  async isVisible(element: ElementHandle): Promise<boolean> {
    const isHidden = await element.isHidden()
    const bbox = await element.boundingBox()

    return !isHidden && bbox !== null && bbox.width > 0 && bbox.height > 0
  }

  @requireInitialization
  @timeExecutionAsync('--getLocateElement')
  async getLocateElement(element: DOMElementNode): Promise<ElementHandle | null> {
    const page = await this.getCurrentPage()
    let currentFrame: Page | FrameLocator = page

    // Start with the target element and collect all parents
    const parents: DOMElementNode[] = []
    let current = element
    while (current.parent) {
      const parent = current.parent
      parents.push(parent)
      current = parent
    }

    // Reverse the parents list to process from top to bottom
    parents.reverse()

    // Process all iframe parents in sequence
    const iframes = parents.filter(item => item.tagName === 'iframe')
    for (const parent of iframes) {
      const cssSelector = BrowserSession.enhancedCssSelectorForElement(
        parent,
        this.browserProfile.includeDynamicAttributes,
      )
      currentFrame = currentFrame.frameLocator(cssSelector)
    }

    const cssSelector = BrowserSession.enhancedCssSelectorForElement(
      element,
      this.browserProfile.includeDynamicAttributes,
    )

    try {
      if ('first' in currentFrame) {
        const elementHandle = await currentFrame.locator(cssSelector).elementHandle()
        return elementHandle
      } else {
        // Try to scroll into view if hidden
        const elementHandle = await currentFrame.$(cssSelector)
        if (elementHandle) {
          const isVisible = await this.isVisible(elementHandle)
          if (isVisible) {
            await elementHandle.scrollIntoViewIfNeeded()
          }
          return elementHandle
        }
        return null
      }
    } catch (error: any) {
      console.error(`❌  Failed to locate element: ${error.message}`)
      return null
    }
  }

  /**
   * Locates an element on the page using the provided XPath.
   */
  @requireInitialization
  @timeExecutionAsync('--getLocateElementByXpath')
  async getLocateElementByXpath(xpath: string): Promise<ElementHandle | null> {
    const page = await this.getCurrentPage()

    try {
      // Use XPath to locate the element
      const elementHandle = await page.$(`xpath=${xpath}`)
      if (elementHandle) {
        const isVisible = await this.isVisible(elementHandle)
        if (isVisible) {
          await elementHandle.scrollIntoViewIfNeeded()
        }
        return elementHandle
      }
      return null
    } catch (error: any) {
      console.error(`❌  Failed to locate element by XPath ${xpath}: ${error.message}`)
      return null
    }
  }

  /**
   * Locates an element on the page using the provided CSS selector.
   */
  @requireInitialization
  @timeExecutionAsync('--getLocateElementByCssSelector')
  async getLocateElementByCssSelector(cssSelector: string): Promise<ElementHandle | null> {
    const page = await this.getCurrentPage()

    try {
      // Use CSS selector to locate the element
      const elementHandle = await page.$(cssSelector)
      if (elementHandle) {
        const isVisible = await this.isVisible(elementHandle)
        if (isVisible) {
          await elementHandle.scrollIntoViewIfNeeded()
        }
        return elementHandle
      }
      return null
    } catch (error: any) {
      console.error(`❌  Failed to locate element by CSS selector ${cssSelector}: ${error.message}`)
      return null
    }
  }

  /**
   * Locates an element on the page using the provided text.
   * If `nth` is provided, it returns the nth matching element (0-based).
   * If `element_type` is provided, filters by tag name (e.g., 'button', 'span').
   */
  @requireInitialization
  @timeExecutionAsync('--getLocateElementByText')
  async getLocateElementByText(
    text: string,
    nth: number = 0,
    elementType?: string,
  ): Promise<ElementHandle | null> {
    const page = await this.getCurrentPage()
    try {
      // handle also specific element type or use any type.
      const selector = `${elementType || '*'}:text("${text}")`
      const elements = await page.$$(selector)
      // considering only visible elements
      const visibleElements = []
      for (const el of elements) {
        if (await this.isVisible(el)) {
          visibleElements.push(el)
        }
      }

      if (visibleElements.length === 0) {
        console.error(`No visible element with text '${text}' found.`)
        return null
      }

      let elementHandle: ElementHandle
      if (nth !== null) {
        if (nth >= 0 && nth < visibleElements.length) {
          elementHandle = visibleElements[nth]
        } else {
          console.error(`Visible element with text '${text}' not found at index ${nth}.`)
          return null
        }
      } else {
        elementHandle = visibleElements[0]
      }

      const isVisible = await this.isVisible(elementHandle)
      if (isVisible) {
        await elementHandle.scrollIntoViewIfNeeded()
      }
      return elementHandle
    } catch (error: any) {
      console.error(`❌  Failed to locate element by text '${text}': ${error.message}`)
      return null
    }
  }

  @requireInitialization
  @timeExecutionAsync('--inputTextElementNode')
  async inputTextElementNode(elementNode: DOMElementNode, text: string): Promise<void> {
    /**
     * Input text into an element with proper error handling and state management.
     * Handles different types of input fields and ensures proper element state before input.
     */
    try {
      // Highlight before typing
      // if elementNode.highlightIndex is not None:
      //     await this.updateState(focusElement=elementNode.highlightIndex)

      const elementHandle = await this.getLocateElement(elementNode)

      if (elementHandle === null) {
        throw new BrowserError(`Element: ${JSON.stringify(elementNode)} not found`)
      }

      // Ensure element is ready for input
      try {
        await elementHandle.waitForElementState('stable', { timeout: 1000 })
        const isVisible = await this.isVisible(elementHandle)
        if (isVisible) {
          await elementHandle.scrollIntoViewIfNeeded({ timeout: 1000 })
        }
      } catch (error) {
        // Continue if stabilization fails
      }

      // Get element properties to determine input method
      const tagHandle = await elementHandle.getProperty('tagName')
      const tagName = (await tagHandle.jsonValue() as string).toLowerCase()
      const isContenteditableHandle = await elementHandle.getProperty('isContentEditable')
      const readonlyHandle = await elementHandle.getProperty('readOnly')
      const disabledHandle = await elementHandle.getProperty('disabled')

      const readonly = readonlyHandle ? await readonlyHandle.jsonValue() as boolean : false
      const disabled = disabledHandle ? await disabledHandle.jsonValue() as boolean : false

      // always click the element first to make sure it's in the focus
      await elementHandle.click()
      await sleep(100)

      try {
        const isContenteditable = await isContenteditableHandle.jsonValue() as boolean
        if ((isContenteditable || tagName === 'input') && !(readonly || disabled)) {
          await elementHandle.evaluate((el: HTMLInputElement) => {
            el.textContent = ''
            el.value = ''
          })
          await elementHandle.type(text, { delay: 5 })
        } else {
          await elementHandle.fill(text)
        }
      } catch (error) {
        // last resort fallback, assume it's already focused after we clicked on it,
        // just simulate keypresses on the entire page
        const page = await this.getCurrentPage()
        await page.keyboard.type(text)
      }
    } catch (error: any) {
      console.debug(`❌  Failed to input text into element: ${JSON.stringify(elementNode)}. Error: ${error.message}`)
      throw new BrowserError(`Failed to input text into index ${elementNode.highlightIndex}`)
    }
  }

  @requireInitialization
  @timeExecutionAsync('--switchToTab')
  async switchToTab(pageId: number): Promise<Page> {
    /** Switch to a specific tab by its page_id (aka tab index exposed to LLM) */
    if (!this.browserContext) {
      throw new Error('Browser context is not set')
    }
    const pages = this.browserContext.pages()

    if (pageId >= pages.length) {
      throw new BrowserError(`No tab found with page_id: ${pageId}`)
    }

    const page = pages[pageId]

    // Check if the tab's URL is allowed before switching
    if (!this.isUrlAllowed(page.url())) {
      throw new BrowserError(`Cannot switch to tab with non-allowed URL: ${page.url()}`)
    }

    // Update both tab references - agent wants this tab, and it's now in the foreground
    this.agentCurrentPage = page
    this.humanCurrentPage = page

    // Bring tab to front and wait for it to load
    await page.bringToFront()
    await page.waitForLoadState()

    // Set the viewport size for the tab
    if (this.browserProfile.viewport) {
      await page.setViewportSize(this.browserProfile.viewport)
    }

    return page
  }

  // ...existing code...

  @timeExecutionAsync('--createNewTab')
  async createNewTab(url?: string): Promise<Page> {
    /** Create a new tab and optionally navigate to a URL */

    if (url && !this.isUrlAllowed(url)) {
      throw new BrowserError(`Cannot create new tab with non-allowed URL: ${url}`)
    }

    const newPage = await this.browserContext!.newPage()

    // Update agent tab reference
    this.agentCurrentPage = newPage

    // Update human tab reference if there is no human tab yet
    if (!this.humanCurrentPage || this.humanCurrentPage.isClosed()) {
      this.humanCurrentPage = newPage
    }

    await newPage.waitForLoadState()

    // Set the viewport size for the new tab
    if (this.browserProfile.viewport) {
      await newPage.setViewportSize(this.browserProfile.viewport)
    }

    if (url) {
      await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })
      await this.waitForPageAndFramesLoad(1)
    }

    if (!this.humanCurrentPage) {
      throw new Error('humanCurrentPage is null')
    }
    if (!this.agentCurrentPage) {
      throw new Error('agentCurrentPage is null')
    }
    // if url:  // sometimes this does not pass because JS or HTTP redirects the page really fast
    //     assert this.agentCurrentPage.url() === url
    // else:
    //     assert this.agentCurrentPage.url() === 'about:blank'

    // if there are any unused about:blank tabs after we open a new tab, close them to clean up unused tabs
    for (const page of this.browserContext!.pages()) {
      if (page.url() === 'about:blank' && page !== this.agentCurrentPage) {
        await page.close()
        this.humanCurrentPage = ( // in case we just closed the human's tab, fix the refs
          this.humanCurrentPage.isClosed() ? this.agentCurrentPage : this.humanCurrentPage
        )
      }
    }

    return newPage
  }

  // region - Helper methods for easier access to the DOM

  @requireInitialization
  async getSelectorMap(): Promise<SelectorMap> {
    if (!this.cachedBrowserStateSummary) {
      return {}
    }
    return this.cachedBrowserStateSummary.selectorMap
  }

  @requireInitialization
  async getElementByIndex(index: number): Promise<ElementHandle | null> {
    const selectorMap = await this.getSelectorMap()
    const elementHandle = await this.getLocateElement(selectorMap[index])
    return elementHandle
  }

  /**
   * Find a file upload element related to the element at the given index:
   * - Check if the element itself is a file input
   * - Check if it's a label pointing to a file input
   * - Recursively search children for file inputs
   * - Check siblings for file inputs
   *
   * Args:
   *     index: The index of the candidate element (could be a file input, label, or parent element)
   *
   * Returns:
   *     The DOM element for the file input if found, None otherwise
   */
  @requireInitialization
  async findFileUploadElementByIndex(index: number): Promise<DOMElementNode | null> {
    try {
      const selectorMap = await this.getSelectorMap()
      if (!(index in selectorMap)) {
        return null
      }

      const candidateElement = selectorMap[index]

      function isFileInput(node: DOMElementNode): boolean {
        return node instanceof DOMElementNode
          && node.tagName === 'input'
          && node.attributes.type === 'file'
      }

      function findElementById(node: DOMElementNode, elementId: string): DOMElementNode | null {
        if (node instanceof DOMElementNode) {
          if (node.attributes.id === elementId) {
            return node
          }
          for (const child of node.children) {
            const result = findElementById(child as DOMElementNode, elementId)
            if (result) {
              return result
            }
          }
        }
        return null
      }

      function getRoot(node: DOMElementNode): DOMElementNode {
        let root = node
        while (root.parent) {
          root = root.parent
        }
        return root
      }

      // Recursively search for file input in node and its children
      function findFileInputRecursive(
        node: DOMElementNode,
        maxDepth: number = 3,
        currentDepth: number = 0,
      ): DOMElementNode | null {
        if (currentDepth > maxDepth || !(node instanceof DOMElementNode)) {
          return null
        }

        // Check current element
        if (isFileInput(node)) {
          return node
        }

        // Recursively check children
        if (node.children && currentDepth < maxDepth) {
          for (const child of node.children) {
            if (child instanceof DOMElementNode) {
              const result = findFileInputRecursive(child, maxDepth, currentDepth + 1)
              if (result) {
                return result
              }
            }
          }
        }
        return null
      }

      // Check if current element is a file input
      if (isFileInput(candidateElement)) {
        return candidateElement
      }

      // Check if it's a label pointing to a file input
      if (candidateElement.tagName === 'label' && candidateElement.attributes.for) {
        const inputId = candidateElement.attributes.for
        const rootElement = getRoot(candidateElement)

        const targetInput = findElementById(rootElement, inputId)
        if (targetInput && isFileInput(targetInput)) {
          return targetInput
        }
      }

      // Recursively check children
      const childResult = findFileInputRecursive(candidateElement)
      if (childResult) {
        return childResult
      }

      // Check siblings
      if (candidateElement.parent) {
        for (const sibling of candidateElement.parent.children) {
          if (sibling !== candidateElement && sibling instanceof DOMElementNode) {
            if (isFileInput(sibling)) {
              return sibling
            }
          }
        }
      }
      return null
    } catch (error: any) {
      console.debug(`Error in findFileUploadElementByIndex: ${error.message}`)
      return null
    }
  }

  /**
   * Get scroll position information for the current page.
   */
  @requireInitialization
  async getScrollInfo(page: Page) {
    const scrollY = await page.evaluate(() => window.scrollY)
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight)
    const pixelsAbove = scrollY
    const pixelsBelow = totalHeight - (scrollY + viewportHeight)
    return { pixelsAbove, pixelsBelow }
  }

  /**
   * Scroll the element that truly owns vertical scroll.Starts at the focused node ➜ climbs to the first big,
   * scroll-enabled ancestor otherwise picks the first scrollable element or the root, then calls `element.scrollBy` (or `window.scrollBy` for the root) by the supplied pixel value.
   */
  @requireInitialization
  async scrollContainer(pixels: number): Promise<void> {
    // An element can *really* scroll if: overflow-y is auto|scroll|overlay, it has more content than fits, its own viewport is not a postage stamp (more than 50 % of window).

    const page = await this.getCurrentPage()
    await page.evaluate((dy) => {
      const bigEnough = (el: Element) => el.clientHeight >= window.innerHeight * 0.5
      const canScroll = (el: Element) =>
        el
        && /auto|scroll|overlay/.test(getComputedStyle(el).overflowY)
        && el.scrollHeight > el.clientHeight
        && bigEnough(el)

      let el = document.activeElement
      while (el && !canScroll(el) && el !== document.body) {
        el = el.parentElement
      }

      el = canScroll(el!)
        ? el
        : [...document.querySelectorAll('*')].find(canScroll)
          || document.scrollingElement
          || document.documentElement

      if (el === document.scrollingElement
        || el === document.documentElement
        || el === document.body) {
        window.scrollBy(0, dy)
      } else {
        el!.scrollBy({ top: dy, behavior: 'auto' })
      }
    }, pixels)
  }

  // --- DVD Screensaver Loading Animation Helper ---
  /**
   * Injects a DVD screensaver-style bouncing logo loading animation overlay into the given Playwright Page.
   * This is used to visually indicate that the browser is setting up or waiting.
   */
  async showDvdScreensaverLoadingAnimation(page: Page): Promise<void> {
    await page.evaluate(() => {
      document.title = 'Setting up...'

      // Create the main overlay
      const loadingOverlay = document.createElement('div')
      loadingOverlay.id = 'pretty-loading-animation'
      loadingOverlay.style.position = 'fixed'
      loadingOverlay.style.top = '0'
      loadingOverlay.style.left = '0'
      loadingOverlay.style.width = '100vw'
      loadingOverlay.style.height = '100vh'
      loadingOverlay.style.background = '#000'
      loadingOverlay.style.zIndex = '99999'
      loadingOverlay.style.overflow = 'hidden'

      // Create the image element
      const img = document.createElement('img')
      img.src = 'https://github.com/browser-use.png'
      img.alt = 'Browser-Use'
      img.style.width = '200px'
      img.style.height = 'auto'
      img.style.position = 'absolute'
      img.style.left = '0px'
      img.style.top = '0px'
      img.style.zIndex = '2'
      img.style.opacity = '0.8'

      loadingOverlay.appendChild(img)
      document.body.appendChild(loadingOverlay)

      // DVD screensaver bounce logic
      let x = Math.random() * (window.innerWidth - 300)
      let y = Math.random() * (window.innerHeight - 300)
      let dx = 1.2 + Math.random() * 0.4 // px per frame
      let dy = 1.2 + Math.random() * 0.4
      // Randomize direction
      if (Math.random() > 0.5)
        dx = -dx
      if (Math.random() > 0.5)
        dy = -dy

      function animate() {
        const imgWidth = img.offsetWidth || 300
        const imgHeight = img.offsetHeight || 300
        x += dx
        y += dy

        if (x <= 0) {
          x = 0
          dx = Math.abs(dx)
        } else if (x + imgWidth >= window.innerWidth) {
          x = window.innerWidth - imgWidth
          dx = -Math.abs(dx)
        }
        if (y <= 0) {
          y = 0
          dy = Math.abs(dy)
        } else if (y + imgHeight >= window.innerHeight) {
          y = window.innerHeight - imgHeight
          dy = -Math.abs(dy)
        }

        img.style.left = `${x}px`
        img.style.top = `${y}px`

        requestAnimationFrame(animate)
      }
      animate()

      // Responsive: update bounds on resize
      window.addEventListener('resize', () => {
        x = Math.min(x, window.innerWidth - img.offsetWidth)
        y = Math.min(y, window.innerHeight - img.offsetHeight)
      })

      // Add a little CSS for smoothness
      const style = document.createElement('style')
      style.innerHTML = `
            #pretty-loading-animation {
                /*backdrop-filter: blur(2px) brightness(0.9);*/
            }
            #pretty-loading-animation img {
                user-select: none;
                pointer-events: none;
            }
        `
      document.head.appendChild(style)
    })
  }
}
