// fix playwright type imports
import type {
  BrowserContextOptions,
  Geolocation,
  HTTPCredentials,
  ViewportSize,
} from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, unlinkSync } from 'node:fs'
import * as os from 'node:os'

import * as path from 'node:path'
import { URL } from 'node:url'

const IN_DOCKER = 'ty1'.includes((process.env.IN_DOCKER || 'false').toLowerCase()[0])
const CHROME_DEBUG_PORT = 9242 // use a non-default port to avoid conflicts with other tools / devs using 9222

const CHROME_DISABLED_COMPONENTS = [
  // Playwright defaults: https://github.com/microsoft/playwright/blob/41008eeddd020e2dee1c540f7c0cdfa337e99637/packages/playwright-core/src/server/chromium/chromiumSwitches.ts#L76
  // See https://github.com/microsoft/playwright/pull/10380
  'AcceptCHFrame',
  // See https://github.com/microsoft/playwright/pull/10679
  'AutoExpandDetailsElement',
  // See https://github.com/microsoft/playwright/issues/14047
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  // See https://github.com/microsoft/playwright/pull/12992
  'CertificateTransparencyComponentUpdater',
  'DestroyProfileOnBrowserClose',
  // See https://github.com/microsoft/playwright/pull/13854
  'DialMediaRouteProvider',
  // Chromium is disabling manifest version 2. Allow testing it as long as Chromium can actually run it.
  // Disabled in https://chromium-review.googlesource.com/c/chromium/src/+/6265903.
  'ExtensionManifestV2Disabled',
  'GlobalMediaControls',
  // See https://github.com/microsoft/playwright/pull/27605
  'HttpsUpgrades',
  'ImprovedCookieControls',
  'LazyFrameLoading',
  // Hides the Lens feature in the URL address bar. Its not working in unofficial builds.
  'LensOverlay',
  // See https://github.com/microsoft/playwright/pull/8162
  'MediaRouter',
  // See https://github.com/microsoft/playwright/issues/28023
  'PaintHolding',
  // See https://github.com/microsoft/playwright/issues/32230
  'ThirdPartyStoragePartitioning',
  // See https://github.com/microsoft/playwright/issues/16126
  'Translate',
  'AutomationControlled',
  // Added by us:
  'OptimizationHints',
  'ProcessPerSiteUpToMainFrameThreshold',
  'InterestFeedContentSuggestions',
  'CalculateNativeWinOcclusion', // chrome normally stops rendering tabs if they are not visible (occluded by a foreground window or other app)
  // 'BackForwardCache', // agent does actually use back/forward navigation, but we can disable if we ever remove that
  'HeavyAdPrivacyMitigations',
  'PrivacySandboxSettings4',
  'AutofillServerCommunication',
  'CrashReporting',
  'OverscrollHistoryNavigation',
  'InfiniteSessionRestore',
  'ExtensionDisableUnsupportedDeveloper',
]

const CHROME_HEADLESS_ARGS = [
  '--headless=new',
]

const CHROME_DOCKER_ARGS = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--no-xshm',
  '--no-zygote',
  '--single-process',
]

const CHROME_DISABLE_SECURITY_ARGS = [
  '--disable-web-security',
  '--disable-site-isolation-trials',
  '--disable-features=IsolateOrigins,site-per-process',
  '--allow-running-insecure-content',
  '--ignore-certificate-errors',
  '--ignore-ssl-errors',
  '--ignore-certificate-errors-spki-list',
]

const CHROME_DETERMINISTIC_RENDERING_ARGS = [
  '--deterministic-mode',
  '--js-flags=--random-seed=1157259159',
  '--force-device-scale-factor=2',
  '--enable-webgl',
  // '--disable-skia-runtime-opts',
  // '--disable-2d-canvas-clip-aa',
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
]

