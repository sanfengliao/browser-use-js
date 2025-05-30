import * as fs from 'fs';
import * as path from 'path';
import { chromium, Browser, BrowserContext, ElementHandle, FrameLocator, Page, Request, Response, BrowserContextOptions } from 'playwright';


// https://github.com/microsoft/playwright/issues/35972
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';

import { BrowserProfile } from './profile';
import {
  BrowserError,
  BrowserStateSummary,
  TabInfo,
  URLNotAllowedError
} from './views';
import { ClickableElementProcessor } from '../dom/clickable_element_processor/service';
import { DomService } from '../dom/service';
import { DOMElementNode, SelectorMap } from '../dom/views';
import { matchUrlWithDomainPattern, timeExecutionAsync, timeExecutionSync } from '../utils';
import { AnyFunction } from '@/type';
import { Logger } from '@/logger';



const logger = Logger.getLogger(import.meta.filename)


// Check if running in Docker
const IN_DOCKER = 'ty1'.includes((process.env.IN_DOCKER || 'false').toLowerCase()[0]);

let _GLOB_WARNING_SHOWN = false; // used inside _isUrlAllowed to avoid spamming the logs with the same warning multiple times

function _logGlobWarning(domain: string, glob: string): void {
  if (!_GLOB_WARNING_SHOWN) {
    console.warn(
      // glob patterns are very easy to mess up and match too many domains by accident
      // e.g. if you only need to access gmail, don't use *.google.com because an attacker could convince the agent to visit a malicious doc
      // on docs.google.com/s/some/evil/doc to set up a prompt injection attack
      `⚠️ Allowing agent to visit ${domain} based on allowed_domains=['${glob}', ...]. Set allowed_domains=['${domain}', ...] explicitly to avoid matching too many domains!`
    );
    _GLOB_WARNING_SHOWN = true;
  }
}


/**Truncate/pretty-print a URL with a maximum length, removing the protocol and www. prefix*/
function _logPrettyUrl(s: string, maxLen: number | null = 22): string {
  s = s.replace('https://', '').replace('http://', '').replace('www.', '');
  if (maxLen !== null && s.length > maxLen) {
    return s.slice(0, maxLen) + '…';
  }
  return s;
}

/**Pretty-print a path, shorten home dir to ~ and cwd to .*/
function _logPrettyPath(pathStr: string): string {
  return (pathStr || '').replace(process.env.HOME || '', '~').replace(process.cwd(), '.');
}

function requireInitialization<T extends AnyFunction>(
  originalMethod: T,
  context: ClassMethodDecoratorContext,
): T {
  /**decorator for BrowserSession methods to require the BrowserSession be already active*/
  if (context.kind !== 'method') {
    throw new Error('timeExecutionSync only works on methods')
  }


  return function (this: BrowserSession, ...args: Parameters<T>): ReturnType<T> {
    try {
      if (!this.initialized) {
        // raise RuntimeError('BrowserSession(...).start() must be called first to launch or connect to the browser')
        await this.start(); // just start it automatically if not already started
      }

      if (!this.agentCurrentPage || this.agentCurrentPage.isClosed()) {
        this.agentCurrentPage = (
          this.browserContext && this.browserContext.pages().length > 0
            ? this.browserContext.pages()[0]
            : undefined
        );
      }

      if (!this.agentCurrentPage || this.agentCurrentPage.isClosed()) {
        await this.createNewTab();
      }

      if (!this.agentCurrentPage || this.agentCurrentPage.isClosed()) {
        throw new Error('Failed to get or create a valid page');
      }

      if (!this._cachedBrowserStateSummary) {
        throw new Error('BrowserSession(...).start() must be called first to initialize the browser session');
      }

      return await originalMethod.apply(this, args);

    } catch (e: any) {
      // Check if this is a TargetClosedError or similar connection error
      if (e.message.includes('TargetClosedError') || e.message.includes('context or browser has been closed')) {
        console.debug(`Detected closed browser connection in ${context.name.toString()}, resetting connection state`);
        this._resetConnectionState();
        // Re-raise the error so the caller can handle it appropriately
        throw e;
      } else {
        // Re-raise other exceptions unchanged
        throw e;
      }
    }
  } as T
}

const DEFAULT_BROWSER_PROFILE = new BrowserProfile();

/**
 * Clickable elements hashes for the last state
 */
interface CachedClickableElementHashes {
  url: string;
  hashes: Set<string>;
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
  browserProfile: BrowserProfile = DEFAULT_BROWSER_PROFILE;

  // runtime props/state: these can be passed in as props at init, or get auto-setup by BrowserSession.start()
  /** WSS URL of the node.js playwright browser server to connect to, outputted by (await chromium.launchServer()).wsEndpoint() */
  wssUrl?: string;
  /** CDP URL of the browser to connect to, e.g. http://localhost:9222 or ws://127.0.0.1:9222/devtools/browser/387adf4c-243f-4051-a181-46798f4a46f4 */
  cdpUrl?: string;
  /** pid of a running chromium-based browser process to connect to on localhost */
  browserPid?: number;
  /** Playwright library object returned by: await (playwright or patchright).async_playwright().start() */
  playwright?: Browser;
  /** playwright Browser object to use (optional) */
  browser?: Browser;
  /** playwright BrowserContext object to use (optional) */
  browserContext?: BrowserContext;

  // runtime state: state that changes during the lifecycle of a BrowserSession(), updated by the methods below
  /** Mark BrowserSession launch/connection as already ready and skip setup (not recommended) */
  initialized: boolean = false;
  /** Foreground Page that the agent is focused on */
  agentCurrentPage?: Page; // mutated by this.createNewTab(url)
  /** Foreground Page that the human is focused on */
  humanCurrentPage?: Page; // mutated by this._setupCurrentPageChangeListeners()

  _cachedBrowserStateSummary?: BrowserStateSummary;
  private _cachedClickableElementHashes?: CachedClickableElementHashes;
  private _startLock = new Map(); // Simple lock implementation
  private startPromise?: Promise<void>

  constructor(options: Partial<BrowserSession> = {}) {
    Object.assign(this, options);
    this.applySessionOverridesToProfile();
  }

  /**Apply any extra **kwargs passed to BrowserSession(...) as config overrides on top of browser_profile*/
  private applySessionOverridesToProfile(): void {
    // In TypeScript, this would be handled differently since we don't have dynamic model fields
    // For now, we'll assume the profile is properly configured

    // Only create a copy if there are actual overrides to apply
    // This would need to be implemented based on specific requirements
  }

