import type { BrowserContext, BrowserType, Page, Browser as PlaywrightBrowser } from 'playwright'
import type { BrowserStateSummary } from './views'
import axios from 'axios'
import { chromium } from 'playwright'
import { Browser } from './browser'
import { TabInfo } from './views'

// 配置日志记录器
const logger = {
  info: (message: string) => console.info(message),
  error: (message: string) => console.error(message),
  warning: (message: string) => console.warn(message),
}

export class DolphinBrowser extends Browser {
  /**
   * A class for managing Dolphin Anty browser sessions using Playwright
   */
  private apiToken?: string
  private apiUrl: string
  private profileId?: string
  private playwright?: BrowserType
  private browser?: PlaywrightBrowser
  private context?: BrowserContext
  private page?: Page
  private headless: boolean
  private keepOpen: boolean
  private pages: Page[]
  private session?: DolphinBrowser | null
  private cachedState?: BrowserStateSummary

  constructor(headless: boolean = false, keepOpen: boolean = false) {
    super()
    /**
     * Initialize the DolphinBrowser instance.
     *
     * @param headless - Run browser in headless mode (default: false)
     * @param keepOpen - Keep browser open after finishing tasks (default: false)
     */
    // Retrieve environment variables for API connection
    this.apiToken = process.env.DOLPHIN_API_TOKEN
    this.apiUrl = process.env.DOLPHIN_API_URL || 'http://localhost:3001/v1.0'
    this.profileId = process.env.DOLPHIN_PROFILE_ID

    // Initialize internal attributes

    this.headless = headless
    this.keepOpen = keepOpen
    this.pages = [] // List to store open pages
  }

  /**
   * Get the currently active page.
   *
   * @throws Error if no active page is available
   */

  getCurrentPage(): Page {
    if (!this.page) {
      throw new Error('No active page. Browser might not be connected.')
    }
    return this.page
  }

  /**
   * Create a new tab and optionally navigate to a given URL.
   *
   * @param url - URL to navigate to after creating the tab
   * @throws Error if browser context is not initialized or navigation fails
   */
  async createNewTab(url?: string): Promise<void> {
    if (!this.context) {
      throw new Error('Browser context not initialized')
    }

    // Create new page (tab) in the current browser context
    const newPage = await this.context.newPage()
    this.pages.push(newPage)
    this.page = newPage // Set as current page

    if (url) {
      try {
        // Navigate to the URL and wait for the page to load
        await newPage.goto(url, { waitUntil: 'networkidle' })
        await this.waitForPageLoad()
      } catch (e) {
        logger.error(`Failed to navigate to URL ${url}: ${e}`)
        throw e
      }
    }
  }

  /**
   * Switch to a specific tab by its page ID.
   *
   * @param pageId - The index of the tab to switch to
   * @throws Error if the tab index is out of range or no tabs are available
   */
  async switchToTab(pageId: number): Promise<void> {
    if (!this.pages.length) {
      throw new Error('No tabs available')
    }

    // Handle negative indices (e.g., -1 for last tab)
    if (pageId < 0) {
      pageId = this.pages.length + pageId
    }

    if (pageId >= this.pages.length || pageId < 0) {
      throw new Error(`Tab index ${pageId} out of range`)
    }

    // Set the current page to the selected tab
    this.page = this.pages[pageId]
    await this.page.bringToFront() // Bring tab to the front
    await this.waitForPageLoad()
  }

  async getTabsInfo(): Promise<TabInfo[]> {
    /**
     * Get information about all open tabs.
     *
     * @returns A list of TabInfo objects containing details about each tab
     */
    const tabsInfo: TabInfo[] = []
    for (let idx = 0; idx < this.pages.length; idx++) {
      const page = this.pages[idx]
      const tabInfo = new TabInfo({
        pageId: idx,
        url: page.url(),
        title: await page.title(), // Fetch the title of the page
      })
      tabsInfo.push(tabInfo)
    }
    return tabsInfo
  }

  /**
   * Wait for the page to load completely.
   *
   * @param timeout - Maximum time to wait for page load in milliseconds (default: 30000ms)
   */
  async waitForPageLoad(timeout: number = 30000): Promise<void> {
    if (this.page) {
      try {
        await this.page.waitForLoadState('networkidle', { timeout })
      } catch (e) {
        logger.warning(`Wait for page load timeout: ${e}`)
      }
    }
  }

  /**
   * Get the current session.
   *
   * @returns The current DolphinBrowser instance
   * @throws Error if the browser is not connected
   */
  async getSession(): Promise<DolphinBrowser> {
    if (!this.browser) {
      throw new Error('Browser not connected. Call connect() first.')
    }
    this.session = this
    return this
  }

  /**
   * Authenticate with Dolphin Anty API using the API token.
   *
   * @throws Error if authentication fails
   */
  async authenticate(): Promise<any> {
    try {
      const response = await axios.post(`${this.apiUrl}/auth/login-with-token`, {
        token: this.apiToken,
      })
      return response.data
    } catch (error) {
      throw new Error(`Failed to authenticate with Dolphin Anty: ${error}`)
    }
  }