const CHROME_DEFAULT_ARGS = [
  // provided by playwright by default: https://github.com/microsoft/playwright/blob/41008eeddd020e2dee1c540f7c0cdfa337e99637/packages/playwright-core/src/server/chromium/chromiumSwitches.ts#L76
  // we don't need to include them twice in our own config, but it's harmless
  '--disable-field-trial-config', // https://source.chromium.org/chromium/chromium/src/+/main:testing/variations/README.md
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache', // Avoids surprises like main request not being intercepted during page.goBack().
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update', // Avoids unneeded network activity after startup.
  '--no-default-browser-check',
  // '--disable-default-apps',
  '--disable-dev-shm-usage',
  // '--disable-extensions',
  // '--disable-features=' + disabledFeatures(assistantMode).join(','),
  '--allow-pre-commit-input', // let page JS run a little early before GPU rendering finishes
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  // '--force-color-profile=srgb', // moved to CHROME_DETERMINISTIC_RENDERING_ARGS
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  // // See https://chromium-review.googlesource.com/c/chromium/src/+/2436773
  '--no-service-autorun',
  '--export-tagged-pdf',
  // // https://chromium-review.googlesource.com/c/chromium/src/+/4853540
  '--disable-search-engine-choice-screen',
  // // https://issues.chromium.org/41491762
  '--unsafely-disable-devtools-self-xss-warnings',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--enable-network-information-downlink-max',
  // added by us:
  '--test-type=gpu',
  '--disable-sync',
  '--allow-legacy-extension-manifests',
  '--allow-pre-commit-input',
  '--disable-blink-features=AutomationControlled',
  '--install-autogenerated-theme=0,0,0',
  '--hide-scrollbars',
  '--log-level=2',
  // '--enable-logging=stderr',
  '--disable-focus-on-load',
  '--disable-window-activation',
  '--generate-pdf-document-outline',
  '--no-pings',
  '--ash-no-nudges',
  '--disable-infobars',
  '--simulate-outdated-no-au="Tue, 31 Dec 2099 23:59:59 GMT"',
  '--hide-crash-restore-bubble',
  '--suppress-message-center-popups',
  '--disable-domain-reliability',
  '--disable-datasaver-prompt',
  '--disable-speech-synthesis-api',
  '--disable-speech-api',
  '--disable-print-preview',
  '--safebrowsing-disable-auto-update',
  '--disable-external-intent-requests',
  '--disable-desktop-notifications',
  '--noerrdialogs',
  '--silent-debugger-extension-api',
  `--disable-features=${CHROME_DISABLED_COMPONENTS.join(',')}`,
]

function getDisplaySize(): ViewportSize | null {
  const platform = process.platform

  try {
    if (platform === 'darwin') {
      const output = execSync('system_profiler SPDisplaysDataType | grep Resolution').toString()
      const match = output.match(/Resolution: (\d+) x (\d+)/)
      if (match) {
        return { width: Number.parseInt(match[1]), height: Number.parseInt(match[2]) }
      }
    } else if (platform === 'linux') {
      const output = execSync('xrandr | grep "*"').toString()
      const match = output.match(/(\d+)x(\d+)/)
      if (match) {
        return { width: Number.parseInt(match[1]), height: Number.parseInt(match[2]) }
      }
    } else if (platform === 'win32') {
      const output = execSync('wmic path Win32_VideoController get CurrentHorizontalResolution,CurrentVerticalResolution').toString()
      const lines = output.trim().split('\n')
      if (lines.length > 1) {
        const values = lines[1].trim().split(/\s+/)
        return { width: Number.parseInt(values[0]), height: Number.parseInt(values[1]) }
      }
    }
  } catch (e) {
    console.error('Failed to get screen resolution via command:', e)
  }

  // 默认分辨率
  return { width: 1920, height: 1080 }
}

function getWindowAdjustments(): [number, number] {
  /** Returns recommended x, y offsets for window positioning */

  if (process.platform === 'darwin') { // macOS
    return [-4, 24] // macOS has a small title bar, no border
  } else if (process.platform === 'win32') { // Windows
    return [-8, 0] // Windows has a border on the left
  } else { // Linux
    return [0, 0]
  }
}

// ===== Validator functions =====

