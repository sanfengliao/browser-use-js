import { Server } from 'node:http'
import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BrowserProfile } from '@/browser/profile'
import { BrowserSession } from '@/browser/session'
import { ActionModel } from '@/controller/registry/view'
import { Controller } from '@/controller/service'

// Set up test logging
const logger = console

class TestServer {
  private app: express.Application
  private server: Server | null = null
  public host = 'localhost'
  public port = 0 // Will be assigned when server starts

  constructor() {
    this.app = express()
    this.setupRoutes()
  }

  private setupRoutes() {
    // Add routes for test pages
    this.app.get('/page1', (req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.send('<html><head><title>Test Page 1</title></head><body><h1>Test Page 1</h1></body></html>')
    })

    this.app.get('/page2', (req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.send('<html><head><title>Test Page 2</title></head><body><h1>Test Page 2</h1></body></html>')
    })

    this.app.get('/page3', (req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.send('<html><head><title>Test Page 3</title></head><body><h1>Test Page 3</h1></body></html>')
    })

    this.app.get('/page4', (req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.send('<html><head><title>Test Page 4</title></head><body><h1>Test Page 4</h1></body></html>')
    })
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(0, this.host, () => {
        const address = this.server!.address() as any
        this.port = address.port
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }
}

describe('testTabManagement', () => {
  /** Tests for the tab management system with separate agent_current_page and human_current_page references. */

  let httpServer: TestServer
  let browserProfile: BrowserProfile
  let browserSession: BrowserSession
  let controller: Controller
  let baseUrl: string

  beforeAll(async () => {
    /** Create and provide a test HTTP server that serves static content. */
    httpServer = new TestServer()
    await httpServer.start()
    baseUrl = `http://${httpServer.host}:${httpServer.port}`
  })
  beforeEach(async () => {
    /** Create and provide a BrowserProfile with security disabled. */
    browserProfile = new BrowserProfile({ headless: true })

    /** Create and provide a BrowserSession instance with a properly initialized tab. */
    browserSession = new BrowserSession({
      browserProfile,
    })
    await browserSession.start()

    // Create an initial tab and wait for it to load completely
    await browserSession.createNewTab(`${baseUrl}/page1`)
    await new Promise(resolve => setTimeout(resolve, 1000)) // Wait for the tab to fully initialize

    // Verify that agentCurrentPage and humanCurrentPage are properly set
    expect(browserSession.agentCurrentPage).not.toBeNull()
    expect(browserSession.humanCurrentPage).not.toBeNull()
    expect(browserSession.agentCurrentPage?.url()).toContain(`${httpServer.host}:${httpServer.port}`)

    /** Create and provide a Controller instance. */
    controller = new Controller()
  })

  afterEach(async () => {
    // Ensure all pages are closed before stopping
    try {
      for (const page of browserSession.browserContext?.pages() || []) {
        if (!page.isClosed()) {
          await page.close()
        }
      }
    } catch (error) {
      // Ignore cleanup errors
    }

    await browserSession.stop()

    // Give playwright time to clean up
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  afterAll(async () => {
    await httpServer.stop()
  })

  // Helper methods

  async function executeAction(controller: Controller, browserSession: BrowserSession, actionData: any) {
    /** Generic helper to execute any action via the controller. */
    // Dynamically create an appropriate ActionModel class
    const actionType = Object.keys(actionData)[0]
    const actionValue = actionData[actionType]

    // Create the ActionModel with the single action field
    class DynamicActionModel extends ActionModel {
      [key: string]: any;
    }

    // Execute the action
    const result = await controller.act({
      action: new DynamicActionModel(actionData),
      browserContext: browserSession,
    })

    // Give the browser a moment to process the action
    await new Promise(resolve => setTimeout(resolve, 500))

    return result
  }

  async function resetTabState(browserSession: BrowserSession, baseUrl: string) {
    browserSession.humanCurrentPage = undefined
    browserSession.agentCurrentPage = undefined

    // close all existing tabs
    for (const page of browserSession.browserContext?.pages() || []) {
      await page.close()
    }

    await new Promise(resolve => setTimeout(resolve, 500))

    // open one new tab and set it as the humanCurrentPage & agentCurrentPage
    const initialTab = await browserSession.getCurrentPage()

    expect(initialTab).not.toBeNull()
    expect(browserSession.humanCurrentPage).not.toBeFalsy()
    expect(browserSession.agentCurrentPage).not.toBeFalsy()
    expect(browserSession.humanCurrentPage!.url()).toBe(initialTab.url())
    expect(browserSession.agentCurrentPage!.url()).toBe(initialTab.url())
    return initialTab
  }

  async function simulateHumanTabChange(page: any, browserSession: BrowserSession) {
    /** Simulate a user changing tabs by properly triggering events with Playwright. */

    // First bring the page to front - this is the physical action a user would take
    await page.bringToFront()

    // To simulate a user switching tabs, we need to trigger the right events
    // Use Playwright's dispatch_event method to properly trigger events from outside
    await page.dispatchEvent('body', 'focus')

    // cheat for now, because playwright really messes with foreground tab detection
    // TODO: fix this properly by triggering the right events and detecting them in playwright
    if (page.url() === 'about:blank') {
      throw new Error(
        'Cannot simulate tab change on about:blank because cannot execute JS to fire focus event on about:blank',
      )
    }
    await page.evaluate(`async () => {
            return await window._BrowserUseonTabVisibilityChange({ bubbles: true, cancelable: false });
        }`)

    // Give the event handlers time to process
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  // Tab management tests

  it('initial values', async () => {
    /** Test that open_tab correctly updates both tab references. */

    await resetTabState(browserSession, baseUrl)

    const initialTab = await browserSession.getCurrentPage()
    expect(initialTab.url()).toBe('about:blank')
    expect(browserSession.humanCurrentPage).toBe(initialTab)
    expect(browserSession.agentCurrentPage).toBe(initialTab)

    for (const page of browserSession.browserContext!.pages()) {
      await page.close()
    }

    // should never be none even after all pages are closed
    const currentTab = await browserSession.getCurrentPage()
    expect(currentTab).not.toBeNull()
    expect(currentTab.url()).toBe('about:blank')
  })

  it('agent changes tab', async () => {
    /** Test that agent_current_page changes and human_current_page remains the same when a new tab is opened. */

    const initialTab = await resetTabState(browserSession, baseUrl)
    await initialTab.goto(`${baseUrl}/page1`)
    await simulateHumanTabChange(initialTab, browserSession)
    expect(initialTab.url()).toBe(`${baseUrl}/page1`)
    const initialTabCount = browserSession.tabs.length
    expect(initialTabCount).toBe(1)

    // test opening a new tab
    const newTab = await browserSession.createNewTab(`${baseUrl}/page2`)
    const newTabCount = browserSession.browserContext!.pages().length
    expect(newTabCount).toBe(browserSession.tabs.length)
    expect(newTabCount).toBe(2) // get_current_page/create_new_tab should have auto-closed unused about:blank pages

    // test agent open new tab updates agent focus + doesn't steal human focus
    expect(browserSession.agentCurrentPage!.url()).toBe(newTab.url())
    expect(newTab.url()).toBe(`${baseUrl}/page2`)
    expect(browserSession.humanCurrentPage!.url()).toBe(initialTab.url())
    expect(initialTab.url()).toBe(`${baseUrl}/page1`)

    // test agent navigation updates agent focus +doesn't steal human focus
    await browserSession.navigate(`${baseUrl}/page3`)
    expect(browserSession.agentCurrentPage!.url()).toBe(`${baseUrl}/page3`) // agent should now be on the new tab
    expect(browserSession.humanCurrentPage!.url()).toBe(initialTab.url()) // human should still be on the very first tab
    expect(initialTab.url()).toBe(`${baseUrl}/page1`)
  })

  it('human changes tab', async () => {
    /** Test that human_current_page changes and agent_current_page remains the same when a new tab is opened. */

    const initialTab = await resetTabState(browserSession, baseUrl)
    expect(initialTab.url()).toBe('about:blank')

    // assert human opening new tab updates human focus + doesn't steal agent focus
    const newHumanTab = await browserSession.browserContext!.newPage()
    await newHumanTab.goto(`${baseUrl}/page2`)
    await simulateHumanTabChange(newHumanTab, browserSession)
    const currentAgentPage = await browserSession.getCurrentPage()
    expect(currentAgentPage.url()).toBe(initialTab.url())
    expect(initialTab.url()).toBe('about:blank')
    expect(browserSession.humanCurrentPage!.url()).toBe(newHumanTab.url())
    expect(newHumanTab.url()).toBe(`${baseUrl}/page2`)

    // test human navigating to new URL updates human focus + doesn't steal agent focus
    await newHumanTab.goto(`${baseUrl}/page3`)
    await simulateHumanTabChange(newHumanTab, browserSession)
    const currentAgentPage2 = await browserSession.getCurrentPage()
    expect(currentAgentPage2.url()).toBe(initialTab.url())
    expect(initialTab.url()).toBe('about:blank')
    expect(browserSession.humanCurrentPage!.url()).toBe(newHumanTab.url())
    expect(newHumanTab.url()).toBe(`${baseUrl}/page3`)
  })

  it('switch tab', async () => {
    /** Test that switch_tab updates both tab references. */

    // open a new tab for the human + agent to start on
    const firstTab = await resetTabState(browserSession, baseUrl)
    await browserSession.navigate(`${baseUrl}/page1`)
    await simulateHumanTabChange(firstTab, browserSession)
    expect(firstTab.url()).toBe(`${baseUrl}/page1`)

    // open a new tab that the agent will switch to automatically
    const secondTab = await browserSession.createNewTab(`${baseUrl}/page2`)
    const currentTab = await browserSession.getCurrentPage()

    // assert agent focus is on new tab and human focus is on first tab
    expect(currentTab.url()).toBe(secondTab.url())
    expect(secondTab.url()).toBe(`${baseUrl}/page2`)
    expect(secondTab.url()).toBe(browserSession.agentCurrentPage!.url())
    expect(browserSession.humanCurrentPage!.url()).toBe(firstTab.url())
    expect(firstTab.url()).toBe(`${baseUrl}/page1`)

    // Switch agent back to the first tab
    await browserSession.switchTab(0)
    await new Promise(resolve => setTimeout(resolve, 500))

    // assert agent focus is on first tab and human focus is also first tab
    const currentTab2 = await browserSession.getCurrentPage()
    expect(currentTab2.url()).toBe(firstTab.url())
    expect(firstTab.url()).toBe(`${baseUrl}/page1`)
    expect(firstTab.url()).toBe(browserSession.agentCurrentPage!.url())
    expect(browserSession.humanCurrentPage!.url()).toBe(firstTab.url())
    expect(firstTab.url()).toBe(`${baseUrl}/page1`)

    // round-trip, switch agent back to second tab
    await browserSession.switchTab(1)
    await new Promise(resolve => setTimeout(resolve, 500))

    // assert agent focus is back on second tab and human focus is still on first tab
    const currentTab3 = await browserSession.getCurrentPage()
    expect(currentTab3.url()).toBe(secondTab.url())
    expect(secondTab.url()).toBe(`${baseUrl}/page2`)
    expect(secondTab.url()).toBe(browserSession.agentCurrentPage!.url())
    expect(browserSession.humanCurrentPage!.url()).toBe(firstTab.url())
    expect(firstTab.url()).toBe(`${baseUrl}/page1`)
  })

  it('close tab', async () => {
    /** Test that closing a tab updates references correctly. */

    const initialTab = await resetTabState(browserSession, baseUrl)
    await browserSession.navigate(`${baseUrl}/page1`)
    expect(initialTab.url()).toBe(`${baseUrl}/page1`)

    // Create two tabs with different URLs
    const secondTab = await browserSession.createNewTab(`${baseUrl}/page2`)

    // Verify the second tab is now active
    const currentPage = await browserSession.getCurrentPage()
    expect(currentPage.url()).toBe(secondTab.url())
    expect(secondTab.url()).toBe(`${baseUrl}/page2`)

    // Close the second tab
    await browserSession.closeTab()
    await new Promise(resolve => setTimeout(resolve, 500))

    // Both references should be auto-updated to the first available tab
    expect(browserSession.humanCurrentPage!.url()).toBe(initialTab.url())
    expect(initialTab.url()).toBe(`${baseUrl}/page1`)
    expect(browserSession.agentCurrentPage!.url()).toBe(initialTab.url())
    expect(initialTab.url()).toBe(`${baseUrl}/page1`)
    expect(browserSession.humanCurrentPage!.isClosed()).toBe(false)
    expect(browserSession.agentCurrentPage!.isClosed()).toBe(false)

    // close the only remaining tab
    await browserSession.closeTab()
    await new Promise(resolve => setTimeout(resolve, 500))

    // close_tab should have called get_current_page, which creates a new about:blank tab if none are left
    expect(browserSession.humanCurrentPage!.url()).toBe('about:blank')
    expect(browserSession.agentCurrentPage!.url()).toBe('about:blank')
  })
})
