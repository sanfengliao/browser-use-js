import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { Browser, BrowserConfig } from '@/browser/browser'
import { BrowserContext } from '@/browser/context'
import { ActionModel } from '@/controller/registry/view'
import { Controller } from '@/controller/service'
import { Logger } from '@/logger'
import * as dotenv from 'dotenv'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Load environment variables
dotenv.config()

// Set up test logging
const logger = Logger.getLogger('test.browser.tab.management')

describe('tabManagement', () => {
  /**
   * Tests for the tab management system with separate agent_current_page and human_current_page references.
   */

  // Server variables
  let httpServer: Server
  let baseUrl: string
  let browser: Browser
  let serverPort: number

  // Create and provide a test HTTP server that serves static content
  beforeAll(async () => {
    // Create a simple HTTP server for test pages
    httpServer = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html')

      if (req.url === '/page1') {
        res.end('<html><head><title>Test Page 1</title></head><body><h1>Test Page 1</h1></body></html>')
      }
      else if (req.url === '/page2') {
        res.end('<html><head><title>Test Page 2</title></head><body><h1>Test Page 2</h1></body></html>')
      }
      else if (req.url === '/page3') {
        res.end('<html><head><title>Test Page 3</title></head><body><h1>Test Page 3</h1></body></html>')
      }
      else if (req.url === '/page4') {
        res.end('<html><head><title>Test Page 4</title></head><body><h1>Test Page 4</h1></body></html>')
      }
      else {
        res.statusCode = 404
        res.end('<html><body>Not found</body></html>')
      }
    })

    // Start the server on a free port
    serverPort = 3000 + Math.floor(Math.random() * 1000)
    httpServer.listen(serverPort)

    baseUrl = `http://localhost:${serverPort}`

    // Create browser instance with security disabled
    browser = new Browser(new BrowserConfig({
      headless: true,
    }))

    // Wait for browser to initialize
    await new Promise(r => setTimeout(r, 1000))
  })

  afterAll(async () => {
    // Clean up resources
    if (browser) {
      await browser.close()
    }

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
    }
  })

  // Helper methods

  /**
   * Generic helper to execute any action via the controller.
   */
  async function executeAction(controller: Controller, browserContext: BrowserContext, actions: Record<string, any>) {
    // Execute the action
    const result = await controller.act({
      actions,
      browserContext,
    })

    // Give the browser a moment to process the action
    await new Promise(r => setTimeout(r, 500))

    return result
  }

  /**
   * Helper to ensure tab references are properly synchronized before tests.
   */
  async function ensureSynchronizedState(browserContext: BrowserContext, baseUrl: string) {
    // Make sure agent_current_page and human_current_page are set and valid
    const session = await browserContext.getSession()

    if (!browserContext.agentCurrentPage || !session.context.pages().includes(browserContext.agentCurrentPage)) {
      if (session.context.pages().length) {
        browserContext.agentCurrentPage = session.context.pages()[0]
      }
      else {
        // Create a tab with the test server
        await browserContext.createNewTab(`${baseUrl}/page1`)
        await new Promise(r => setTimeout(r, 1000)) // Wait longer for tab to initialize
      }
    }
    else {
      browserContext.agentCurrentPage.goto(`${baseUrl}/page1`)
      await browserContext.agentCurrentPage.waitForLoadState('domcontentloaded')
    }

    if (!browserContext.humanCurrentPage || !session.context.pages().includes(browserContext.humanCurrentPage)) {
      browserContext.humanCurrentPage = browserContext.agentCurrentPage
    }
  }

  /**
   * Simulate a user changing tabs by properly triggering events with Playwright.
   */
  async function simulateUserTabChange(page: any, browserContext: BrowserContext) {
    logger.debug(
      `BEFORE: agent_tab=${browserContext.agentCurrentPage?.url || 'None'}, `
      + `human_current_page=${browserContext.humanCurrentPage?.url || 'None'}`,
    )
    logger.debug(`Simulating user changing to -> ${page.url}`)

    // First bring the page to front - this is the physical action a user would take
    await page.bringToFront()

    // To simulate a user switching tabs, we need to trigger the right events
    // Use Playwright's evaluate method to properly trigger events from outside
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    logger.debug('Dispatched window.focus event')

    // Give the event handlers time to process
    await new Promise(r => setTimeout(r, 500))

    logger.debug(
      `AFTER: agent_tab URL=${browserContext.agentCurrentPage?.url || 'None'}, `
      + `human_current_page URL=${browserContext.humanCurrentPage?.url || 'None'}`,
    )
  }

  // Tab management tests

  it('test_open_tab_updates_both_references', async () => {
    /**
     * Test that open_tab correctly updates both tab references.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })

    try {
      // Ensure tab references are synchronized
      await ensureSynchronizedState(browserContext, baseUrl)

      // Store initial tab count and references
      const session = await browserContext.getSession()
      const initialTabCount = session.context.pages().length
      const initialAgentTab = browserContext.agentCurrentPage

      // Open a new tab directly via BrowserContext
      await browserContext.createNewTab(`${baseUrl}/page2`)

      // Give time for events to process
      await new Promise(r => setTimeout(r, 1000))

      // Verify a new tab was created
      const updatedSession = await browserContext.getSession()
      expect(updatedSession.context.pages().length).toBe(initialTabCount + 1)

      // Both references should be set to the new tab and different from initial tab
      expect(browserContext.humanCurrentPage).not.toBeNull()
      expect(browserContext.agentCurrentPage).not.toBeNull()
      expect(browserContext.humanCurrentPage).toBe(browserContext.agentCurrentPage)
      expect(initialAgentTab).not.toBe(browserContext.agentCurrentPage)
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page2`)
    }
    finally {
      await browserContext.close()
    }
  })

  it('test_switch_tab_updates_both_references', async () => {
    /**
     * Test that switch_tab updates both tab references.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })

    try {
      // Ensure we start with at least one tab
      await ensureSynchronizedState(browserContext, baseUrl)

      // Create a new tab in addition to existing one
      await browserContext.createNewTab(`${baseUrl}/page2`)
      await new Promise(r => setTimeout(r, 1000))

      // Verify we now have the second tab active
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page2`)

      // Switch to the first tab
      const session = await browserContext.getSession()
      const firstTab = session.context.pages()[0]
      await browserContext.switchToTab(0)
      await new Promise(r => setTimeout(r, 500))

      // Both references should point to the first tab
      expect(browserContext.humanCurrentPage).not.toBeNull()
      expect(browserContext.agentCurrentPage).not.toBeNull()
      expect(browserContext.humanCurrentPage).toBe(browserContext.agentCurrentPage)
      expect(browserContext.agentCurrentPage).toBe(firstTab)
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page1`)

      // Verify the underlying page is correct by checking we can interact with it
      const page = await browserContext.getAgentCurrentPage()
      const title = await page.title()
      expect(title).toContain('Test Page 1')
    }
    finally {
      await browserContext.close()
    }
  })

  it('test_close_tab_handles_references_correctly', async () => {
    /**
     * Test that closing a tab updates references correctly.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })

    try {
      // Ensure we start with at least one tab
      await ensureSynchronizedState(browserContext, baseUrl)

      // Create two tabs with different URLs
      const initialTab = browserContext.agentCurrentPage
      await browserContext.createNewTab(`${baseUrl}/page2`)
      await new Promise(r => setTimeout(r, 1000))

      // Verify the second tab is now active
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page2`)

      // Close the current tab
      await browserContext.closeCurrentTab()
      await new Promise(r => setTimeout(r, 500))

      // Both references should be updated to the remaining available tab
      expect(browserContext.humanCurrentPage).not.toBeNull()
      expect(browserContext.agentCurrentPage).not.toBeNull()
      expect(browserContext.humanCurrentPage).toBe(browserContext.agentCurrentPage)
      expect(browserContext.agentCurrentPage).toBe(initialTab)
      expect(browserContext.humanCurrentPage?.isClosed()).toBe(false)
      expect(browserContext.humanCurrentPage?.url()).toContain(`${baseUrl}/page1`)
    }
    finally {
      await browserContext.close()
    }
  })

  it('test_user_changes_tab', async () => {
    /**
     * Test that agent_current_page is preserved when user changes the foreground tab.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })

    try {
      // Ensure we start with at least one tab
      await ensureSynchronizedState(browserContext, baseUrl)

      // Create a second tab with a different URL
      await browserContext.createNewTab(`${baseUrl}/page2`)
      await new Promise(r => setTimeout(r, 1000))
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page2`)

      // Switch back to the first tab for the agent
      const session = await browserContext.getSession()
      const firstTab = session.context.pages()[0]
      await browserContext.switchToTab(0)
      await simulateUserTabChange(firstTab, browserContext)
      await new Promise(r => setTimeout(r, 500))

      // Store agent's active tab
      const agentTab = browserContext.agentCurrentPage
      expect(agentTab?.url()).toContain(`${baseUrl}/page1`)

      // Simulate user switching to the second tab
      const updatedSession = await browserContext.getSession()
      const userTab = updatedSession.context.pages()[1] // Second tab

      // First, log the visibility listeners
      const listeners = await userTab.evaluate(() => Object.keys(window).filter(k => k.startsWith('onVisibilityChange')))
      logger.debug(`Tab visibility listeners: ${listeners}`)

      // Make sure handlers exist before attempting to trigger them
      expect(listeners.length).toBeGreaterThan(0)

      // Now try the simulation
      await simulateUserTabChange(userTab, browserContext)

      // Verify agent_current_page remains unchanged while human_current_page changed
      expect(browserContext.agentCurrentPage).toBe(agentTab)
      expect(browserContext.humanCurrentPage).not.toBe(browserContext.agentCurrentPage)
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page1`)
      expect(browserContext.humanCurrentPage?.url()).toContain(`${baseUrl}/page2`)
    }
    finally {
      await browserContext.close()
    }
  })

  it('test_get_agent_current_page', async () => {
    /**
     * Test that get_agent_current_page returns agent_current_page regardless of human_current_page.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })

    try {
      // Ensure we start with at least one tab
      await ensureSynchronizedState(browserContext, baseUrl)

      // Create a second tab with a different URL
      await browserContext.createNewTab(`${baseUrl}/page2`)
      await new Promise(r => setTimeout(r, 1000))

      // Switch back to the first tab for the agent
      await browserContext.switchToTab(0)
      await new Promise(r => setTimeout(r, 500))

      // Simulate user switching to the second tab
      const session = await browserContext.getSession()
      const userTab = session.context.pages()[1] // Second tab
      await simulateUserTabChange(userTab, browserContext)

      // Verify get_agent_current_page returns agent's tab, not foreground tab
      const agentPage = await browserContext.getAgentCurrentPage()
      expect(agentPage).toBe(browserContext.agentCurrentPage)
      expect(agentPage).not.toBe(browserContext.humanCurrentPage)
      expect(agentPage.url()).toContain(`${baseUrl}/page1`)

      // Call a method on the page to verify it's fully functional
      const title = await agentPage.title()
      expect(title).toContain('Test Page 1')
    }
    finally {
      await browserContext.close()
    }
  })

  it('test_browser_operations_use_agent_current_page', async () => {
    /**
     * Test that browser operations use agent_current_page, not human_current_page.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })

    try {
      // Ensure we start with at least one tab
      await ensureSynchronizedState(browserContext, baseUrl)

      // Create a second tab with a different URL
      await browserContext.createNewTab(`${baseUrl}/page2`)
      await new Promise(r => setTimeout(r, 1000))

      // Switch back to the first tab for the agent
      await browserContext.switchToTab(0)
      await new Promise(r => setTimeout(r, 500))

      // Simulate user switching to the second tab
      const session = await browserContext.getSession()
      const userTab = session.context.pages()[1] // Second tab
      await simulateUserTabChange(userTab, browserContext)

      // Verify we have the setup we want
      expect(browserContext.humanCurrentPage).not.toBe(browserContext.agentCurrentPage)
      expect(browserContext.humanCurrentPage?.url()).toContain(`${baseUrl}/page2`)
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page1`)

      // Execute a navigation directly on agent's tab
      const agentPage = await browserContext.getAgentCurrentPage()
      await agentPage.goto(`${baseUrl}/page3`)
      await new Promise(r => setTimeout(r, 500))

      // Verify navigation happened on agent_current_page
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page3`)
      // But human_current_page remains unchanged
      expect(browserContext.humanCurrentPage?.url()).toContain(`${baseUrl}/page2`)
    }
    finally {
      await browserContext.close()
    }
  })

  it('test_tab_reference_recovery', async () => {
    /**
     * Test recovery when a tab reference becomes invalid.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })

    try {
      // Ensure we start with at least one valid tab
      await ensureSynchronizedState(browserContext, baseUrl)

      // Create a second tab so we have multiple
      await browserContext.createNewTab(`${baseUrl}/page2`)
      await new Promise(r => setTimeout(r, 1000));

      // Deliberately corrupt the agent_current_page reference
      (browserContext as any).agentCurrentPage = null

      // Call get_agent_current_page, which should recover the reference
      const agentPage = await browserContext.getAgentCurrentPage()

      // Verify recovery worked
      expect(agentPage).not.toBeNull()
      expect(agentPage.isClosed()).toBe(false)

      // Verify the tab is fully functional
      const title = await agentPage.title()
      expect(title).toBeTruthy()

      // Verify both references are now valid again
      expect(browserContext.agentCurrentPage).not.toBeNull()
      expect(browserContext.humanCurrentPage).not.toBeNull()
    }
    finally {
      await browserContext.close()
    }
  })

  it('test_reconcile_tab_state_handles_both_invalid', async () => {
    /**
     * Test that reconcile_tab_state can recover when both tab references are invalid.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })

    try {
      // Ensure we start with at least one valid tab
      await ensureSynchronizedState(browserContext, baseUrl);

      // Corrupt both references
      (browserContext as any).agentCurrentPage = null;
      (browserContext as any).humanCurrentPage = null

      // Call reconcile_tab_state directly
      await browserContext.reconcileTabState()

      // Verify both references are restored
      expect(browserContext.agentCurrentPage).not.toBeNull()
      expect(browserContext.humanCurrentPage).not.toBeNull()
      // and they are the same tab
      expect(browserContext.agentCurrentPage).toBe(browserContext.humanCurrentPage)
      // and the tab is valid
      expect(browserContext.agentCurrentPage?.isClosed()).toBe(false)
    }
    finally {
      await browserContext.close()
    }
  })

  it('test_race_condition_resilience', async () => {
    /**
     * Test resilience against race conditions in tab operations.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })

    try {
      // Ensure we start with at least one valid tab
      await ensureSynchronizedState(browserContext, baseUrl)

      // Create two more tabs to have three in total
      await browserContext.createNewTab(`${baseUrl}/page2`)
      await new Promise(r => setTimeout(r, 500))
      await browserContext.createNewTab(`${baseUrl}/page3`)
      await new Promise(r => setTimeout(r, 500))

      // Verify we have at least 3 tabs
      const session = await browserContext.getSession()
      expect(session.context.pages().length).toBeGreaterThanOrEqual(3)

      // Perform a series of rapid tab switches to simulate race conditions
      for (let i = 0; i < 5; i++) {
        const tabIndex = i % 3
        await browserContext.switchToTab(tabIndex)
        await new Promise(r => setTimeout(r, 100)) // Very short delay between switches
      }

      // Verify the state is consistent after rapid operations
      expect(browserContext.humanCurrentPage).not.toBeNull()
      expect(browserContext.agentCurrentPage).not.toBeNull()
      expect(browserContext.humanCurrentPage).toBe(browserContext.agentCurrentPage)
      expect(browserContext.humanCurrentPage?.isClosed()).toBe(false)

      // Verify we can still navigate on the final tab
      const page = await browserContext.getAgentCurrentPage()
      await page.goto(`${baseUrl}/page4`)
      expect(page.url()).toContain(`${baseUrl}/page4`)
    }
    finally {
      await browserContext.close()
    }
  })

  it('test_tab_management_using_controller_actions', async () => {
    /**
     * Test tab management using Controller actions instead of directly calling browser_context methods,
     * ensuring that both human and agent tab detection works correctly.
     */
    // Create context for this test
    const browserContext = new BrowserContext({ browser })
    const controller = new Controller()

    try {
      class OpenTabActionModel extends ActionModel {
        constructor(public open_tab: { url: string }) {
          super()
        }
      }

      class SwitchTabActionModel extends ActionModel {
        constructor(public switch_tab: { pageId: number }) {
          super()
        }
      }

      class GoToUrlTabActionModel extends ActionModel {
        constructor(public go_to_url: { url: string }) {
          super()
        }
      }

      class CloseTabActionModel extends ActionModel {
        constructor(public close_tab: { pageId: number }) {
          super()
        }
      }
      // Ensure we start with at least one tab
      await ensureSynchronizedState(browserContext, baseUrl)

      // Make sure we have a clean single tab to start with
      let session = await browserContext.getSession()
      while (session.context.pages().length > 1) {
        await browserContext.closeCurrentTab()
        await new Promise(r => setTimeout(r, 500))
        session = await browserContext.getSession()
      }

      // Store the initial tab for reference
      const initialTab = browserContext.agentCurrentPage
      const initialTabId = 0

      // Create second tab with OpenTabAction

      await controller.act({
        actions: new OpenTabActionModel({ url: `${baseUrl}/page2` }),
        browserContext,
      })
      await new Promise(r => setTimeout(r, 1000)) // Wait for the tab to fully initialize

      // Verify the second tab is opened and active for both agent and human
      const secondTab = browserContext.agentCurrentPage
      expect(browserContext.humanCurrentPage).toBe(browserContext.agentCurrentPage)
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page2`)
      const secondTabId = 1

      // Create third tab with OpenTabAction

      await controller.act({
        actions: new OpenTabActionModel({ url: `${baseUrl}/page3` }),
        browserContext,
      })
      await new Promise(r => setTimeout(r, 1000)) // Wait for the tab to fully initialize

      // Verify the third tab is opened and active
      const thirdTab = browserContext.agentCurrentPage
      expect(browserContext.humanCurrentPage).toBe(browserContext.agentCurrentPage)
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page3`)
      const thirdTabId = 2

      // Use SwitchTabAction to go back to the first tab (for the agent)

      await controller.act({
        actions: new SwitchTabActionModel({ pageId: initialTabId }),
        browserContext,
      })
      await new Promise(r => setTimeout(r, 500))

      // Verify agent is now on the first tab
      expect(browserContext.agentCurrentPage).toBe(initialTab)
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page1`)
      expect(browserContext.humanCurrentPage).toBe(browserContext.agentCurrentPage)

      // Simulate human switching to the second tab
      await simulateUserTabChange(secondTab, browserContext)
      await new Promise(r => setTimeout(r, 500))

      // Verify human and agent are on different tabs
      expect(browserContext.humanCurrentPage).toBe(secondTab)
      expect(browserContext.agentCurrentPage).toBe(initialTab)
      expect(browserContext.humanCurrentPage).not.toBe(browserContext.agentCurrentPage)
      expect(browserContext.humanCurrentPage?.url()).toContain(`${baseUrl}/page2`)
      expect(browserContext.agentCurrentPage?.url()).toContain(`${baseUrl}/page1`)

      // Use GoToUrlAction to navigate the agent's tab to a new URL
      await controller.act({
        actions: new GoToUrlTabActionModel({ url: `${baseUrl}/page4` }),
        browserContext,
      })
      await new Promise(r => setTimeout(r, 500))

      // Refresh the agent's page reference and verify navigation
      const agentPage = await browserContext.getAgentCurrentPage()
      expect(agentPage).not.toBeNull()
      expect(agentPage.url()).toContain(`${baseUrl}/page4`)

      // Verify human's tab remains unchanged
      expect(browserContext.humanCurrentPage?.url()).toContain(`${baseUrl}/page2`)

      // Use CloseTabAction to close the third tab

      await controller.act({
        actions: new CloseTabActionModel({
          pageId: thirdTabId,
        }),
        browserContext,
      })
      await new Promise(r => setTimeout(r, 1000)) // Extended wait to ensure tab cleanup

      // Verify tab was closed
      session = await browserContext.getSession()
      expect(session.context.pages().length).toBe(2)

      // Close the second tab, which is the human's current tab
      const closeTabAction2 = { close_tab: { pageId: secondTabId } }
      await controller.act({
        actions: closeTabAction2,
        browserContext,
      })
      await new Promise(r => setTimeout(r, 1000)) // Extended wait to ensure tab cleanup

      // Verify we have only one tab left
      session = await browserContext.getSession()
      expect(session.context.pages().length).toBe(1)

      // Refresh references and verify both human and agent point to the same tab
      await browserContext.reconcileTabState()
      expect(browserContext.humanCurrentPage).not.toBeNull()
      expect(browserContext.agentCurrentPage).not.toBeNull()
      expect(browserContext.humanCurrentPage).toBe(browserContext.agentCurrentPage)

      // Verify the URL of the remaining tab
      const finalPage = await browserContext.getCurrentPage()
      expect(finalPage.url()).toContain(baseUrl)
    }
    finally {
      await browserContext.close()
    }
  })
})