const BROWSERUSE_CONFIG_DIR = path.join(os.homedir(), '.config', 'browseruse')
const BROWSERUSE_PROFILES_DIR = path.join(BROWSERUSE_CONFIG_DIR, 'profiles')

function validateUrl(url: string, schemes: string[] = []): string {
  /** Validate URL format and optionally check for specific schemes. */
  const parsedUrl = new URL(url)
  if (!parsedUrl.hostname) {
    throw new Error(`Invalid URL format: ${url}`)
  }
  if (schemes.length && parsedUrl.protocol && !schemes.includes(parsedUrl.protocol.slice(0, -1))) {
    throw new Error(`URL has invalid scheme: ${url} (expected one of ${schemes})`)
  }
  return url
}

function validateFloatRange(value: number, minVal: number, maxVal: number): number {
  /** Validate that float is within specified range. */
  if (!(minVal <= value && value <= maxVal)) {
    throw new Error(`Value ${value} outside of range ${minVal}-${maxVal}`)
  }
  return value
}

function validateCliArg(arg: string): string {
  /** Validate that arg is a valid CLI argument. */
  if (!arg.startsWith('--')) {
    throw new Error(`Invalid CLI argument: ${arg} (should start with --, e.g. --some-key="some value here")`)
  }
  return arg
}

// ===== Enum definitions =====

export type ColorScheme = BrowserContextOptions['colorScheme']

export type Contrast = BrowserContextOptions['contrast']

export type ReducedMotion = BrowserContextOptions['reducedMotion']

export type ForcedColors = BrowserContextOptions['forcedColors']

export type ServiceWorkers = BrowserContextOptions['serviceWorkers']

export enum RecordHarContent {
  OMIT = 'omit',
  EMBED = 'embed',
  ATTACH = 'attach',
}

export enum RecordHarMode {
  FULL = 'full',
  MINIMAL = 'minimal',
}

export enum BrowserChannel {
  CHROMIUM = 'chromium',
  CHROME = 'chrome',
  CHROME_BETA = 'chrome-beta',
  CHROME_DEV = 'chrome-dev',
  CHROME_CANARY = 'chrome-canary',
  MSEDGE = 'msedge',
  MSEDGE_BETA = 'msedge-beta',
  MSEDGE_DEV = 'msedge-dev',
  MSEDGE_CANARY = 'msedge-canary',
}

// ===== Base Models =====

/**
 * Base model for common browser context parameters used by
 * both BrowserType.new_context() and BrowserType.launch_persistent_context().
 *
 * https://playwright.dev/python/docs/api/class-browser#browser-new-context
 */
export interface BrowserContextArgs {
  // Browser context parameters
  acceptDownloads?: boolean
  offline?: boolean
  strictSelectors?: boolean

  // Security options
  proxy?: BrowserContextOptions['proxy']
  /** Browser permissions to grant (see playwright docs for valid permissions). */
  permissions?: string[]
  bypassCsp?: boolean
  clientCertificates?: BrowserContextOptions['clientCertificates']
  extraHttpHeaders?: Record<string, string>
  httpCredentials?: BrowserContextOptions['httpCredentials']
  ignoreHttpsErrors?: boolean
  javaScriptEnabled?: boolean
  baseUrl?: string
  serviceWorkers?: ServiceWorkers

  // Viewport options
  userAgent?: string
  screen?: ViewportSize
  viewport?: ViewportSize
  noViewport?: boolean
  deviceScaleFactor?: number
  isMobile?: boolean
  hasTouch?: boolean
  locale?: string
  geolocation?: Geolocation
  timezoneId?: string
  colorScheme?: ColorScheme
  contrast?: Contrast
  reducedMotion?: ReducedMotion
  forcedColors?: ForcedColors

  // Recording Options
  recordHarContent?: RecordHarContent
  recordHarMode?: RecordHarMode
  recordHarOmitContent?: boolean
  recordHarPath?: string
  recordHarUrlFilter?: string | RegExp
  recordVideoDir?: string
  recordVideoSize?: ViewportSize
}