  /**
   * Starts the browser session by either connecting to an existing browser or launching a new one.
   * Precedence order for launching/connecting:
   * 	1. page=Page playwright object, will use its page.context as browser_context
   * 	2. browser_context=PlaywrightBrowserContext object, will use its browser
   * 	3. browser=PlaywrightBrowser object, will use its first available context
   * 	4. browser_pid=int, will connect to a local chromium-based browser via pid
   * 	5. wss_url=str, will connect to a remote playwright browser server via WSS
   * 	6. cdp_url=str, will connect to a remote chromium-based browser via CDP
   * 	7. playwright=Playwright object, will use its chromium instance to launch a new browser
   */
  async start(): Promise<BrowserSession> {
    // Simple lock implementation
    if (this.startPromise) {
      await this.startPromise
      return this;
    }

    this.startPromise = new Promise<void>(async (resolve, reject) => {
      try {
        // if we're already initialized and the connection is still valid, return the existing session state and start from scratch
        if (this.initialized && this.isConnected()) {
          resolve();
          return;
        }
        this._resetConnectionState();

        this.initialized = true; // set this first to ensure two parallel calls to start() don't clash with each other

        // apply last-minute runtime-computed options to the the browser_profile, validate profile, set up folders on disk
        this.browserProfile.prepareUserDataDir(); // create/unlock the <user_data_dir>/SingletonLock
        this.browserProfile.detectDisplayConfiguration(); // adjusts config values, must come before launch/connect

        // launch/connect to the browser:

        await this.setupBrowserViaPassedObjects();
        await this.setupBrowserViaBrowserPid();
        await this.setupBrowserViaWssUrl();
        await this.setupBrowserViaCdpUrl();
        await this.setupNewBrowserContext(); // creates a new context in existing browser or launches a new persistent context

        if (!this.browserContext) {
          throw new Error(`Failed to connect to or create a new BrowserContext for browser=${this.browser}`);
        }

        // resize the existing pages and set up foreground tab detection
        await this._setupViewports();
        await this._setupCurrentPageChangeListeners();

        resolve();
      } catch (error) {
        this.initialized = false;
        reject(error);
      }
    });

    await this.startPromise;
    this.startPromise = undefined;

    return this;
  }

  /**Shuts down the BrowserSession, killing the browser process if keep_alive=False*/
  async stop(): Promise<void> {
    this.initialized = false;

    if (this.browserProfile.keepAlive) {
      return; // nothing to do if keep_alive=True, leave the browser running
    }

    if (this.browserContext || this.browser) {
      try {
        await (this.browserContext || this.browser)?.close();
        console.info(
          `🛑 Stopped the ${this.browserProfile.channel.toLowerCase()} browser ` +
          `keep_alive=false user_data_dir=${_logPrettyPath(this.browserProfile.userDataDir || '') || "<incognito>"} cdp_url=${this.cdpUrl || this.wssUrl} pid=${this.browserPid}`
        );
        this.browserContext = undefined;
      } catch (e: any) {
        console.debug(`❌ Error closing playwright BrowserContext ${this.browserContext}: ${e.constructor.name}: ${e.message}`);
      }
    }

    // kill the chrome subprocess if we were the ones that started it
    if (this.browserPid) {
      try {
        process.kill(this.browserPid, 'SIGTERM');
        console.info(`↳ Killed browser subprocess with browser_pid=${this.browserPid} keep_alive=false`);
        this.browserPid = undefined;
      } catch (e: any) {
        if (!e.message.includes('ESRCH')) { // No such process
          console.debug(`❌ Error terminating subprocess with browser_pid=${this.browserPid}: ${e.constructor.name}: ${e.message}`);
        }
      }
    }
  }

  /**Deprecated: Provides backwards-compatibility with old class method Browser().close()*/
  async close(): Promise<void> {
    await this.stop();
  }

  /**Deprecated: Provides backwards-compatibility with old class method Browser().new_context()*/
  async newContext(): Promise<BrowserSession> {
    return this;
  }




  /**
   * Override to customize the set up of the connection to an existing browser
   * */
  async setupBrowserViaPassedObjects(): Promise<void> {
    // 1. check for a passed Page object, if present, it always takes priority, set browser_context = page.context
    this.browserContext = (this.agentCurrentPage && this.agentCurrentPage.context()) || this.browserContext || undefined;

    // 2. Check if the current browser connection is valid, if not clear the invalid objects
    if (this.browserContext) {
      try {
        // Try to access a property that would fail if the context is closed
        this.browserContext.pages();
        // Additional check: verify the browser is still connected
        if (this.browserContext.browser() && !this.browserContext.browser()?.isConnected()) {
          this.browserContext = undefined;
        }
      } catch {
        // Context is closed, clear it
        this.browserContext = undefined;
      }
    }

    // 3. if we have a browser object but it's disconnected, clear it and the context because we cant use either
    if (this.browser && !this.browser.isConnected()) {
      if (this.browserContext && (this.browserContext.browser() === this.browser)) {
        this.browserContext = undefined;
      }
      this.browser = undefined;
    }

    // 4. if we have a context now, it always takes precedence, set browser = context.browser, otherwise use the passed browser
    const browserFromContext = this.browserContext && this.browserContext.browser();
    if (browserFromContext && browserFromContext.isConnected()) {
      this.browser = browserFromContext;
    }

    if (this.browser || this.browserContext) {
      console.info(`🌎 Connected to existing user-provided browser_context: ${this.browserContext}`);
      this._setBrowserKeepAlive(true); // we connected to an existing browser, dont kill it at the end
    }
  }

  /**if browser_pid is provided, calcuclate its CDP URL by looking for --remote-debugging-port=... in its CLI args, then connect to it*/
  async setupBrowserViaBrowserPid(): Promise<void> {
    if (this.browser || this.browserContext) {
      return; // already connected to a browser
    }
    if (!this.browserPid) {
      return; // no browser_pid provided, nothing to do
    }

    // TODO: Implement this in TypeScript
    // Note: In Node.js, we'd need to use process management libraries to get process info
    // This is a simplified implementation

  }

  /**check for a passed wss_url, connect to a remote playwright browser server via WSS*/
  async setupBrowserViaWssUrl(): Promise<void> {
    if (this.browser || this.browserContext) {
      return; // already connected to a browser
    }
    if (!this.wssUrl) {
      return; // no wss_url provided, nothing to do
    }

    console.info(`🌎 Connecting to existing remote chromium playwright node.js server over WSS: ${this.wssUrl}`);
    this.browser = this.browser || await chromium.connect(this.wssUrl, this.browserProfile.kwargsForConnect());
    this._setBrowserKeepAlive(true); // we connected to an existing browser, dont kill it at the end
  }

  /**check for a passed cdp_url, connect to a remote chromium-based browser via CDP*/
  async setupBrowserViaCdpUrl(): Promise<void> {
    if (this.browser || this.browserContext) {
      return; // already connected to a browser
    }
    if (!this.cdpUrl) {
      return; // no cdp_url provided, nothing to do
    }

    console.info(`🌎 Connecting to existing remote chromium-based browser over CDP: ${this.cdpUrl}`);
    this.browser = this.browser || await chromium.connectOverCDP(this.cdpUrl, this.browserProfile.kwargsForConnect());
    this._setBrowserKeepAlive(true); // we connected to an existing browser, dont kill it at the end
  }

