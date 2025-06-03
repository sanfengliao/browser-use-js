/**
 * Systematic debugging of the selector map issue.
 * Test each assumption step by step to isolate the problem.
 */

import { Server } from 'node:http'
import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ActionResult } from '../../src/agent/views'
import { BrowserProfile } from '../../src/browser/profile'
import { BrowserSession } from '../../src/browser/session'
import { Controller } from '../../src/controller/service'

class TestServer {
  private app: express.Application
  private server: Server | null = null
  public host = 'localhost'
  public port = 0

  constructor() {
    this.app = express()
    this.setupRoutes()
  }

  private setupRoutes() {
    /** Create and provide a test HTTP server that serves static content. */
    // Add routes for test pages
    this.app.get('/', (req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.send(`<html>
                <head><title>Test Home Page</title></head>
                <body>
                    <h1>Test Home Page</h1>
                    <a href="/page1" id="link1">Link 1</a>
                    <button id="button1">Button 1</button>
                    <input type="text" id="input1" />
                    <div id="div1" class="clickable">Clickable Div</div>
                </body>
                </html>`)
    })

    this.app.get('/page1', (req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.send(`<html>
                <head><title>Test Page 1</title></head>
                <body>
                    <h1>Test Page 1</h1>
                    <p>This is test page 1</p>
                    <a href="/">Back to home</a>
                </body>
                </html>`)
    })

    this.app.get('/simple', (req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.send(`<html>
                <head><title>Simple Page</title></head>
                <body>
                    <h1>Simple Page</h1>
                    <p>This is a simple test page</p>
                    <a href="/">Home</a>
                </body>
                </html>`)
    })
  }