/**
 * Base model for common browser connect parameters used by
 * both connect_over_cdp() and connect_over_ws().
 *
 * https://playwright.dev/python/docs/api/class-browsertype#browser-type-connect
 * https://playwright.dev/python/docs/api/class-browsertype#browser-type-connect-over-cdp
 */
export interface BrowserConnectArgs {
  /** Additional HTTP headers to be sent with connect request */
  headers?: Record<string, string>
  slowMo?: number
  timeout?: number
}

/**
 * Base model for common browser launch parameters used by
 * both launch() and launch_persistent_context().
 *
 * https://playwright.dev/python/docs/api/class-browsertype#browser-type-launch
 */
export interface BrowserLaunchArgs {
  /** Extra environment variables to set when launching the browser. If None, inherits from the current process. */
  env?: Record<string, string | number | boolean>
  /** Path to the chromium-based browser executable to use. */
  executablePath?: string
  /** Whether to run the browser in headless or windowed mode. */
  headless?: boolean
  /** List of *extra* CLI args to pass to the browser when launching. */
  args?: string[]
  /** List of default CLI args to stop playwright from applying (see https://github.com/microsoft/playwright/blob/41008eeddd020e2dee1c540f7c0cdfa337e99637/packages/playwright-core/src/server/chromium/chromiumSwitches.ts) */
  ignoreDefaultArgs?: string[] | boolean
  channel?: BrowserChannel // https://playwright.dev/docs/browsers#chromium-headless-shell
  /** Whether to enable Chromium sandboxing (recommended unless inside Docker). */
  chromiumSandbox?: boolean
  /** Whether to open DevTools panel automatically for every page, only works when headless=False. */
  devtools?: boolean
  /** Slow down actions by this many milliseconds. */
  slowMo?: number
  /** Default timeout in milliseconds for connecting to a remote browser. */
  timeout?: number
  /** Proxy settings to use to connect to the browser. */
  proxy?: BrowserContextOptions['proxy']
  /** Directory to save downloads to. */
  downloadsPath?: string
  /** Directory to save HAR trace files to. */
  tracesDir?: string
  /** Whether playwright should swallow SIGHUP signals and kill the browser. */
  handleSighup?: boolean
  /** Whether playwright should swallow SIGINT signals and kill the browser. */
  handleSigint?: boolean
  /** Whether playwright should swallow SIGTERM signals and kill the browser. */
  handleSigterm?: boolean
}

// ===== API-specific Models =====

/**
 * Pydantic model for new_context() arguments.
 * Extends BaseContextParams with storage_state parameter.
 *
 * https://playwright.dev/python/docs/api/class-browser#browser-new-context
 */
export interface BrowserNewContextArgs extends BrowserContextArgs {
  // storage_state is not supported in launch_persistent_context()
  storageState?: BrowserContextOptions['storageState']
}

/**
 * Pydantic model for launch_persistent_context() arguments.
 * Combines browser launch parameters and context parameters,
 * plus adds the user_data_dir parameter.
 *
 * https://playwright.dev/python/docs/api/class-browsertype#browser-type-launch-persistent-context
 */
export interface BrowserLaunchPersistentContextArgs extends BrowserLaunchArgs, BrowserContextArgs {
  // Required parameter specific to launch_persistent_context, but can be None to use incognito temp dir
  userDataDir?: string
}

/**
 * A BrowserProfile is a static collection of kwargs that get passed to:
 * - BrowserType.launch(**BrowserLaunchArgs)
 * - BrowserType.connect(**BrowserConnectArgs)
 * - BrowserType.connect_over_cdp(**BrowserConnectArgs)
 * - BrowserType.launch_persistent_context(**BrowserLaunchPersistentContextArgs)
 * - BrowserContext.new_context(**BrowserNewContextArgs)
 * - BrowserSession(**BrowserProfile)
 */
export class BrowserProfile implements BrowserConnectArgs, BrowserLaunchPersistentContextArgs, BrowserLaunchArgs, BrowserNewContextArgs {
  // Default values with TypeScript comments from descriptions
  acceptDownloads = true
  offline = false
  strictSelectors = false