  /**Launch a new browser and browser_context*/
  async setupNewBrowserContext(): Promise<void> {
    // if we have a browser object but no browser_context, use the first context discovered or make a new one
    if (this.browser && !this.browserContext) {
      const contexts = this.browser.contexts();
      if (contexts.length > 0) {
        this.browserContext = contexts[0];
        console.info(`🌎 Using first browser_context available in existing browser: ${this.browserContext}`);
      } else {
        this.browserContext = await this.browser.newContext(this.browserProfile.kwargsForNewContext());
        const storageInfo = this.browserProfile.storageState
          ? ` + loaded storage_state=${Object.keys(this.browserProfile.storageState).length} cookies`
          : '';
        console.info(`🌎 Created new empty browser_context in existing browser${storageInfo}: ${this.browserContext}`);
      }
    }

    // if we still have no browser_context by now, launch a new local one using launch_persistent_context()
    if (!this.browserContext) {
      console.info(
        `🌎 Launching local browser ` +
        `driver=${this.playwright?.constructor.name || 'playwright'} channel=${this.browserProfile.channel.toLowerCase()} ` +
        `user_data_dir=${_logPrettyPath(this.browserProfile.userDataDir || '') || "<incognito>"}`
      );

      if (!this.browserProfile.userDataDir) {
        // if no user_data_dir is provided, launch an incognito context with no persistent user_data_dir
        this.browser = this.browser || await chromium.launch(this.browserProfile.kwargsForLaunch());
        this.browserContext = await this.browser.newContext();
      } else {
        // user data dir was provided, prepare it for use
        this.browserProfile.prepareUserDataDir();

        // if a user_data_dir is provided, launch a persistent context with that user_data_dir
        this.browserContext = await chromium.launchPersistentContext(
          this.browserProfile.userDataDir,
          this.browserProfile.kwargsForLaunchPersistentContext()
        );
      }
    }

    // Only restore browser from context if it's connected, otherwise keep it None to force new launch
    const browserFromContext = this.browserContext && this.browserContext.browser();
    if (browserFromContext && browserFromContext.isConnected()) {
      this.browser = browserFromContext;
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
    //         console.debug(
    //             ` ↳ Spawned browser subprocess: browser_pid=${this.browserPid} ${newChromeProcs[0].cmdline().join(' ')}`
    //         );
    //         this._setBrowserKeepAlive(false); // close the browser at the end because we launched it
    //     }
    // } catch (e) {
    //     console.debug(`❌ Error trying to find child chrome processes after launching new browser: ${e.constructor.name}: ${e.message}`);
    // }

    if (this.browser) {
      const connectionMethod = this.wssUrl ? 'WSS' : (this.cdpUrl && !this.browserPid) ? 'CDP' : 'Local';
      if (!this.browser.isConnected()) {
        throw new Error(
          `Browser is not connected, did the browser process crash or get killed? (connection method: ${connectionMethod})`
        );
      }
      console.debug(
        `🌎 ${connectionMethod} browser connected: v${this.browser.version()} ${this.cdpUrl || this.wssUrl || this.browserProfile.executablePath || "(playwright)"}`
      );
    }

    if (!this.browserContext) {
      throw new Error(`Failed to create a playwright BrowserContext ${this.browserContext} for browser=${this.browser}`);
    }

    // Expose anti-detection scripts
    await this.browserContext.addInitScript(() => {
      // check to make sure we're not inside the PDF viewer
      window.isPdfViewer = !!document?.body?.querySelector('body > embed[type="application/pdf"][width="100%"]')
      if (!window.isPdfViewer) {

        // Permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission } as PermissionStatus) :
            originalQuery(parameters)
        );
        (() => {
          if (window._eventListenerTrackerInitialized) return;
          window._eventListenerTrackerInitialized = true;

          const originalAddEventListener = EventTarget.prototype.addEventListener;
          const eventListenersMap = new WeakMap<EventTarget, Array<{ type: string, listener: Function, listenerPreview: string, options: AddEventListenerOptions | boolean | undefined }>>();

          EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (typeof listener === "function") {
              let listeners = eventListenersMap.get(this);
              if (!listeners) {
                listeners = [];
                eventListenersMap.set(this, listeners);
              }

              listeners.push({
                type,
                listener,
                listenerPreview: listener.toString().slice(0, 100),
                options
              });
            }

            return originalAddEventListener.call(this, type, listener, options);
          };

          window.getEventListenersForNode = (node) => {
            const listeners = eventListenersMap.get(node) || [];
            return listeners.map(({ type, listenerPreview, options }) => ({
              type,
              listenerPreview,
              options
            }));
          };
        })();
      }
    });