  urlFor(path: string): string {
    return `http://${this.host}:${this.port}${path}`
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

async function createBrowserSession(): Promise<BrowserSession> {
  /** Create a real browser session for testing. */
  const session = new BrowserSession({
    browserProfile: new BrowserProfile({
      executablePath: process.env.BROWSER_PATH,

      headless: true,
    }),
  })
  await session.start()
  return session
}

function createController(): Controller {
  /** Create a controller instance. */
  return new Controller()
}

describe('browser Session Element Cache Tests', () => {
  let httpServer: TestServer
  let browserSession: BrowserSession
  let controller: Controller

  beforeAll(async () => {
    httpServer = new TestServer()
    await httpServer.start()
  })

  beforeEach(async () => {
    browserSession = await createBrowserSession()
    controller = createController()
  })

  afterEach(async () => {
    try {
      await browserSession.stop()
    } catch (error) {
      // Ignore cleanup errors
    }
  })

  afterAll(async () => {
    await httpServer.stop()
  })

  it('assumption 1 dom processing works', async () => {
    /** Test assumption 1: DOM processing works and finds elements. */
    // Go to a simple page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    // Trigger DOM processing
    const state = await browserSession.getStateSummary(false)

    console.log('DOM processing result:')
    console.log(`  - Elements found: ${Object.keys(state.selectorMap).length}`)
    console.log(`  - Element indices: ${Object.keys(state.selectorMap)}`)

    // Verify DOM processing works
    expect(Object.keys(state.selectorMap).length).toBeGreaterThan(0) // DOM processing should find elements
    expect(0 in state.selectorMap).toBe(true) // Element index 0 should exist
  })

  it('assumption 2 cached selector map persists', async () => {
    /** Test assumption 2: Cached selector map persists after get_state_summary. */
    // Go to a simple page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    // Trigger DOM processing and cache
    const state = await browserSession.getStateSummary(false)
    const initialSelectorMap = { ...state.selectorMap }

    // Check if cached selector map is still available
    const cachedSelectorMap = await browserSession.getSelectorMap()

    console.log('Selector map persistence:')
    console.log(`  - Initial elements: ${Object.keys(initialSelectorMap).length}`)
    console.log(`  - Cached elements: ${Object.keys(cachedSelectorMap).length}`)
    console.log(`  - Maps are identical: ${JSON.stringify(Object.keys(initialSelectorMap)) === JSON.stringify(Object.keys(cachedSelectorMap))}`)

    // Verify the cached map persists
    expect(Object.keys(cachedSelectorMap).length).toBeGreaterThan(0) // Cached selector map should persist
    expect(Object.keys(initialSelectorMap)).toEqual(Object.keys(cachedSelectorMap)) // Cached map should match initial map
  })

  it('assumption 3 action gets same selector map', async () => {
    /** Test assumption 3: Action gets the same selector map as cached. */
    // Go to a simple page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    // Trigger DOM processing and cache
    await browserSession.getStateSummary(false)
    const cachedSelectorMap = await browserSession.getSelectorMap()

    console.log('Pre-action state:')
    console.log(`  - Cached elements: ${Object.keys(cachedSelectorMap).length}`)
    console.log(`  - Element 0 exists in cache: ${0 in cachedSelectorMap}`)

    // Create a test action that checks the selector map it receives
    controller.registry.registerAction({
      description: 'Test: Check selector map',
      name: 'test_check_selector_map',
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser: browserSession }) => {
        const actionSelectorMap = await browserSession.getSelectorMap()
        return new ActionResult({
          extractedContent: `Action sees ${Object.keys(actionSelectorMap).length} elements, index 0 exists: ${0 in actionSelectorMap}`,
          includeInMemory: false,
        })
      },
    })

    // Execute the test action
    const result = await controller.registry.executeAction({
      actionName: 'test_check_selector_map',
      params: {},
      browser: browserSession,
    })

    console.log(`Action result: ${(result as ActionResult).extractedContent}`)

    // Verify the action sees the same selector map
    expect((result as ActionResult).extractedContent).toContain('index 0 exists: true') // Action should see element 0
  })

  it('assumption 4 click action specific issue', async () => {
    /** Test assumption 4: Specific issue with click_element_by_index action. */
    // Go to a simple page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    // Trigger DOM processing and cache
    await browserSession.getStateSummary(false)
    const cachedSelectorMap = await browserSession.getSelectorMap()

    console.log('Pre-click state:')
    console.log(`  - Cached elements: ${Object.keys(cachedSelectorMap).length}`)
    console.log(`  - Element 0 exists: ${0 in cachedSelectorMap}`)

    // Create a test action that replicates click_element_by_index logic
    controller.registry.registerAction({
      description: 'Test: Debug click logic',
      name: 'test_debug_click_logic',
      actionDependencies: {
        browser: true,
      },
      paramSchema: z.object({
        index: z.number().int().min(0),
      }),
      execute: async ({ index }, {
        browser: browserSession,
      }) => {
      // This is the exact logic from click_element_by_index
        const selectorMap = await browserSession.getSelectorMap()

        console.log(`  - Action selector map size: ${Object.keys(selectorMap).length}`)
        console.log(`  - Action selector map keys: ${Object.keys(selectorMap).slice(0, 10)}`) // First 10
        console.log(`  - Index ${index} in selector map: ${index in selectorMap}`)

        if (!(index in selectorMap)) {
          return new ActionResult({
            error: `Debug: Element with index ${index} does not exist in map of size ${Object.keys(selectorMap).length}`,
            includeInMemory: false,
          })
        }

        return new ActionResult({
          extractedContent: `Debug: Element ${index} found in map of size ${Object.keys(selectorMap).length}`,
          includeInMemory: false,
        })
      },
    })

    // Test with index 0
    const result = await controller.registry.executeAction({
      actionName: 'test_debug_click_logic',
      params: { index: 0 },
      browser: browserSession,
    }) as ActionResult

    console.log(`Debug click result: ${result.extractedContent || result.error}`)

    // This will help us see exactly what the click action sees
    if (result.error) {
      throw new Error(`Click logic debug failed: ${result.error}`)
    }
  })

  it('assumption 5 multiple get selector map calls', async () => {
    /** Test assumption 5: Multiple calls to get_selector_map return consistent results. */
    // Go to a simple page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    // Trigger DOM processing and cache
    await browserSession.getStateSummary(false)

    // Call get_selector_map multiple times
    const map1 = await browserSession.getSelectorMap()
    const map2 = await browserSession.getSelectorMap()
    const map3 = await browserSession.getSelectorMap()

    console.log('Multiple selector map calls:')
    console.log(`  - Call 1: ${Object.keys(map1).length} elements`)
    console.log(`  - Call 2: ${Object.keys(map2).length} elements`)
    console.log(`  - Call 3: ${Object.keys(map3).length} elements`)
    console.log(`  - All calls identical: ${JSON.stringify(Object.keys(map1)) === JSON.stringify(Object.keys(map2)) && JSON.stringify(Object.keys(map2)) === JSON.stringify(Object.keys(map3))}`)

    // Verify consistency
    expect(Object.keys(map1).length).toBe(Object.keys(map2).length)
    expect(Object.keys(map2).length).toBe(Object.keys(map3).length) // Multiple calls should return same size
    expect(Object.keys(map1)).toEqual(Object.keys(map2))
    expect(Object.keys(map2)).toEqual(Object.keys(map3)) // Multiple calls should return same elements
  })

  it('assumption 6 page changes affect selector map', async () => {
    /** Test assumption 6: Check if page navigation affects cached selector map. */
    // Go to first page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    // Get initial selector map
    await browserSession.getStateSummary(false)
    const initialMap = await browserSession.getSelectorMap()

    console.log('Page change test:')
    console.log(`  - Home page elements: ${Object.keys(initialMap).length}`)

    // Navigate to a different page (without calling get_state_summary)
    await page.goto(httpServer.urlFor('/page1'))
    await page.waitForLoadState()

    // Check if cached selector map is still from old page
    const cachedMapAfterNav = await browserSession.getSelectorMap()

    console.log(`  - After navigation (cached): ${Object.keys(cachedMapAfterNav).length}`)
    console.log(`  - Cache unchanged after nav: ${Object.keys(initialMap).length === Object.keys(cachedMapAfterNav).length}`)

    // Update with new page
    await browserSession.getStateSummary(false)
    const newPageMap = await browserSession.getSelectorMap()

    console.log(`  - Page 1 elements (fresh): ${Object.keys(newPageMap).length}`)

    // This will tell us if cached maps get stale
    const hasChanged = Object.keys(newPageMap).length !== Object.keys(initialMap).length
      || JSON.stringify(Object.keys(initialMap)) !== JSON.stringify(Object.keys(newPageMap))
    expect(hasChanged).toBe(true) // Different pages should have different selector maps
  })

  it('assumption 8 same browser session instance', async () => {
    /** Test assumption 8: Action gets the same browser_session instance. */
    // Go to a simple page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    console.log('=== BROWSER SESSION INSTANCE DEBUG ===')

    // Get fresh state
    await browserSession.getStateSummary(false)

    // Store the ID of our browser session instance
    const originalSessionId = `${browserSession.constructor.name}_${Math.random()}`;
    (browserSession as any)._testId = originalSessionId
    console.log(`1. Original browser_session ID: ${originalSessionId}`)
    console.log(`2. Original cache exists: ${(browserSession as any)._cachedBrowserStateSummary !== null}`)

    // Create action that checks browser session identity
    controller.registry.registerAction({
      description: 'Test: Check browser session identity',
      name: 'test_check_session_identity',
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser: browserSession }) => {
        const actionSessionId = (browserSession as any)._testId
        const cacheExists = browserSession.cachedBrowserStateSummary !== null
        return new ActionResult({
          extractedContent: `Action session ID: ${actionSessionId}, Cache exists: ${cacheExists}`,
          includeInMemory: false,
        })
      },
    })

    // Execute action
    const result = await controller.registry.executeAction({
      actionName: 'test_check_session_identity',
      params: {},
      browser: browserSession,
    }) as ActionResult

    console.log(`3. Action result: ${result.extractedContent}`)

    // Parse the result to check if session IDs match
    const actionSessionId = result.extractedContent!.split('Action session ID: ')[1]?.split(',')[0]

    if (originalSessionId === actionSessionId) {
      console.log('✅ Same browser_session instance passed to action')
    } else {
      console.log('❌ DIFFERENT browser_session instance passed to action!')
      console.log(`   Original: ${originalSessionId}`)
      console.log(`   Action:   ${actionSessionId}`)
    }
  })

  it('assumption 9 pydantic private attrs', async () => {
    /** Test assumption 9: Pydantic model validation affects private attributes. */
    // Go to a simple page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    console.log('=== PYDANTIC PRIVATE ATTRS DEBUG ===')

    // Get fresh state
    await browserSession.getStateSummary(false)

    console.log(`1. Original browser_session cache: ${(browserSession).cachedBrowserStateSummary !== null}`)
    console.log(`2. Original browser_session ID: ${browserSession.constructor.name}`)

    // Test what happens when we put browser_session through model validation
    const specialParams = {
      context: null,
      browserSession,
      browser: browserSession,
      browserContext: browserSession,
      pageExtractionLlm: null,
      availableFilePaths: null,
      hasSensitiveData: false,
    }

    console.log(`3. Before model_validate - browser_session cache: ${(browserSession).cachedBrowserStateSummary !== null}`)

    // Test the fixed version using model_construct instead of model_validate

    console.log(`4. After model_validate - original browser_session cache: ${(browserSession).cachedBrowserStateSummary !== null}`)

    // Check the browser_session that comes out of the model
    const extractedBrowserSession = specialParams.browserSession
    console.log(`5. Extracted browser_session ID: ${extractedBrowserSession.constructor.name}`)
    console.log(`6. Extracted browser_session cache: ${(extractedBrowserSession).cachedBrowserStateSummary !== null}`)

    // Check if they're the same object
    if (browserSession === extractedBrowserSession) {
      console.log('✅ Same object - no copying occurred')
    } else {
      console.log('❌ DIFFERENT object - Model validation copied the browser_session!')

      // Check if private attributes were preserved
      console.log(`7. Original has _cachedBrowserStateSummary attr: ${'_cachedBrowserStateSummary' in browserSession}`)
      console.log(`8. Extracted has _cachedBrowserStateSummary attr: ${'_cachedBrowserStateSummary' in extractedBrowserSession}`)

      if ('_cachedBrowserStateSummary' in extractedBrowserSession) {
        console.log(`9. Extracted _cachedBrowserStateSummary value: ${(extractedBrowserSession as any)._cachedBrowserStateSummary}`)
      }
    }
  })

  it('assumption 7 cache gets cleared', async () => {
    /** Test assumption 7: Check if _cached_browser_state_summary gets cleared. */
    // Go to a simple page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    console.log('=== CACHE CLEARING DEBUG ===')

    // Check initial cache state
    console.log(`1. Initial cache state: ${(browserSession as any)._cachedBrowserStateSummary}`)

    // Get fresh state
    const state = await browserSession.getStateSummary(false)
    console.log(`2. After getStateSummary: cache exists = ${(browserSession as any)._cachedBrowserStateSummary !== null}`)
    console.log(`3. Cache has ${Object.keys(state.selectorMap).length} elements`)

    // Check cache before action
    console.log(`4. Pre-action cache: ${(browserSession as any)._cachedBrowserStateSummary !== null}`)

    // Create action that checks cache state (NO page parameter)
    controller.registry.registerAction({
      description: 'Test: Check cache state no page',
      name: 'test_check_cache_state_no_page',
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser: browserSession }) => {
        const cacheExists = Boolean(browserSession.cachedBrowserStateSummary)
        let cacheSize = 0
        if (cacheExists) {
          cacheSize = Object.keys(browserSession.cachedBrowserStateSummary!.selectorMap).length
        }
        return new ActionResult({
          extractedContent: `NoPage - Cache exists: ${cacheExists}, Cache size: ${cacheSize}`,
          includeInMemory: false,
        })
      },
    })

    // Create action that checks cache state (WITH page parameter)
    controller.registry.registerAction({
      description: 'Test: Check cache state with page',
      name: 'test_check_cache_state_with_page',
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser: browserSession }) => {
        const cacheExists = Boolean(browserSession.cachedBrowserStateSummary)
        let cacheSize = 0
        if (cacheExists) {
          cacheSize = Object.keys(browserSession.cachedBrowserStateSummary!.selectorMap).length
        }
        return new ActionResult({
          extractedContent: `WithPage - Cache exists: ${cacheExists}, Cache size: ${cacheSize}`,
          includeInMemory: false,
        })
      },
    })

    // Test action WITHOUT page parameter
    const resultNoPage = await controller.registry.executeAction({
      actionName: 'test_check_cache_state_no_page',
      params: {},
      browser: browserSession,
    }) as ActionResult

    console.log(`5a. Action result (NO page): ${resultNoPage.extractedContent}`)

    // Test action WITH page parameter
    const resultWithPage = await controller.registry.executeAction({
      actionName: 'test_check_cache_state_with_page',
      params: {},
      browser: browserSession,
    }) as ActionResult

    console.log(`5b. Action result (WITH page): ${resultWithPage.extractedContent}`)
    console.log(`6. Post-action cache: ${(browserSession).cachedBrowserStateSummary !== null}`)

    // This will tell us if the page parameter injection clears the cache
  })

  it('final real click with debug', async () => {
    /** Final test: Try actual click with maximum debugging. */
    // Go to a simple page
    const page = await browserSession.getCurrentPage()
    await page.goto(httpServer.urlFor('/'))
    await page.waitForLoadState()

    console.log('=== FINAL CLICK TEST WITH FULL DEBUG ===')

    // Get fresh state
    const state = await browserSession.getStateSummary(false)
    console.log(`1. Fresh state has ${Object.keys(state.selectorMap).length} elements`)

    // Check cached map
    const cachedMap = await browserSession.getSelectorMap()
    console.log(`2. Cached map has ${Object.keys(cachedMap).length} elements`)
    console.log(`3. Element 0 in cached map: ${0 in cachedMap}`)

    // Try the real click action
    if (0 in cachedMap) {
      console.log('4. Attempting real clickElementByIndex...')
      try {
        const result = await controller.registry.executeAction({
          actionName: 'click_element_by_index',
          params: { index: 0 },
          browser: browserSession,
        }) as ActionResult
        console.log(`5. Click SUCCESS: ${result.extractedContent}`)
      } catch (error) {
        console.log(`5. Click FAILED: ${error}`)

        // Additional debug: check selector map inside the exception
        const debugMap = await browserSession.getSelectorMap()
        console.log(`6. Post-failure selector map: ${Object.keys(debugMap).length} elements`)
        console.log(`7. Element 0 still in map: ${0 in debugMap}`)

        throw error
      }
    } else {
      throw new Error('Element 0 not found in cached map - test setup issue')
    }
  })
})