  // Security options
  proxy?: BrowserContextOptions['proxy']
  /** Browser permissions to grant (see playwright docs for valid permissions). */
  permissions = ['clipboard-read', 'clipboard-write', 'notifications']
  bypassCsp = false
  clientCertificates?: BrowserContextOptions['clientCertificates'] = []
  extraHttpHeaders: Record<string, string> = {}
  httpCredentials?: HTTPCredentials
  ignoreHttpsErrors = false
  javaScriptEnabled = true
  baseUrl?: string
  serviceWorkers: ServiceWorkers = 'allow'

  // Viewport options
  userAgent?: string
  screen?: ViewportSize
  viewport?: ViewportSize
  noViewport?: boolean
  deviceScaleFactor?: number
  isMobile?: boolean
  hasTouch?: boolean
  locale?: string
  geolocation?: Geolocation
  timezoneId?: string
  colorScheme: ColorScheme = 'light'
  contrast: Contrast = 'no-preference'
  reducedMotion: ReducedMotion = 'no-preference'
  forcedColors: ForcedColors = 'none'

  // Recording Options
  recordHarContent = RecordHarContent.EMBED
  recordHarMode = RecordHarMode.FULL
  recordHarOmitContent = false
  recordHarPath?: string
  recordHarUrlFilter?: string | RegExp
  recordVideoDir?: string
  recordVideoSize?: ViewportSize

  // BrowserConnectArgs
  headers?: Record<string, string>
  slowMo = 0
  timeout = 30000

  // BrowserLaunchArgs
  env?: Record<string, string | number | boolean>
  executablePath?: string
  headless?: boolean
  /** List of *extra* CLI args to pass to the browser when launching. */
  args: string[] = []
  /** List of default CLI args to stop playwright from applying */
  ignoreDefaultArgs: string[] | boolean = ['--enable-automation', '--disable-extensions']
  channel = BrowserChannel.CHROMIUM
  /** Whether to enable Chromium sandboxing (recommended unless inside Docker). */
  chromiumSandbox = !IN_DOCKER
  devtools = false
  proxy2?: BrowserContextOptions['proxy'] // Note: This might conflict with proxy above
  downloadsPath?: string
  tracesDir?: string
  /** Whether playwright should swallow SIGHUP signals and kill the browser. */
  handleSighup = true
  /** Whether playwright should swallow SIGINT signals and kill the browser. */
  handleSigint = false
  /** Whether playwright should swallow SIGTERM signals and kill the browser. */
  handleSigterm = false

  // BrowserNewContextArgs
  storageState?: BrowserContextOptions['storageState']

  // BrowserLaunchPersistentContextArgs
  userDataDir = path.join(BROWSERUSE_PROFILES_DIR, 'default')

  // Custom options
  /** Disable browser security features. */
  disableSecurity = false
  /** Enable deterministic rendering flags. */
  deterministicRendering = false
  /** List of allowed domains for navigation e.g. ["*.google.com", "https://example.com", "chrome-extension://*"] */
  allowedDomains?: string[]
  /** Keep browser alive after agent run. */
  keepAlive?: boolean
  /** Window size to use for the browser when headless=False. */
  windowSize?: ViewportSize
  /** Window position to use for the browser x,y from the top left when headless=False. */
  windowPosition?: ViewportSize = { width: 0, height: 0 }

  // Page load/wait timings
  /** Default page navigation timeout. */
  defaultNavigationTimeout?: number
  /** Default playwright call timeout. */
  defaultTimeout?: number
  /** Minimum time to wait before capturing page state. */
  minimumWaitPageLoadTime = 0.25
  /** Time to wait for network idle. */
  waitForNetworkIdlePageLoadTime = 0.5
  /** Maximum time to wait for page load. */
  maximumWaitPageLoadTime = 5.0
  /** Time to wait between actions. */
  waitBetweenActions = 0.5

  // UI/viewport/DOM
  /** Include dynamic attributes in selectors. */
  includeDynamicAttributes = true
  /** Highlight interactive elements on the page. */
  highlightElements = true
  /** Viewport expansion in pixels for LLM context. */
  viewportExpansion = 500