    // Load cookies from file if specified
    await this.loadCookiesFromFile();
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
  async _setupCurrentPageChangeListeners(): Promise<void> {

    if (!this.browserContext) {
      throw new Error('BrowserContext object is not set');
    }

    const pages = this.browserContext.pages();
    let foregroundPage: Page | null = null;

    if (pages.length > 0) {
      foregroundPage = pages[0];
      console.debug(
        `📜 Found ${pages.length} existing tabs in browser, agent will start focused on Tab [${pages.indexOf(foregroundPage)}]: ${foregroundPage.url()}`
      );
    } else {
      foregroundPage = await this.browserContext.newPage();
      console.debug('➕ Opened new tab in empty browser context...');
    }

    this.agentCurrentPage = this.agentCurrentPage || foregroundPage;
    this.humanCurrentPage = this.humanCurrentPage || foregroundPage;

    const _BrowserUseonTabVisibilityChange = (source: { page: Page }) => {
      /**hook callback fired when init script injected into a page detects a focus event*/
      const newPage = source.page;

      // Update human foreground tab state
      const oldForeground = this.humanCurrentPage;
      if (!this.browserContext || !oldForeground) {
        throw new Error('BrowserContext or old foreground page is not set');
      }

      const oldTabIdx = this.browserContext.pages().indexOf(oldForeground);
      this.humanCurrentPage = newPage;
      const newTabIdx = this.browserContext.pages().indexOf(newPage);

      // Log before and after for debugging
      const oldUrl = oldForeground ? oldForeground.url() : 'about:blank';
      const newUrl = newPage ? newPage.url() : 'about:blank';
      const agentUrl = this.agentCurrentPage ? this.agentCurrentPage.url() : 'about:blank';
      const agentTabIdx = this.browserContext.pages().indexOf(this.agentCurrentPage!);

      if (oldUrl !== newUrl) {
        console.info(
          `👁️ Foregound tab changed by human from [${oldTabIdx}]${_logPrettyUrl(oldUrl)} ` +
          `➡️ [${newTabIdx}]${_logPrettyUrl(newUrl)} ` +
          `(agent will stay on [${agentTabIdx}]${_logPrettyUrl(agentUrl)})`
        );
      }
    };

    try {
      await this.browserContext.exposeBinding('_BrowserUseonTabVisibilityChange', _BrowserUseonTabVisibilityChange);
    } catch (e: any) {
      if (e.message.includes('Function "_BrowserUseonTabVisibilityChange" has been already registered')) {
        console.debug(
          '⚠️ Function "_BrowserUseonTabVisibilityChange" has been already registered, ' +
          'this is likely because the browser was already started with an existing BrowserSession()'
        );
      } else {
        throw e;
      }
    }

    const updateTabFocusScript = () => {
      // --- Method 1: visibilitychange event (unfortunately *all* tabs are always marked visible by playwright, usually does not fire) ---
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          await window._BrowserUseonTabVisibilityChange({ source: 'visibilitychange', url: document.location.href });
          console.log('BrowserUse Foreground tab change event fired', document.location.href);
        }
      });

      // --- Method 2: focus/blur events, most reliable method for headful browsers ---
      window.addEventListener('focus', async () => {
        await window._BrowserUseonTabVisibilityChange({ source: 'focus', url: document.location.href });
        console.log('BrowserUse Foreground tab change event fired', document.location.href);
      });
    }

    await this.browserContext.addInitScript(updateTabFocusScript);

    // Set up visibility listeners for all existing tabs
    for (const page of this.browserContext.pages()) {
      try {
        await page.evaluate(updateTabFocusScript);
      } catch (e: any) {
        const pageIdx = this.browserContext.pages().indexOf(page);
        console.debug(
          `⚠️ Failed to add visibility listener to existing tab, is it crashed or ignoring CDP commands?: [${pageIdx}]${page.url()}: ${e.constructor.name}: ${e.message}`
        );
      }
    }
  }

  /**
   * Resize any existing page viewports to match the configured size
   * @returns 
   */
  async _setupViewports(): Promise<void> {
    // log the viewport settings to terminal
    const viewport = this.browserProfile.viewport;
    console.debug(
      '📐 Setting up viewport: ' +
      `headless=${this.browserProfile.headless} ` +
      (this.browserProfile.windowSize
        ? `window=${this.browserProfile.windowSize.width}x${this.browserProfile.windowSize.height}px `
        : '(no window) ') +
      (this.browserProfile.screen
        ? `screen=${this.browserProfile.screen.width}x${this.browserProfile.screen.height}px `
        : '') +
      (viewport ? `viewport=${viewport.width}x${viewport.height}px ` : '(no viewport) ') +
      `device_scale_factor=${this.browserProfile.deviceScaleFactor || 1.0} ` +
      `is_mobile=${this.browserProfile.isMobile} ` +
      (this.browserProfile.colorScheme ? `color_scheme=${this.browserProfile.colorScheme} ` : '') +
      (this.browserProfile.locale ? `locale=${this.browserProfile.locale} ` : '') +
      (this.browserProfile.timezoneId ? `timezone_id=${this.browserProfile.timezoneId} ` : '') +
      (this.browserProfile.geolocation ? `geolocation=${JSON.stringify(this.browserProfile.geolocation)} ` : '') +
      `permissions=${(this.browserProfile.permissions || ["<none>"]).join(",")} `
    );

    // if we have any viewport settings in the profile, make sure to apply them to the entire browser_context as defaults
    if (this.browserProfile.permissions) {
      try {
        await this.browserContext!.grantPermissions(this.browserProfile.permissions);
      } catch (e: any) {
        console.warn(
          `⚠️ Failed to grant browser permissions ${this.browserProfile.permissions}: ${e.constructor.name}: ${e.message}`
        );
      }
    }

    try {
      if (this.browserProfile.defaultTimeout) {
        this.browserContext!.setDefaultTimeout(this.browserProfile.defaultTimeout);
      }
      if (this.browserProfile.defaultNavigationTimeout) {
        this.browserContext!.setDefaultNavigationTimeout(this.browserProfile.defaultNavigationTimeout);
      }
    } catch (e: any) {
      console.warn(
        `⚠️ Failed to set playwright timeout settings ` +
        `cdp_api=${this.browserProfile.defaultTimeout} ` +
        `navigation=${this.browserProfile.defaultNavigationTimeout}: ${e.constructor.name}: ${e.message}`
      );
    }

    try {
      if (this.browserProfile.extraHttpHeaders) {
        await this.browserContext!.setExtraHTTPHeaders(this.browserProfile.extraHttpHeaders);
      }
    } catch (e: any) {
      console.warn(
        `⚠️ Failed to setup playwright extra_http_headers: ${e.constructor.name}: ${e.message}`
      ); // dont print the secret header contents in the logs!
    }

    try {
      if (this.browserProfile.geolocation) {
        await this.browserContext!.setGeolocation(this.browserProfile.geolocation);
      }
    } catch (e: any) {
      console.warn(`⚠️ Failed to update browser geolocation ${JSON.stringify(this.browserProfile.geolocation)}: ${e.constructor.name}: ${e.message}`);
    }

    let page: Page | null = null;

    for (page of this.browserContext!.pages()) {
      // apply viewport size settings to any existing pages
      if (viewport) {
        await page.setViewportSize(viewport);
      }

      // show browser-use dvd screensaver-style bouncing loading animation on any about:blank pages
      if (page.url() === 'about:blank') {
        await this._showDvdScreensaverLoadingAnimation(page);
      }
    }

    page = page || (await this.browserContext!.newPage());

    if ((!viewport) && (this.browserProfile.windowSize) && !this.browserProfile.headless) {
      // attempt to resize the actual browser window
      // cdp api: https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setWindowBounds
      try {
        const cdpSession = await page.context().newCDPSession(page);
        const windowIdResult = await cdpSession.send('Browser.getWindowForTarget');
        await cdpSession.send('Browser.setWindowBounds', {
          windowId: windowIdResult.windowId,
          bounds: {
            ...this.browserProfile.windowSize,
            windowState: 'normal', // Ensure window is not minimized/maximized
          },
        });
        await cdpSession.detach();
      } catch (e: any) {
        const logSize = (size: any) => `${size.width}x${size.height}px`;
        try {
          // fallback to javascript resize if cdp setWindowBounds fails
          await page.evaluate(
            ({
              width,
              height
            }) => { window.resizeTo(width, height) },
            {
              width: this.browserProfile.windowSize!.width,
              height: this.browserProfile.windowSize!.height
            }
          );
          return;
        } catch (e: any) {
          // ignore fallback error
        }

        console.warn(
          `⚠️ Failed to resize browser window to ${logSize(this.browserProfile.windowSize)} using CDP setWindowBounds: ${e.constructor.name}: ${e.message}`
        );
      }
    }
  }

  /**
   * set the keep_alive flag on the browser_profile, defaulting to True if keep_alive is None
   * */
  private _setBrowserKeepAlive(keepAlive?: boolean): void {
    if (this.browserProfile.keepAlive === undefined) {
      this.browserProfile.keepAlive = keepAlive;
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
      return false;
    }

    // Check if browser exists but is disconnected
    if (this.browser && !this.browser.isConnected()) {
      return false;
    }

    // Check if browser_context's browser exists but is disconnected
    if (this.browserContext.browser() && !this.browserContext.browser()!.isConnected()) {
      return false;
    }

    // Check if the browser_context itself is closed/unusable
    try {
      // Try to access a property that would fail if the context is closed
      this.browserContext.pages();
      // Additional check: try to access the browser property which might fail if context is closed
      if (this.browserContext.browser() && !this.browserContext.browser()!.isConnected()) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**Reset the browser connection state when disconnection is detected*/
  _resetConnectionState(): void {
    this.initialized = false;
    this.browser = undefined;
    this.browserContext = undefined;
    // Also clear browser_pid since the process may no longer exist
    this.browserPid = undefined;
  }

  // --- Tab management ---
  /**
   * Get the current page + ensure it's not None / closed
   * @returns The current page
   */
  async getCurrentPage(): Promise<Page> {
    if (!this.initialized) {
      await this.start();
    }

    // get-or-create the browser_context if it's not already set up
    if (!this.browserContext) {
      await this.start();
      if (!this.browserContext) {
        throw new Error('BrowserContext is not set up');
      }
    }

    // if either focused page is closed, clear it so we dont use a dead object
    if ((!this.humanCurrentPage) || this.humanCurrentPage.isClosed()) {
      this.humanCurrentPage = undefined;
    }
    if ((!this.agentCurrentPage) || this.agentCurrentPage.isClosed()) {
      this.agentCurrentPage = undefined;
    }

    // if either one is None, fallback to using the other one for both
    this.agentCurrentPage = this.agentCurrentPage || this.humanCurrentPage || undefined;
    this.humanCurrentPage = this.humanCurrentPage || this.agentCurrentPage || undefined;

    // if both are still None, fallback to using the first open tab we can find
    if (this.agentCurrentPage === undefined) {
      const pages = this.browserContext.pages();
      if (pages.length > 0) {
        const firstAvailableTab = pages[0];
        this.agentCurrentPage = firstAvailableTab;
        this.humanCurrentPage = firstAvailableTab;
      } else {
        // if all tabs are closed, open a new one
        const newTab = await this.createNewTab();
        this.agentCurrentPage = newTab;
        this.humanCurrentPage = newTab;
      }
    }

    if (!this.agentCurrentPage) {
      throw new Error('Failed to find or create a new page for the agent');
    }
    if (!this.humanCurrentPage) {
      throw new Error('Failed to find or create a new page for the human');
    }

    return this.agentCurrentPage;
  }

  get tabs(): Page[] {
    if (!this.browserContext) {
      return [];
    }
    return this.browserContext.pages();
  }

  @requireInitialization
  async newTab(url?: string): Promise<Page> {
    return await this.createNewTab(url);
  }

  @requireInitialization
  async switchTab(tabIndex: number): Promise<Page> {
    const pages = this.browserContext!.pages();
    if (!pages || tabIndex >= pages.length) {
      throw new Error('Tab index out of range');
    }
    const page = pages[tabIndex];
    this.agentCurrentPage = page;
    return page;
  }

  @requireInitialization
  async waitForElement(selector: string, timeout: number = 10000): Promise<void> {
    const page = await this.getCurrentPage();
    await page.waitForSelector(selector, { state: 'visible', timeout });
  }

  /**
   * Removes all highlight overlays and labels created by the highlightElement function.
   * Handles cases where the page might be closed or inaccessible.
   */
  @requireInitialization
  @timeExecutionAsync('--remove_highlights')
  async removeHighlights(): Promise<void> {
    const page = await this.getCurrentPage();
    try {
      await page.evaluate(() => {
        try {
          // Remove the highlight container and all its contents
          const container = document.getElementById('playwright-highlight-container');
          if (container) {
            container.remove();
          }

          // Remove highlight attributes from elements
          const highlightedElements = document.querySelectorAll('[browser-user-highlight-id^="playwright-highlight-"]');
          highlightedElements.forEach(el => {
            el.removeAttribute('browser-user-highlight-id');
          });
        } catch (e) {
          console.error('Failed to remove highlights:', e);
        }
      });
    } catch (e: any) {
      console.debug(`⚠  Failed to remove highlights (this is usually ok): ${e.constructor.name}: ${e.message}`);
      // Don't raise the error since this is not critical functionality
    }
  }

  /**
   * Get DOM element by index.
   */
  @requireInitialization
  async getDomElementByIndex(index: number): Promise<any | null> {
    const selectorMap = await this.getSelectorMap();
    return selectorMap.get(index);
  }

  /**
   * Optimized method to click an element using xpath.
   */
  @requireInitialization
  @timeExecutionAsync('--click_element_node')
  async _clickElementNode(elementNode: DOMElementNode) {
    const page = await this.getCurrentPage();
    try {
      // Highlight before clicking
      // if element_node.highlight_index is not None:
      // 	await this._update_state(focus_element=element_node.highlight_index)

      const elementHandle = await this.getLocateElement(elementNode);

      if (!elementHandle) {
        throw new Error(`Element: ${JSON.stringify(elementNode)} not found`);
      }

      const performClick = async (clickFunc: () => Promise<void>) => {
        /**Performs the actual click, handling both download
        and navigation scenarios.*/
        if (this.browserProfile.saveDownloadsPath) {
          try {
            // Try short-timeout expect_download to detect a file download has been been triggered
            const downloadInfo = await page.waitForEvent('download', { timeout: 5000 });
            await clickFunc();

            // Determine file path
            const suggestedFilename = downloadInfo.suggestedFilename();
            const uniqueFilename = await this._getUniqueFilename(
              this.browserProfile.saveDownloadsPath,
              suggestedFilename
            );
            const downloadPath = path.join(this.browserProfile.saveDownloadsPath, uniqueFilename);
            await downloadInfo.saveAs(downloadPath);
            console.debug(`⬇️  Download triggered. Saved file to: ${downloadPath}`);
            return downloadPath;
          } catch (e: any) {
            if (e.message.includes('TimeoutError')) {
              // If no download is triggered, treat as normal click
              console.debug('No download triggered within timeout. Checking navigation...');
              await page.waitForLoadState();
              await this._checkAndHandleNavigation(page);
            } else {
              throw e;
            }
          }
        } else {
          // Standard click logic if no download is expected
          await clickFunc();
          await page.waitForLoadState();
          await this._checkAndHandleNavigation(page);
        }
      }

      try {
        return await performClick.call(this, () => elementHandle.click({ timeout: 1500 }));
      } catch (e: any) {
        if (e instanceof URLNotAllowedError) {
          throw e;
        }
        try {
          return await performClick.call(this, () => page.evaluate((el) => el.click(), elementHandle));
        } catch (e: any) {
          if (e instanceof URLNotAllowedError) {
            throw e;
          }
          throw new Error(`Failed to click element: ${e.message}`);
        }
      }
    } catch (e: any) {
      throw new Error(`Failed to click element: ${JSON.stringify(elementNode)}. Error: ${e.message}`);
    }
  }

  @requireInitialization
  @timeExecutionAsync('--get_tabs_info')
  async getTabsInfo(): Promise<TabInfo[]> {
    /**Get information about all tabs*/

    const tabsInfo: TabInfo[] = [];
    for (const [pageId, page] of this.browserContext!.pages().entries()) {
      try {
        const title = await page.title();
        tabsInfo.push({ pageId, url: page.url(), title });
      } catch {
        // page.title() can hang forever on tabs that are crashed/disappeared/about:blank
        // we dont want to try automating those tabs because they will hang the whole script
        console.debug(`⚠  Failed to get tab info for tab #${pageId}: ${page.url()} (ignoring)`);
        tabsInfo.push({ pageId, url: 'about:blank', title: 'ignore this tab and do not use it' });
      }
    }

    return tabsInfo;
  }

  @requireInitialization
  async closeTab(tabIndex?: number): Promise<void> {
    const pages = this.browserContext!.pages();
    if (!pages) {
      return;
    }

    let page: Page;
    if (tabIndex === undefined) {
      // to tabIndex passed, just close the current agent page
      page = await this.getCurrentPage();
    } else {
      // otherwise close the tab at the given index
      page = pages[tabIndex];
    }

    await page.close();

    // reset the self.agentCurrentPage and self.humanCurrentPage references to first available tab
    await this.getCurrentPage();
  }

  //  --- Page navigation ---
  /**
   * Navigate the agent's current tab to a URL
   */
  @requireInitialization
  async navigate(url: string): Promise<void> {
    if (!this._isUrlAllowed(url)) {
      throw new BrowserError(`Navigation to non-allowed URL: ${url}`);
    }

    const page = await this.getCurrentPage();
    await page.goto(url);
    await page.waitForLoadState();
  }

  @requireInitialization
  async refresh() {
    if (this.agentCurrentPage && !this.agentCurrentPage.isClosed()) {
      await this.agentCurrentPage.reload();

    } else {
      await this.createNewTab()
    }
  }


  @requireInitialization
  async executeJavascript<
    R,
    Args,
  >(pageFunction: (args: Args) => R, args: Args): Promise<R> {
    const page = await this.getCurrentPage();
    return page.evaluate(pageFunction as any, args);
  }

  async getCookies() {
    if (this.browserContext) {
      return this.browserContext.cookies();
    }
    return []
  }

  /**
   * Old name for the new save_storage_state() function.
   */
  async saveCookies(pathArg?: string): Promise<void> {
    await this.saveStorageState(pathArg);

  }

  /**
   * Save cookies to the specified path or the configured cookies_file and/or storage_state.
   */
  @requireInitialization
  async saveStorageState(filePath?: string): Promise<void> {
    const storageState = await this.browserContext!.storageState();
    const cookies = storageState.cookies;

    if (cookies && this.browserProfile.cookiesFile) {
      logger.warn(
        '⚠️ cookies_file is deprecated and will be removed in a future version. ' +
        'Please use storage_state instead for loading cookies and other browser state. ' +
        'See: https://playwright.dev/python/docs/api/class-browsercontext#browser-context-storage-state'
      );
    }

    const pathIsStorageState = filePath && filePath.toString().endsWith('storage_state.json');
    if ((filePath && !pathIsStorageState) || this.browserProfile.cookiesFile) {
      let cookiesFilePath: string;
      try {
        cookiesFilePath = path.resolve(filePath || this.browserProfile.cookiesFile!);
        fs.mkdirSync(path.dirname(cookiesFilePath), { recursive: true });
        fs.writeFileSync(cookiesFilePath, JSON.stringify(cookies, null, 4));
        logger.info(`🍪 Saved ${cookies.length} cookies to cookies_file=${_logPrettyPath(cookiesFilePath)}`);
      } catch (e: any) {
        logger.warn(
          `❌ Failed to save cookies to cookies_file=${_logPrettyPath(cookiesFilePath!)}: ${e.message}`
        );
      }
    }

    let storageStatePath: BrowserContextOptions['storageState'];
    if (filePath) {
      storageStatePath = path.resolve(path.dirname(filePath), 'storage_state.json');
    } else {
      storageStatePath = this.browserProfile.storageState;
    }

    if (!storageStatePath) {
      return;
    }

    if (!(typeof storageStatePath === 'string')) {
      logger.warn('⚠️ storage_state must be a json file path to be able to update it, skipping...');
      return;
    }

    try {
      fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
      const storageState = await this.browserContext!.storageState();

      if (fs.existsSync(storageStatePath)) {
        try {
          const existingStorageState = JSON.parse(fs.readFileSync(storageStatePath, 'utf-8'));
          const mergedStorageState = Object.assign(existingStorageState, storageState);
          fs.writeFileSync(storageStatePath, JSON.stringify(mergedStorageState, null, 4));
        } catch (e: any) {
          logger.warn(
            `❌ Failed to merge storage state with existing storage_state=${_logPrettyPath(storageStatePath)}: ${e.message}`
          );
          return;
        }
      }

      fs.writeFileSync(storageStatePath, JSON.stringify(storageState, null, 4));
      logger.info(
        `🍪 Saved ${storageState['cookies'].length} cookies to storage_state=${_logPrettyPath(storageStatePath)}`
      );
    } catch (e: any) {
      logger.warn(
        `❌ Failed to save storage state to storage_state=${_logPrettyPath(storageStatePath)}: ${e.message}`
      );
    }
  }


  /**
 * Load cookies from the cookiesFile if it exists and apply them to the browser context.
 */
  async loadCookiesFromFile(): Promise<void> {
    if (!this.browserProfile.cookiesFile || !this.browserContext) {
      return;
    }

    // Show deprecation warning 
    logger.warn(
      '⚠️ cookies_file is deprecated and will be removed in a future version. ' +
      'Please use storage_state instead for loading cookies and other browser state. ' +
      'See: https://playwright.dev/python/docs/api/class-browsercontext#browser-context-storage-state'
    );

    let cookiesPath = path.resolve(this.browserProfile.cookiesFile);
    if (!path.isAbsolute(cookiesPath)) {
      cookiesPath = path.join(this.browserProfile.downloadsDir || '.', cookiesPath);
    }

    if (fs.existsSync(cookiesPath)) {
      try {
        const cookiesData = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
        if (cookiesData) {
          await this.browserContext.addCookies(cookiesData);
          logger.info(`🍪 Loaded ${cookiesData.length} cookies from ${_logPrettyPath(cookiesPath)}`);
        }
      } catch (e: any) {
        logger.warn(`❌ Failed to load cookies from ${_logPrettyPath(cookiesPath)}: ${e.constructor.name}: ${e.message}`);
      }
    }
  }

  @requireInitialization
  async _waitForStableNetwork(): Promise<void> {
    const pendingRequests = new Set<Request>();
    let lastActivity = Date.now();

    const page = await this.getCurrentPage();

    // Define relevant resource types and content types
    const RELEVANT_RESOURCE_TYPES = new Set([
      'document',
      'stylesheet',
      'image',
      'font',
      'script',
      'iframe',
    ]);

    const RELEVANT_CONTENT_TYPES = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ]);

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
    ]);

    const onRequest = async (request: Request) => {
      // Filter by resource type
      if (!RELEVANT_RESOURCE_TYPES.has(request.resourceType())) {
        return;
      }

      // Filter out streaming, websocket, and other real-time requests
      if (new Set([
        'websocket',
        'media',
        'eventsource',
        'manifest',
        'other',
      ]).has(request.resourceType())) {
        return;
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase();
      if ([...IGNORED_URL_PATTERNS].some(pattern => url.includes(pattern))) {
        return;
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter out requests with certain headers
      const headers = request.headers();
      if (headers['purpose'] === 'prefetch' ||
        headers['sec-fetch-dest'] === 'video' ||
        headers['sec-fetch-dest'] === 'audio') {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now();
    };

    const onResponse = async (response: Response) => {
      const request = response.request();
      if (!pendingRequests.has(request)) {
        return;
      }

      // Filter by content type if available
      const contentType = response.headers()['content-type']?.toLowerCase() || '';

      // Skip if content type indicates streaming or real-time data
      if (['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf']
        .some(type => contentType.includes(type))) {
        pendingRequests.delete(request);
        return;
      }

      // Only process relevant content types
      if (![...RELEVANT_CONTENT_TYPES].some(ct => contentType.includes(ct))) {
        pendingRequests.delete(request);
        return;
      }

      // Skip if response is too large (likely not essential for page load)
      const contentLength = response.headers()['content-length'];
      if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) { // 5MB
        pendingRequests.delete(request);
        return;
      }

      pendingRequests.delete(request);
      lastActivity = Date.now();
    };

    // Attach event listeners
    page.on('request', onRequest);
    page.on('response', onResponse);

    let startTime: number;
    try {
      // Wait for idle time
      startTime = Date.now();
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const currentTime = Date.now();
        if (pendingRequests.size === 0 &&
          (currentTime - lastActivity) >= this.browserProfile.waitForNetworkIdlePageLoadTime) {
          break;
        }
        if (currentTime - startTime > this.browserProfile.maximumWaitPageLoadTime) {
          logger.debug(
            `Network timeout after ${this.browserProfile.maximumWaitPageLoadTime}s with ${pendingRequests.size} ` +
            `pending requests: ${[...pendingRequests].map(r => r.url())}`
          );
          break;
        }
      }
    } finally {
      // Clean up event listeners
      page.removeListener('request', onRequest);
      page.removeListener('response', onResponse);
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > 1000) {
      logger.debug(`💤 Page network traffic calmed down after ${(Date.now() - startTime) / 1000} seconds`);
    }
  }



  /**Injects a DVD screensaver-style bouncing logo loading animation overlay into the given Playwright Page.
   * This is used to visually indicate that the browser is setting up or waiting.
   */
  private async _showDvdScreensaverLoadingAnimation(page: Page): Promise<void> {
    await page.evaluate(`() => {
            document.title = 'Setting up...';

            // Create the main overlay
            const loadingOverlay = document.createElement('div');
            loadingOverlay.id = 'pretty-loading-animation';
            loadingOverlay.style.position = 'fixed';
            loadingOverlay.style.top = '0';
            loadingOverlay.style.left = '0';
            loadingOverlay.style.width = '100vw';
            loadingOverlay.style.height = '100vh';
            loadingOverlay.style.background = '#000';
            loadingOverlay.style.zIndex = '99999';
            loadingOverlay.style.overflow = 'hidden';

            // Create the image element
            const img = document.createElement('img');
            img.src = 'https://github.com/browser-use.png';
            img.alt = 'Browser-Use';
            img.style.width = '200px';
            img.style.height = 'auto';
            img.style.position = 'absolute';
            img.style.left = '0px';
            img.style.top = '0px';
            img.style.zIndex = '2';
            img.style.opacity = '0.8';

            loadingOverlay.appendChild(img);
            document.body.appendChild(loadingOverlay);

            // DVD screensaver bounce logic
            let x = Math.random() * (window.innerWidth - 300);
            let y = Math.random() * (window.innerHeight - 300);
            let dx = 1.2 + Math.random() * 0.4; // px per frame
            let dy = 1.2 + Math.random() * 0.4;
            // Randomize direction
            if (Math.random() > 0.5) dx = -dx;
            if (Math.random() > 0.5) dy = -dy;

            function animate() {
                const imgWidth = img.offsetWidth || 300;
                const imgHeight = img.offsetHeight || 300;
                x += dx;
                y += dy;

                if (x <= 0) {
                    x = 0;
                    dx = Math.abs(dx);
                } else if (x + imgWidth >= window.innerWidth) {
                    x = window.innerWidth - imgWidth;
                    dx = -Math.abs(dx);
                }
                if (y <= 0) {
                    y = 0;
                    dy = Math.abs(dy);
                } else if (y + imgHeight >= window.innerHeight) {
                    y = window.innerHeight - imgHeight;
                    dy = -Math.abs(dy);
                }

                img.style.left = \`\${x}px\`;
                img.style.top = \`\${y}px\`;

                requestAnimationFrame(animate);
            }
            animate();

            // Responsive: update bounds on resize
            window.addEventListener('resize', () => {
                x = Math.min(x, window.innerWidth - img.offsetWidth);
                y = Math.min(y, window.innerHeight - img.offsetHeight);
            });

            // Add a little CSS for smoothness
            const style = document.createElement('style');
            style.innerHTML = \`
                #pretty-loading-animation {
                    /*backdrop-filter: blur(2px) brightness(0.9);*/
                }
                #pretty-loading-animation img {
                    user-select: none;
                    pointer-events: none;
                }
            \`;
            document.head.appendChild(style);
        }`);
  }

  /**Get a summary of the current browser state
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
    await this._waitForPageAndFramesLoad();
    const updatedState = await this._getUpdatedState();

    // Find out which elements are new
    // Do this only if url has not changed
    if (cacheClickableElementsHashes) {
      // if we are on the same url as the last state, we can use the cached hashes
      if (this._cachedClickableElementHashes && this._cachedClickableElementHashes.url === updatedState.url) {
        // Pointers, feel free to edit in place
        const updatedStateClickableElements = ClickableElementProcessor.getClickableElements(updatedState.elementTree);

        for (const domElement of updatedStateClickableElements) {
          domElement.isNew = (
            ClickableElementProcessor.hashDomElement(domElement)
                        !in this._cachedClickableElementHashes.hashes // see which elements are new from the last state where we cached the hashes
                    );
        }
      }
      // in any case, we need to cache the new hashes
      this._cachedClickableElementHashes = {
        url: updatedState.url,
        hashes: ClickableElementProcessor.getClickableElementsHashes(updatedState.elementTree),
      };
    }

    this._cachedBrowserStateSummary = updatedState;

    // Save cookies if a file is specified
    if (this.browserProfile.cookiesFile) {
      // asyncio.create_task(this.saveCookies());
    }

    return this._cachedBrowserStateSummary;
  }

  private async _getUpdatedState(focusElement: number = -1): Promise<BrowserStateSummary> {
    /**Update and return state.*/

    const page = await this.getCurrentPage();

    // Check if current page is still valid, if not switch to another available page
    try {
      // Test if page is still accessible
      await page.evaluate('1');
    } catch (e) {
      console.debug(`👋  Current page is no longer accessible: ${e.constructor.name}: ${e.message}`);
      throw new BrowserError('Browser closed: no valid pages available');
    }

    try {
      await this.removeHighlights();
      const domService = new DomService(page);
      const content = await domService.getClickableElements(
        focusElement,
        this.browserProfile.viewportExpansion,
        this.browserProfile.highlightElements,
      );

      const tabsInfo = await this.getTabsInfo();

      // Get all cross-origin iframes within the page and open them in new tabs
      // mark the titles of the new tabs so the LLM knows to check them for additional content
      // unfortunately too buggy for now, too many sites use invisible cross-origin iframes for ads, tracking, youtube videos, social media, etc.
      // and it distracts the bot by opening a lot of new tabs
      // iframe_urls = await dom_service.get_cross_origin_iframes()
      // outer_page = this.agentCurrentPage
      // for url in iframe_urls:
      // 	if url in [tab.url for tab in tabs_info]:
      // 		continue  # skip if the iframe if we already have it open in a tab
      // 	new_page_id = tabs_info[-1].page_id + 1
      // 	logger.debug(f'Opening cross-origin iframe in new tab #{new_page_id}: {url}')
      // 	await this.createNewTab(url)
      // 	tabs_info.append(
      // 		TabInfo(
      // 			page_id=new_page_id,
      // 			url=url,
      // 			title=f'iFrame opened as new tab, treat as if embedded inside page {outer_page.url}: {page.url}',
      // 			parent_page_url=outer_page.url,
      // 		)
      // 	)

      const screenshotB64 = await this.takeScreenshot();
      const { pixelsAbove, pixelsBelow } = await this.getScrollInfo(page);

      this.browserStateSummary = {
        elementTree: content.elementTree,
        selectorMap: content.selectorMap,
        url: page.url(),
        title: await page.title(),
        tabs: tabsInfo,
        screenshot: screenshotB64,
        pixelsAbove,
        pixelsBelow,
      };

      return this.browserStateSummary;
    } catch (e) {
      console.error(`❌  Failed to update state: ${e.message}`);
      // Return last known good state if available
      if (this.browserStateSummary) {
        return this.browserStateSummary;
      }
      throw e;
    }
  }

  // region - Browser Actions
  /**Get a base64 encoded screenshot of the current page.*/
  @requireInitialization
  @timeExecutionAsync('--take_screenshot')
  async takeScreenshot(fullPage: boolean = false): Promise<string> {
    const page = await this.getCurrentPage();
    await page.waitForLoadState({ timeout: 5000 });

    // 0. Attempt full-page screenshot (sometimes times out for huge pages)
    try {
      const screenshot = await page.screenshot({
        fullPage,
        scale: 'css',
        timeout: 15000,
        animations: 'disabled',
        caret: 'initial',
      });

      return screenshot.toString('base64');
    } catch (e: any) {
      console.error(`❌  Failed to take full-page screenshot: ${e.message} falling back to viewport-only screenshot`);
    }

    // Fallback method: manually expand the viewport and take a screenshot of the entire viewport

    // 1. Get current page dimensions
    const dimensions = await page.evaluate(`() => {
            return {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio || 1
            };
        }`);

    // 2. Save current viewport state and calculate expanded dimensions
    const originalViewport = page.viewportSize();
    const viewportExpansion = this.browserProfile.viewportExpansion || 0;

    const expandedWidth = dimensions.width;  // Keep width unchanged
    const expandedHeight = dimensions.height + viewportExpansion;

    // 3. Expand the viewport if we are using one
    if (originalViewport) {
      await page.setViewportSize({ width: expandedWidth, height: expandedHeight });
    }

    try {
      // 4. Take full-viewport screenshot
      const screenshot = await page.screenshot({
        fullPage: false,
        scale: 'css',
        timeout: 30000,
        clip: { x: 0, y: 0, width: expandedWidth, height: expandedHeight },
      });

      const screenshotB64 = screenshot.toString('base64');
      return screenshotB64;
    } finally {
      // 5. Restore original viewport state if we expanded it
      if (originalViewport) {
        // Viewport was originally enabled, restore to original dimensions
        await page.setViewportSize(originalViewport);
      } else {
        // Viewport was originally disabled, no need to restore it
        // await page.setViewportSize(null);  // unfortunately this is not supported by playwright
        return;
      }
    }
  }

  // region - User Actions

  /**Generate a unique filename for downloads by appending (1), (2), etc., if a file already exists.*/
  static async _getUniqueFilename(directory: string, filename: string): Promise<string> {
    const base = path.basename(filename, path.extname(filename));
    const ext = path.extname(filename);
    let counter = 1;
    let newFilename = filename;
    while (fs.existsSync(path.join(directory, newFilename))) {
      newFilename = `${base} (${counter})${ext}`;
      counter += 1;
    }
    return newFilename;
  }

  /**Converts simple XPath expressions to CSS selectors.*/
  static _convertSimpleXPathToCssSelector(xpath: string): string {
    if (!xpath) {
      return '';
    }

    // Remove leading slash if present
    xpath = xpath.lstrip('/');

    // Split into parts
    const parts = xpath.split('/');
    const cssParts: string[] = [];

    for (const part of parts) {
      if (!part) {
        continue;
      }

      // Handle custom elements with colons by escaping them
      if (part.includes(':') && !part.includes('[')) {
        const basePart = part.replace(/:/g, r'\:');
        cssParts.push(basePart);
        continue;
      }

      // Handle index notation [n]
      if (part.includes('[')) {
        const basePart = part.split('[')[0];
        // Handle custom elements with colons in the base part
        if (basePart.includes(':')) {
          basePart = basePart.replace(/:/g, r'\:');
        }
        let indexPart = part.split('[').slice(1).join('[');

        // Handle multiple indices
        const indices = indexPart.split(']').slice(0, -1);

        for (const idx of indices) {
          try {
            // Handle numeric indices
            if (!isNaN(parseInt(idx))) {
              const index = parseInt(idx) - 1;
              basePart += `:nth-of-type(${index + 1})`;
            }
            // Handle last() function
            else if (idx === 'last()') {
              basePart += ':last-of-type';
            }
            // Handle position() functions
            else if (idx.includes('position()')) {
              if (idx.includes('>1')) {
                basePart += ':nth-of-type(n+2)';
              }
            }
          } catch {
            continue;
          }
        }

        cssParts.push(basePart);
      } else {
        cssParts.push(part);
      }
    }

    const baseSelector = cssParts.join(' > ');
    return baseSelector;
  }

  /**
   * Creates a CSS selector for a DOM element, handling various edge cases and special characters.
   *
   * @param element - The DOM element to create a selector for
   * @param includeDynamicAttributes - Whether to include dynamic attributes (data-id, data-qa, etc.) in the selector
   * @returns A valid CSS selector string
   */
  static _enhancedCssSelectorForElement(element: DOMElementNode, includeDynamicAttributes: boolean = true): string {
    try {
      // Get base selector from XPath
      let cssSelector = this._convertSimpleXPathToCssSelector(element.xpath);

      // Handle class attributes
      if ('class' in element.attributes && element.attributes['class'] && includeDynamicAttributes) {
        // Define a regex pattern for valid class names in CSS
        const validClassNamePattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

        // Iterate through the class attribute values
        const classes = element.attributes['class'].split(' ');
        for (const className of classes) {
          // Skip empty class names
          if (!className.trim()) {
            continue;
          }

          // Check if the class name is valid
          if (validClassNamePattern.test(className)) {
            // Append the valid class name to the CSS selector
            cssSelector += `.${className}`;
          } else {
            // Skip invalid class names
            continue;
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
      ]);

      if (includeDynamicAttributes) {
        const dynamicAttributes = new Set([
          'data-id',
          'data-qa',
          'data-cy',
          'data-testid',
        ]);
        SAFE_ATTRIBUTES.add(dynamicAttributes);
      }

      // Handle other attributes
      for (const [attribute, value] of Object.entries(element.attributes)) {
        if (attribute === 'class') {
          continue;
        }

        // Skip invalid attribute names
        if (!attribute.trim()) {
          continue;
        }

        if (!SAFE_ATTRIBUTES.has(attribute)) {
          continue;
        }

        // Escape special characters in attribute names
        const safeAttribute = attribute.replace(/:/g, r'\:');

        // Handle different value cases
        if (value === '') {
          cssSelector += `[${safeAttribute}]`;
        } else if (['"', '\'', '<', '>', '`', '\n', '\r', '\t'].some(char => value.includes(char))) {
          // Use contains for values with special characters
          // For newline-containing text, only use the part before the newline
          let collapsedValue = value.split('\n')[0];
          // Regex-substitute *any* whitespace with a single space, then strip.
          collapsedValue = collapsedValue.replace(/\s+/g, ' ').trim();
          // Escape embedded double-quotes.
          const safeValue = collapsedValue.replace(/"/g, '\\"');
          cssSelector += `[${safeAttribute}*="${safeValue}"]`;
        } else {
          cssSelector += `[${safeAttribute}="${value}"]`;
        }
      }

      return cssSelector;
    } catch {
      // Fallback to a more basic selector if something goes wrong
      const tagName = element.tagName || '*';
      return `${tagName}[highlight_index='${element.highlightIndex}']`;
    }
  }

  /**Checks if an element is visible on the page.*/
  @requireInitialization
  @timeExecutionAsync('--is_visible')
  async _isVisible(element: ElementHandle): Promise<boolean> {
    /**
     * Checks if an element is visible on the page.
     * We use our own implementation instead of relying solely on Playwright's is_visible() because
     * of edge cases with CSS frameworks like Tailwind. When elements use Tailwind's 'hidden' class,
     * the computed style may return display as '' (empty string) instead of 'none', causing Playwright
     * to incorrectly consider hidden elements as visible. By additionally checking the bounding box
     * dimensions, we catch elements that have zero width/height regardless of how they were hidden.
     */
    const isHidden = await element.isHidden();
    const bbox = await element.boundingBox();

    return !isHidden && bbox !== null && bbox.width > 0 && bbox.height > 0;
  }



  /**Close the current tab that the agent is working with.
   *
   * This closes the tab that the agent is currently using (agent_current_page),
   * not necessarily the tab that is visible to the user (human_current_page).
   * If they are the same tab, both references will be updated.
   * If no tabs are left, the browser will be closed.
   */
  async closeCurrentTab(): Promise<void> {
    if (!this.browserContext) {
      throw new Error('Browser context is not set');
    }

    if (!this.agentCurrentPage) {
      throw new Error('Agent current page is not set');
      return;
    }

    // Check if this is the foreground tab as well
    const isForeground = this.agentCurrentPage === this.humanCurrentPage;

    // Close the tab
    try {
      await this.agentCurrentPage.close();
    } catch (e: any) {
      console.debug(`⛔️  Error during closeCurrentTab: ${e.message}`);
    }

    // Clear agent's reference to the closed tab
    this.agentCurrentPage = undefined;

    // Clear foreground reference if needed
    if (isForeground) {
      this.humanCurrentPage = undefined;
    }

    // Switch to the first available tab if any exist
    if (this.browserContext.pages().length > 0) {
      await this.switchTab(0);
      // switch_to_tab already updates both tab references
    }
  }

}