  /**
   * Get a list of available browser profiles from Dolphin Anty.
   *
   * @returns A list of browser profiles
   * @throws Error if fetching the browser profiles fails
   */

  async getBrowserProfiles(): Promise<any[]> {
    // Authenticate before fetching profiles
    await this.authenticate()

    try {
      const response = await axios.get(`${this.apiUrl}/browser_profiles`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      })
      return response.data.data || [] // Return the profiles array from the response
    } catch (error) {
      throw new Error(`Failed to get browser profiles: ${error}`)
    }
  }

  /**
   * Start a browser profile on Dolphin Anty.
   *
   * @param profileId - Profile ID to start (defaults to the one set in the environment)
   * @param headless - Run browser in headless mode (default: false)
   * @returns Information about the started profile
   * @throws Error if no profile ID is provided and no default is set, or if starting the profile fails
   */

  async startProfile(profileId?: string, headless: boolean = false): Promise<any> {
    // Authenticate before starting the profile
    await this.authenticate()

    profileId = profileId || this.profileId
    if (!profileId) {
      throw new Error('No profile ID provided')
    }

    const url = `${this.apiUrl}/browser_profiles/${profileId}/start`
    const params: Record<string, number> = { automation: 1 }
    if (headless) {
      params.headless = 1
    }

    try {
      const response = await axios.get(url, { params })
      return response.data
    } catch (error) {
      throw new Error(`Failed to start profile: ${error}`)
    }
  }

  async stopProfile(profileId?: string): Promise<any> {
    /**
     * Stop a browser profile on Dolphin Anty.
     *
     * @param profileId - Profile ID to stop (defaults to the one set in the environment)
     * @returns Information about the stopped profile
     * @throws Error if no profile ID is provided and no default is set
     */
    // Authenticate before stopping the profile
    await this.authenticate()

    profileId = profileId || this.profileId
    if (!profileId) {
      throw new Error('No profile ID provided')
    }

    const url = `${this.apiUrl}/browser_profiles/${profileId}/stop`
    try {
      const response = await axios.get(url)
      return response.data
    } catch (error) {
      throw new Error(`Failed to stop profile: ${error}`)
    }
  }

  /**
   * Connect to a running browser profile using Playwright.
   *
   * @param profileId - Profile ID to connect to (defaults to the one set in the environment)
   * @returns The connected browser instance
   * @throws Error if authentication or profile connection fails
   */
  async connect(profileId?: string): Promise<PlaywrightBrowser> {
    // Authenticate before connecting to the profile
    await this.authenticate()

    // Start the browser profile
    const profileData = await this.startProfile(profileId)

    if (!profileData.success) {
      throw new Error(`Failed to start profile: ${JSON.stringify(profileData)}`)
    }

    const automation = profileData.automation
    const port = automation.port
    const wsEndpoint = automation.wsEndpoint
    const wsUrl = `ws://127.0.0.1:${port}${wsEndpoint}`

    // Use Playwright to connect to the browser's WebSocket endpoint
    this.playwright = chromium
    this.browser = await this.playwright.connectOverCDP(wsUrl)

    // Get or create a browser context and page
    const contexts = this.browser.contexts()
    this.context = contexts.length ? contexts[0] : await this.browser.newContext()
    const pages = this.context.pages()
    this.page = pages.length ? pages[0] : await this.context.newPage()

    this.pages = [this.page] // Initialize pages list with the first page

    return this.browser
  }

  /**
   * Close the browser connection and clean up resources.
   *
   * @param force - If true, forcefully stop the associated profile (default: false)
   */
  async close(force: boolean = false): Promise<void> {
    try {
      // Close all open pages
      if (this.pages.length) {
        for (const page of this.pages) {
          try {
            await page.close()
          } catch (e) {
            // Ignore errors during page closing
          }
        }
        this.pages = []
      }

      // Close the browser and Playwright instance
      if (this.browser) {
        await this.browser.close()
      }

      if (force) {
        await this.stopProfile() // Force stop the profile
      }
    } catch (e) {
      logger.error(`Error during browser cleanup: ${e}`)
    }
  }

  /**
   * Get the current state of the browser (URL, content, viewport size, tabs).
   *
   * @returns The current state of the browser
   * @throws Error if no active page is available
   */
  async getCurrentState(): Promise<BrowserStateSummary> {
    if (!this.page) {
      throw new Error('No active page')
    }

    // Get page content and viewport size
    const content = await this.page.content()
    const viewportSize = this.page.viewportSize()

    // Create and return the current browser state
    const state = {
      url: this.page.url(),
      tabs: await this.getTabsInfo(),
    } as BrowserStateSummary

    // Cache and return the state
    this.cachedState = state
    return state
  }
}