  profileDirectory = 'Default'

  // File paths
  /** Directory for video recordings. */
  saveRecordingPath?: string
  /** Directory for saving downloads. */
  saveDownloadsPath?: string
  /** Directory for saving HAR files. */
  saveHarPath?: string
  /** Directory for saving trace files. */
  tracePath?: string
  /** File to save cookies to. DEPRECATED, use `storage_state` instead. */
  cookiesFile?: string
  /** Directory for downloads. */
  downloadsDir = path.join(os.homedir(), '.config', 'browseruse', 'downloads')

  constructor(init?: Partial<BrowserProfile>) {
    // Initialize with provided values or defaults
    Object.assign(this, init)

    // Ensure userDataDir is absolute
    if (this.userDataDir) {
      this.userDataDir = path.resolve(this.userDataDir.replace('~', os.homedir()))
    }

    // Ensure downloadsDir is absolute
    if (this.downloadsDir) {
      this.downloadsDir = path.resolve(this.downloadsDir.replace('~', os.homedir()))
    }

    // Detect display configuration
    this.detectDisplayConfiguration()
  }

  getArgs(): string[] {
    const ignoreSet = Array.isArray(this.ignoreDefaultArgs) ? new Set(this.ignoreDefaultArgs) : new Set()
    const defaultArgs = this.ignoreDefaultArgs === true
      ? []
      : Array.isArray(this.ignoreDefaultArgs)
        ? CHROME_DEFAULT_ARGS.filter(arg => !ignoreSet.has(arg))
        : CHROME_DEFAULT_ARGS

    // Capture args before conversion for logging
    const preConversionArgs = [
      ...defaultArgs,
      ...this.args,
      `--profile-directory=${this.profileDirectory}`,
      ...(IN_DOCKER ? CHROME_DOCKER_ARGS : []),
      ...(this.headless ? CHROME_HEADLESS_ARGS : []),
      ...(this.disableSecurity ? CHROME_DISABLE_SECURITY_ARGS : []),
      ...(this.deterministicRendering ? CHROME_DETERMINISTIC_RENDERING_ARGS : []),
      ...(this.windowSize
        ? [`--window-size=${this.windowSize.width},${this.windowSize.height}`]
        : (!this.headless ? ['--start-maximized'] : [])),
      ...(this.windowPosition ? [`--window-position=${this.windowPosition.width},${this.windowPosition.height}`] : []),
    ]

    return this.argsAsList(this.argsAsDict(preConversionArgs))
  }

  /** Return the extra launch CLI args as a dictionary. */
  private argsAsDict(args: string[]): Record<string, string> {
    const argsDict: Record<string, string> = {}
    for (const arg of args) {
      const [key, value = ''] = arg.split('=', 2)
      argsDict[key.trim().replace(/^-+/, '')] = value.trim()
    }
    return argsDict
  }

  /** Return the extra launch CLI args as a list of strings. */
  private argsAsList(args: Record<string, string>): string[] {
    return Object.entries(args).map(([key, value]) =>
      value ? `--${key.replace(/^-+/, '')}=${value}` : `--${key.replace(/^-+/, '')}`,
    )
  }

  /** Return the kwargs for BrowserType.launch(). */
  kwargsForLaunchPersistentContext(): BrowserLaunchPersistentContextArgs {
    return { ...this, args: this.getArgs() }
  }

  /** Return the kwargs for BrowserContext.new_context(). */
  kwargsForNewContext(): BrowserNewContextArgs {
    return { ...this, args: this.getArgs() }
  }

  /** Return the kwargs for BrowserType.connect(). */
  kwargsForConnect(): BrowserConnectArgs {
    return { ...this, args: this.getArgs() }
  }

  /** Return the kwargs for BrowserType.connect_over_cdp(). */
  kwargsForLaunch(): BrowserLaunchArgs {
    return { ...this, args: this.getArgs() }
  }

  /** Create and unlock the user data dir for first-run initialization. */
  prepareUserDataDir(): void {
    if (this.userDataDir) {
      const userDataPath = path.resolve(this.userDataDir.replace('~', os.homedir()))

      // Create directory if it doesn't exist
      try {
        mkdirSync(userDataPath, { recursive: true })
      } catch (e) {
        // Directory might already exist
      }

      // clear any existing locks by any other chrome processes (hacky)
      // helps stop chrome crashes from leaving the profile dir in a locked state and breaking subsequent runs,
      // but can cause conflicts if the user actually tries to run multiple chrome copies on the same user_data_dir
      const singletonLock = path.join(userDataPath, 'SingletonLock')
      try {
        unlinkSync(singletonLock)
        console.warn(
          `⚠️ Multiple chrome processes may be trying to share user_data_dir=${userDataPath} which can lead to crashes and profile data corruption!`,
        )
      } catch (e) {
        // File might not exist, which is fine
      }
    }

    if (this.downloadsDir) {
      const downloadsPath = path.resolve(this.downloadsDir.replace('~', os.homedir()))
      try {
        mkdirSync(downloadsPath, { recursive: true })
      } catch (e) {
        // Directory might already exist
      }
    }
  }

  /**
   * Detect the system display size and initialize the display-related config defaults:
   *         screen, window_size, window_position, viewport, no_viewport, device_scale_factor
   */
  detectDisplayConfiguration(): void {
    const displaySize = getDisplaySize()
    const hasScreenAvailable = Boolean(displaySize)
    this.screen = this.screen || displaySize || { width: 1280, height: 1100 }

    // if no headless preference specified, prefer headful if there is a display available
    if (!this.headless) {
      this.headless = !hasScreenAvailable
    }

    // set up window size and position if headful
    if (this.headless) {
      // headless mode: no window available, use viewport instead to constrain content size
      this.viewport = this.viewport || this.windowSize || this.screen
      this.windowPosition = undefined // no windows to position in headless mode
      this.windowSize = undefined
      this.noViewport = false // viewport is always enabled in headless mode
    } else {
      // headful mode: use window, disable viewport by default, content fits to size of window
      this.windowSize = this.windowSize || this.screen
      this.noViewport = this.noViewport !== undefined ? this.noViewport : true
      this.viewport = this.noViewport ? undefined : this.viewport
    }

    // automatically setup viewport if any config requires it
    const useViewport = this.headless || this.viewport || this.deviceScaleFactor
    this.noViewport = this.noViewport !== undefined ? this.noViewport : !useViewport
    const finalUseViewport = !this.noViewport

    if (finalUseViewport) {
      // if we are using viewport, make device_scale_factor and screen are set to real values to avoid easy fingerprinting
      this.viewport = this.viewport || this.screen
      this.deviceScaleFactor = this.deviceScaleFactor || 1.0
    } else {
      // device_scale_factor and screen are not supported non-viewport mode, the system monitor determines these
      this.viewport = undefined
      this.deviceScaleFactor = undefined // only supported in viewport mode
      this.screen = undefined // only supported in viewport mode
    }

    if (this.headless && this.noViewport) {
      throw new Error('headless=true and noViewport=true cannot both be set at the same time')
    }
  }

  toString(): string {
    const shortDir = this.userDataDir?.replace(os.homedir(), '~') || ''
    return `BrowserProfile(user_data_dir=${shortDir}, headless=${this.headless})`
  }
}

export {
  BROWSERUSE_CONFIG_DIR,
  BROWSERUSE_PROFILES_DIR,
  CHROME_DEBUG_PORT,
  CHROME_DEFAULT_ARGS,
  CHROME_DETERMINISTIC_RENDERING_ARGS,
  CHROME_DISABLE_SECURITY_ARGS,
  CHROME_DISABLED_COMPONENTS,
  CHROME_DOCKER_ARGS,
  CHROME_HEADLESS_ARGS,
  getDisplaySize,
  getWindowAdjustments,
  validateCliArg,
  validateFloatRange,
  validateUrl,
}
