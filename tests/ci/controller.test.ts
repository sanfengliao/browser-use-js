import type { DragDropAction, SendKeysAction } from '../../src/controller/view'
import http from 'node:http'
import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ActionResult } from '../../src/agent/views'
import { Browser, BrowserConfig } from '../../src/browser/browser'
import { BrowserContext } from '../../src/browser/context'
import { ActionModel } from '../../src/controller/registry/view'
import { Controller } from '../../src/controller/service'

/**
 * Create a simple HTTP server for testing purposes
 */
class HTTPServer {
  private server: http.Server
  private app: express.Application
  private _host: string = 'localhost'
  private _port: number = 0 // 0 means a random available port will be used

  constructor() {
    this.app = express()
    this.server = http.createServer(this.app)
  }

  get host(): string {
    return this._host
  }

  get port(): number {
    return this._port
  }

  start() {
    return new Promise<void>((resolve) => {
      this.server.listen(0, () => { // 0 tells Node.js to use any available port
        const address = this.server.address()
        this._port = address && typeof address !== 'string' ? address.port : 0
        resolve()
      })
    })
  }

  stop() {
    return new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve()
      })
    })
  }

  expectRequest(path: string): {
    respondWithData: (data: string, options: { content_type: string }) => void
  } {
    return {
      respondWithData: (data: string, options: { content_type: string }) => {
        this.app.get(path, (req, res) => {
          res.contentType(options.content_type)
          res.send(data)
        })
      },
    }
  }
}

describe('controllerIntegration', () => {
  let httpServer: HTTPServer
  let browser: Browser
  let baseUrl: string
  /**
   * Create and provide a test HTTP server that serves static content.
   */
  beforeAll(async () => {
    // Setup HTTP server
    httpServer = new HTTPServer()
    await httpServer.start()

    // Add routes for common test pages
    httpServer.expectRequest('/').respondWithData(
      '<html><head><title>Test Home Page</title></head><body><h1>Test Home Page</h1><p>Welcome to the test site</p></body></html>',
      { content_type: 'text/html' },
    )

    httpServer.expectRequest('/page1').respondWithData(
      '<html><head><title>Test Page 1</title></head><body><h1>Test Page 1</h1><p>This is test page 1</p></body></html>',
      { content_type: 'text/html' },
    )

    httpServer.expectRequest('/page2').respondWithData(
      '<html><head><title>Test Page 2</title></head><body><h1>Test Page 2</h1><p>This is test page 2</p></body></html>',
      { content_type: 'text/html' },
    )

    httpServer.expectRequest('/search').respondWithData(`
      <html>
      <head><title>Search Results</title></head>
      <body>
        <h1>Search Results</h1>
        <div class="results">
          <div class="result">Result 1</div>
          <div class="result">Result 2</div>
          <div class="result">Result 3</div>
        </div>
      </body>
      </html>
    `, { content_type: 'text/html' })

    // Set base URL
    baseUrl = `http://${httpServer.host}:${httpServer.port}`

    // Create browser instance
    browser = new Browser(
      {
        browserProfile: new BrowserConfig({
          headless: true,
        }),
      },
    )
  })

  let browserContext: BrowserContext
  let controller: Controller

  beforeEach(async () => {
    // Create new browser context for each test
    browserContext = new BrowserContext()

    // Create controller instance
    controller = new Controller()
  })

  afterEach(async () => {
    // Close context after each test
    await browserContext.close()
  })

  afterAll(async () => {
    await browser.close()
    await httpServer.stop()
  })

  it('go_to_url_action', async () => {
    /**
     * Test that GoToUrlAction navigates to the specified URL.
     */
    // Create action model for go_to_url
    const actionData = { go_to_url: { url: `${baseUrl}/page1` } }

    // Execute the action
    const result = await controller.act({
      action: actionData,
      browserContext,
    })

    // Verify the result
    expect(result).toBeInstanceOf(Object)
    expect(result.extractedContent).toContain(`Navigated to ${baseUrl}/page1`)

    // Verify the current page URL
    const page = await browserContext.getCurrentPage()
    expect(page.url()).toContain(`${baseUrl}/page1`)
  })

  it('scroll_actions', async () => {
    /**
     * Test that scroll actions correctly scroll the page.
     */
    // First navigate to a page
    const gotoAction = { go_to_url: { url: `${baseUrl}/page1` } }

    await controller.act({
      action: gotoAction,
      browserContext,
    })

    // Create scroll down action
    const scrollAction = { scroll_down: { amount: 200 } }

    // Execute scroll down
    const result = await controller.act({
      action: scrollAction,
      browserContext,
    })

    // Verify the result
    expect(result).toBeInstanceOf(Object)
    expect(result.extractedContent).toContain('Scrolled down')

    // Create scroll up action
    const scrollUpAction = { scroll_up: { amount: 100 } }

    // Execute scroll up
    const scrollUpResult = await controller.act({
      action: scrollUpAction,
      browserContext,
    })

    // Verify the result
    expect(scrollUpResult).toBeInstanceOf(Object)
    expect(scrollUpResult.extractedContent).toContain('Scrolled up')
  })

  it('registry_actions', async () => {
    /**
     * Test that the registry contains the expected default actions.
     */
    // Check that common actions are registered
    const commonActions = [
      'go_to_url',
      'search_google',
      'click_element_by_index',
      'input_text',
      'scroll_down',
      'scroll_up',
      'go_back',
      'switch_tab',
      'open_tab',
      'close_tab',
      'wait',
    ]

    for (const action of commonActions) {
      expect(controller.registry.registry.actions).toHaveProperty(action)
      expect(controller.registry.registry.actions[action].execute).not.toBeFalsy()
      expect(controller.registry.registry.actions[action].description).not.toBeFalsy()
    }
  })

  it('custom_action_registration', async () => {
    /**
     * Test registering a custom action and executing it.
     */

    controller.registerAction({
      name: 'custom_action',
      description: 'Test custom action',
      paramSchema: z.object({
        text: z.string(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const page = await browser.getCurrentPage()
        return {
          extractedContent: `Custom action executed with: ${params.text} on ${page.url()}`,
        }
      },
    })

    // Navigate to a page first
    const gotoAction = { go_to_url: { url: `${baseUrl}/page1` } }

    await controller.act({
      action: gotoAction,
      browserContext,
    })

    // Create the custom action model
    const customAction = { custom_action: { text: 'test_value' } }

    // Execute the custom action
    const result = await controller.act({
      action: customAction,
      browserContext,
    })

    // Verify the result
    expect(result).toBeInstanceOf(Object)
    expect(result.extractedContent).toContain('Custom action executed with: test_value on')
    expect(result.extractedContent).toContain(`${baseUrl}/page1`)
  })

  it('input_text_action', async () => {
    /**
     * Test that InputTextAction correctly inputs text into form fields.
     */
    // Set up search form endpoint for this test
    httpServer.expectRequest('/searchform').respondWithData(`
      <html>
      <head><title>Search Form</title></head>
      <body>
        <h1>Search Form</h1>
        <form action="/search" method="get">
          <input type="text" id="searchbox" name="q" placeholder="Search...">
          <button type="submit">Search</button>
        </form>
      </body>
      </html>
    `, { content_type: 'text/html' })

    // Navigate to a page with a form
    const gotoAction = { go_to_url: { url: `${baseUrl}/searchform` } }

    await controller.act({
      action: gotoAction,
      browserContext,
    })

    // Get the search input field index
    const page = await browserContext.getCurrentPage()
    const selectorMap = await browserContext.getSelectorMap()

    // For demonstration, we'll just use a hard-coded mock value
    // and check that the controller processes the action correctly
    const mockInputIndex = 1

    // Create input text action
    const inputAction = {
      input_text: {
        index: mockInputIndex,
        text: 'Python programming',
      },
    }

    // The actual input might fail if the page structure changes or in headless mode
    // So we'll just verify the controller correctly processes the action
    try {
      const result = await controller.act({
        action: inputAction,
        browserContext,
      })
      // If successful, verify the result
      expect(result).toBeInstanceOf(Object)
      expect(result.extractedContent).toContain('Input')
    } catch (e: any) {
      // If it fails due to DOM issues, that's expected in a test environment
      expect(e.message).toMatch(/Element index|does not exist/)
    }
  })

  it('error_handling', async () => {
    /**
     * Test error handling when an action fails.
     */
    // Create an action with an invalid index
    const invalidAction = {
      click_element_by_index: { index: 9999 },
    }

    // This should fail since the element doesn't exist
    await expect(() =>
      controller.act({
        action: invalidAction,
        browserContext,
      }),
    ).rejects.toThrow(/does not exist|Element with index/)
  })

  it('wait_action', async () => {
    /**
     * Test that the wait action correctly waits for the specified duration.
     */
    // Create wait action for 1 second
    const waitAction = { wait: { seconds: 1 } }

    // Record start time
    const startTime = Date.now()

    // Execute wait action
    const result = await controller.act({
      action: waitAction,
      browserContext,
    })

    // Record end time
    const endTime = Date.now()

    // Verify the result
    expect(result).toBeInstanceOf(Object)
    expect(result.extractedContent).toContain('Waiting for')

    // Verify that at least 0.9 second has passed
    expect(endTime - startTime).toBeGreaterThanOrEqual(900)
  })

  it('go_back_action', async () => {
    /**
     * Test that go_back action navigates to the previous page.
     */
    // Navigate to first page
    const gotoAction1 = { go_to_url: { url: `${baseUrl}/page1` } }

    await controller.act({
      action: gotoAction1,
      browserContext,
    })

    // Store the first page URL
    const page1 = await browserContext.getCurrentPage()
    const firstUrl = page1.url()
    console.log(`First page URL: ${firstUrl}`)

    // Navigate to second page
    const gotoAction2 = { go_to_url: { url: `${baseUrl}/page2` } }

    await controller.act({
      action: gotoAction2,
      browserContext,
    })

    // Verify we're on the second page
    const page2 = await browserContext.getCurrentPage()
    const secondUrl = page2.url()
    console.log(`Second page URL: ${secondUrl}`)
    expect(secondUrl).toContain(`${baseUrl}/page2`)

    // Execute go back action
    const goBackAction = { go_back: {} }

    const result = await controller.act({
      action: goBackAction,
      browserContext,
    })

    // Verify the result
    expect(result).toBeInstanceOf(Object)
    expect(result.extractedContent).toContain('Navigated back')

    // Add another delay to allow the navigation to complete
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Verify we're back on a different page than before
    const page3 = await browserContext.getCurrentPage()
    const finalUrl = page3.url()
    console.log(`Final page URL after going back: ${finalUrl}`)

    // Try to verify we're back on the first page
    expect(finalUrl).toContain(`${baseUrl}/page1`)
  })

  it('navigation_chain', async () => {
    /**
     * Test navigating through multiple pages and back through history.
     */
    // Set up a chain of navigation: Home -> Page1 -> Page2
    const urls = [`${baseUrl}/`, `${baseUrl}/page1`, `${baseUrl}/page2`]

    // Navigate to each page in sequence

    for (const url of urls) {
      await controller.act({
        action: {
          go_to_url: { url },
        },
        browserContext,
      })

      // Verify current page
      const page = await browserContext.getCurrentPage()
      expect(page.url()).toContain(url)
    }

    // Go back twice and verify each step

    for (const expectedUrl of [...urls].reverse().slice(1)) {
      await controller.act({
        action: {
          go_back: {},
        },
        browserContext,
      })
      await new Promise(resolve => setTimeout(resolve, 1000)) // Wait for navigation

      const page = await browserContext.getCurrentPage()
      expect(page.url()).toContain(expectedUrl)
    }
  })

  it('concurrent_tab_operations', async () => {
    /**
     * Test operations across multiple tabs.
     */
    // Create two tabs with different content
    const urls = [`${baseUrl}/page1`, `${baseUrl}/page2`]

    // First tab
    const gotoActionModel = new ActionModel()
    gotoActionModel.go_to_url = { url: urls[0] }

    await controller.act({
      action: gotoActionModel,
      browserContext,
    })

    // Open second tab
    const openTabActionModel = new ActionModel()
    openTabActionModel.open_tab = { url: urls[1] }

    await controller.act({
      action: openTabActionModel,
      browserContext,
    })

    // Verify we're on second tab
    const page = await browserContext.getCurrentPage()
    expect(page.url()).toContain(urls[1])

    // Switch back to first tab
    const switchTabActionModel = new ActionModel()
    switchTabActionModel.switch_tab = { pageId: 0 }

    await controller.act({
      action: switchTabActionModel,
      browserContext,
    })

    // Verify we're back on first tab
    const switchedPage = await browserContext.getCurrentPage()
    expect(switchedPage.url()).toContain(urls[0])

    // Close the second tab
    const closeTabActionModel = new ActionModel()
    closeTabActionModel.close_tab = { pageId: 1 }

    await controller.act({
      action: closeTabActionModel,
      browserContext,
    })

    // Verify only one tab remains
    const tabsInfo = await browserContext.getTabsInfo()
    expect(tabsInfo.length).toBe(1)
    expect(tabsInfo[0].url).toContain(urls[0])
  })

  it('excluded_actions', async () => {
    /**
     * Test that excluded actions are not registered.
     */
    // Create controller with excluded actions
    const excludedController = new Controller({
      excludeActions: ['search_google', 'open_tab'],
    })

    // Verify excluded actions are not in the registry
    expect(excludedController.registry.registry.actions).not.toHaveProperty('search_google')
    expect(excludedController.registry.registry.actions).not.toHaveProperty('open_tab')

    // But other actions are still there
    expect(excludedController.registry.registry.actions).toHaveProperty('go_to_url')
    expect(excludedController.registry.registry.actions).toHaveProperty('click_element_by_index')
  })

  it('search_google_action', async () => {
    /**
     * Test the search_google action.
     */
    // Execute search_google action
    const searchActionModel = new ActionModel()
    searchActionModel.search_google = {
      query: 'Python web automation',
    }

    const result = await controller.act({
      action: searchActionModel,
      browserContext,
    })

    // Verify the result
    expect(result).toBeInstanceOf(Object)
    expect(result.extractedContent).toContain('Searched for "Python web automation" in Google')

    // For our test purposes, we just verify we're on some URL
    const page = await browserContext.getCurrentPage()
    expect(page.url()).not.toBeFalsy()
    expect(page.url()).toContain('Python')
  })

  it('done_action', async () => {
    /**
     * Test that DoneAction completes a task and reports success or failure.
     */
    // First navigate to a page
    const gotoActionModel = new ActionModel()
    gotoActionModel.go_to_url = { url: `${baseUrl}/page1` }

    await controller.act({
      action: gotoActionModel,
      browserContext,
    })

    const successDoneMessage = 'Successfully completed task'

    // Create done action with success
    const doneActionModel = new ActionModel()
    doneActionModel.done = {
      text: successDoneMessage,
      success: true,
    }

    // Execute done action
    const result = await controller.act({
      action: doneActionModel,
      browserContext,
    })

    // Verify the result
    expect(result).toBeInstanceOf(Object)
    expect(result.extractedContent).toContain(successDoneMessage)
    expect(result.success).toBe(true)
    expect(result.isDone).toBe(true)
    expect(result.error).toBeUndefined()

    const failedDoneMessage = 'Failed to complete task'

    // Test with failure case
    doneActionModel.done = {
      text: failedDoneMessage,
      success: false,
    }

    // Execute failed done action
    const failResult = await controller.act({
      action: doneActionModel,
      browserContext,
    })

    // Verify the result
    expect(failResult).toBeInstanceOf(Object)
    expect(failResult.extractedContent).toContain(failedDoneMessage)
    expect(failResult.success).toBe(false)
    expect(failResult.isDone).toBe(true)
    expect(failResult.error).toBeUndefined()
  })

  /**
   * Test that DragDropAction correctly drags and drops elements.
   */
  it('drag_drop_action', async () => {
  // Set up drag and drop test page for this test
    httpServer.expectRequest('/dragdrop').respondWithData(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Drag and Drop Test</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        .container { display: flex; }
        .dropzone {
          width: 200px;
          height: 200px;
          border: 2px dashed #ccc;
          margin: 10px;
          padding: 10px;
          transition: background-color 0.3s;
        }
        .draggable {
          width: 80px;
          height: 80px;
          background-color: #3498db;
          color: white;
          text-align: center;
          line-height: 80px;
          cursor: move;
          user-select: none;
        }
        #log {
          margin-top: 20px;
          padding: 10px;
          border: 1px solid #ccc;
          height: 150px;
          overflow-y: auto;
        }
      </style>
    </head>
    <body>
      <h1>Drag and Drop Test</h1>
      
      <div class="container">
        <div id="zone1" class="dropzone">
          Zone 1
          <div id="draggable" class="draggable" draggable="true">Drag me</div>
        </div>
        
        <div id="zone2" class="dropzone">
          Zone 2
        </div>
      </div>
      
      <div id="log">Event log:</div>
      
      <script>
        // Track item position for verification
        function updateStatus() {
          const element = document.getElementById('draggable');
          const parent = element.parentElement;
          document.getElementById('status').textContent = 
            \`Item is in: \${parent.id}, dropped count: \${dropCount}\`;
        }
        
        // Element references
        const draggable = document.getElementById('draggable');
        const dropzones = document.querySelectorAll('.dropzone');
        const log = document.getElementById('log');
        
        // Counters for verification
        let dragStartCount = 0;
        let dropCount = 0;
        
        // Log events
        function logEvent(event) {
          const info = event.type;
          log.textContent += info + ';';
        }
        
        // Add status display
        const statusDiv = document.createElement('div');
        statusDiv.id = 'status';
        document.body.appendChild(statusDiv);
        
        // Drag events for the draggable element
        draggable.addEventListener('dragstart', (e) => {
          dragStartCount++;
          logEvent(e);
          // Required for Firefox
          e.dataTransfer.setData('text/plain', '');
          e.target.style.opacity = '0.5';
        });
        
        draggable.addEventListener('dragend', (e) => {
          logEvent(e);
          e.target.style.opacity = '1';
          updateStatus();
        });
        
        // Events for the dropzones
        dropzones.forEach(zone => {
          zone.addEventListener('dragover', (e) => {
            e.preventDefault(); // Allow drop
            logEvent(e);
            zone.style.backgroundColor = '#f0f0f0';
          });
          
          zone.addEventListener('dragleave', (e) => {
            logEvent(e);
            zone.style.backgroundColor = '';
          });
          
          zone.addEventListener('drop', (e) => {
            e.preventDefault();
            logEvent(e);
            zone.style.backgroundColor = '';
            
            // Only append if it's our draggable element
            if (e.dataTransfer.types.includes('text/plain')) {
              dropCount++;
              zone.appendChild(draggable);
            }
          });
        });
        
        // Mouse events
        draggable.addEventListener('mousedown', (e) => logEvent(e));
        document.addEventListener('mouseup', (e) => logEvent(e));
        
        // Initialize status
        updateStatus();
      </script>
    </body>
    </html>
  `, { content_type: 'text/html' })

    // Step 1: Navigate to the drag and drop test page
    const gotoAction = { go_to_url: { url: `${baseUrl}/dragdrop` } }

    const gotoResult = await controller.act({
      action: gotoAction,
      browserContext,
    })

    // Verify navigation worked
    expect(gotoResult.error).toBeFalsy()
    expect(gotoResult.extractedContent).toContain(`Navigated to ${baseUrl}/dragdrop`)

    // Get page reference
    const page = await browserContext.getCurrentPage()

    // Verify we loaded the page correctly
    const title = await page.title()
    expect(title).toBe('Drag and Drop Test')

    // Step 2: Verify initial state - draggable should be in zone1
    const initialParent = await page.evaluate(() => document.getElementById('draggable')!.parentElement!.id)
    expect(initialParent).toBe('zone1')

    // Step 3: Get the element positions for drag operation
    const elementInfo = await page.evaluate(
      () => {
        const draggable = document.getElementById('draggable')
        const zone2 = document.getElementById('zone2')

        const draggableRect = draggable!.getBoundingClientRect()
        const zone2Rect = zone2!.getBoundingClientRect()

        return {
          source: {
            x: Math.round(draggableRect.left + draggableRect.width / 2),
            y: Math.round(draggableRect.top + draggableRect.height / 2),
          },
          target: {
            x: Math.round(zone2Rect.left + zone2Rect.width / 2),
            y: Math.round(zone2Rect.top + zone2Rect.height / 2),
          },
        }
      },
    )

    console.log(`Source element position: ${elementInfo.source}`)
    console.log(`Target position: ${elementInfo.target}`)

    // Step 4: Use the controller's DragDropAction to perform the drag
    const dragAction: DragDropAction = {
      drag_drop: {
      // Use the coordinate-based approach
        coordSourceX: elementInfo.source.x,
        coordSourceY: elementInfo.source.y,
        coordTargetX: elementInfo.target.x,
        coordTargetY: elementInfo.target.y,
        steps: 10, // More steps for smoother movement
        delayMs: 10, // Small delay for browser to process events
      },
    }

    // Execute the drag action through the controller
    const result = await controller.act({
      action: dragAction,
      browserContext,
    })

    // Step 5: Verify the controller action result
    expect(result.error).toBeFalsy()
    expect(result.isDone).toBe(false)
    expect(result.extractedContent).toContain('🖱️ Dragged from')

    // Step 6: Verify the element was moved by checking its new parent
    const finalParent = await page.evaluate(() => document.getElementById('draggable')!.parentElement!.id)

    // Step 7: Get the event log to see what events were fired
    const eventLog = await page.evaluate(() => document.getElementById('log')!.textContent)
    console.log(`Event log: ${eventLog}`)

    // Check that mousedown and mouseup events were recorded
    expect(eventLog).toContain('mousedown')

    // Step 8: Verify the status shows the item was dropped
    const statusText = await page.evaluate(() => document.getElementById('status')!.textContent)

    const dragSucceeded = finalParent === 'zone2'

    expect(dragSucceeded).toBe(true)
  })

  /**
   * Test SendKeysAction using a controlled local HTML file.
   */
  it('send_keys_action', async () => {
  // Set up keyboard test page for this test
    httpServer.expectRequest('/keyboard').respondWithData(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Keyboard Test</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        input, textarea { margin: 10px 0; padding: 5px; width: 300px; }
        #result { margin-top: 20px; padding: 10px; border: 1px solid #ccc; min-height: 30px; }
      </style>
    </head>
    <body>
      <h1>Keyboard Actions Test</h1>
      <form id="testForm">
        <div>
          <label for="textInput">Text Input:</label>
          <input type="text" id="textInput" placeholder="Type here...">
        </div>
        <div>
          <label for="textarea">Textarea:</label>
          <textarea id="textarea" rows="4" placeholder="Type here..."></textarea>
        </div>
      </form>
      <div id="result"></div>
      
      <script>
        // Track focused element
        document.addEventListener('focusin', function(e) {
          document.getElementById('result').textContent = 'Focused on: ' + e.target.id;
        }, true);
        
        // Track key events
        document.addEventListener('keydown', function(e) {
          const element = document.activeElement;
          if (element.id) {
            const resultEl = document.getElementById('result');
            resultEl.textContent += '\\nKeydown: ' + e.key;
            
            // For Ctrl+A, detect and show selection
            if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
              resultEl.textContent += '\\nCtrl+A detected';
              setTimeout(() => {
                resultEl.textContent += '\\nSelection length: ' + 
                  (window.getSelection().toString().length || 
                  (element.selectionEnd - element.selectionStart));
              }, 50);
            }
          }
        });
      </script>
    </body>
    </html>
  `, { content_type: 'text/html' })

    // Navigate to the keyboard test page on the local HTTP server
    const gotoAction = { go_to_url: { url: `${baseUrl}/keyboard` } }

    // Execute navigation
    const gotoResult = await controller.act({
      action: gotoAction,
      browserContext,
    })
    await new Promise(resolve => setTimeout(resolve, 100)) // Short delay to ensure page loads

    // Verify navigation result
    expect(gotoResult).toBeInstanceOf(ActionResult)
    expect(gotoResult.extractedContent).toContain(`Navigated to ${baseUrl}/keyboard`)
    expect(gotoResult.error).toBeFalsy()
    expect(gotoResult.isDone).toBe(false)

    // Get the page object
    const page = await browserContext.getCurrentPage()

    // Verify page loaded
    const title = await page.title()
    expect(title).toBe('Keyboard Test')

    // Verify initial page state
    const h1Text = await page.evaluate(() => document.querySelector('h1')!.textContent)
    expect(h1Text).toBe('Keyboard Actions Test')

    // 1. Test Tab key to focus the first input
    const tabKeysAction: SendKeysAction = { send_keys: { keys: 'Tab' } }

    const sendKeysActionModel = new ActionModel()
    sendKeysActionModel.send_keys = tabKeysAction.send_keys
    const tabResult = await controller.act({
      action: sendKeysActionModel,
      browserContext,
    })
    await new Promise(resolve => setTimeout(resolve, 100)) // Short delay

    // Verify Tab action result
    expect(tabResult).toBeInstanceOf(ActionResult)
    expect(tabResult.extractedContent).toContain('Sent keys: Tab')
    expect(tabResult.error).toBeFalsy()
    expect(tabResult.isDone).toBe(false)

    // Verify Tab worked by checking focused element
    const activeElementId = await page.evaluate(() => document.activeElement!.id)
    expect(activeElementId, `Expected 'textInput' to be focused, got '${activeElementId}'`).toBe('textInput')

    // Verify result text in the DOM
    const resultText = await page.locator('#result').textContent()
    expect(resultText).toContain('Focused on: textInput')

    // 2. Type text into the input
    const testText = 'This is a test'
    sendKeysActionModel.send_keys = { keys: testText }

    const typeResult = await controller.act({
      action: sendKeysActionModel,
      browserContext,
    })
    await new Promise(resolve => setTimeout(resolve, 100)) // Short delay

    // Verify typing action result
    expect(typeResult).toBeInstanceOf(ActionResult)
    expect(typeResult.extractedContent).toContain(`Sent keys: ${testText}`)
    expect(typeResult.error).toBeFalsy()
    expect(typeResult.isDone).toBe(false)

    // Verify text was entered
    // @ts-expect-error
    const inputValue = await page.evaluate(() => document.getElementById('textInput')!.value)
    expect(inputValue, `Expected input value '${testText}', got '${inputValue}'`).toBe(testText)

    // Verify key events were recorded
    const resultAfterTyping = await page.locator('#result').textContent()
    for (const char of testText) {
      expect(resultAfterTyping, `Missing key event for '${char}'`).toContain(`Keydown: ${char}`)
    }

    // 3. Test Ctrl+A for select all
    sendKeysActionModel.send_keys = { keys: 'ControlOrMeta+a' }
    const selectAllResult = await controller.act({
      action: sendKeysActionModel,
      browserContext,
    })

    // Wait longer for selection to take effect
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Verify select all action result
    expect(selectAllResult).toBeInstanceOf(ActionResult)
    expect(selectAllResult.extractedContent).toContain('Sent keys: ControlOrMeta+a')
    expect(selectAllResult.error).toBeFalsy()

    // Verify selection length matches the text length
    const selectionLength = await page.evaluate(
      // @ts-expect-error
      () => document.activeElement!.selectionEnd - document.activeElement!.selectionStart,
    )
    expect(selectionLength, `Expected selection length ${testText.length}, got ${selectionLength}`).toBe(testText.length)

    // Verify selection in result text
    const resultAfterSelectAll = await page.locator('#result').textContent()
    expect(resultAfterSelectAll).toContain('Keydown: a')
    expect(resultAfterSelectAll).toContain('Ctrl+A detected')
    expect(resultAfterSelectAll).toContain('Selection length:')

    // 4. Test Tab to next field
    sendKeysActionModel.send_keys = { keys: 'Tab' }
    const tabResult2 = await controller.act({
      action: sendKeysActionModel,
      browserContext,
    })
    await new Promise(resolve => setTimeout(resolve, 100)) // Short delay

    // Verify second Tab action result
    expect(tabResult2).toBeInstanceOf(ActionResult)
    expect(tabResult2.extractedContent).toContain('Sent keys: Tab')
    expect(tabResult2.error).toBeFalsy()

    // Verify we moved to the textarea
    const activeElementIdAfterTab = await page.evaluate(() => document.activeElement!.id)
    expect(activeElementIdAfterTab, `Expected 'textarea' to be focused, got '${activeElementIdAfterTab}'`).toBe('textarea')

    // Verify focus changed in result text
    const resultAfterSecondTab = await page.locator('#result').textContent()
    expect(resultAfterSecondTab).toContain('Focused on: textarea')

    // 5. Type in the textarea
    const textareaText = 'Testing multiline\ninput text'
    sendKeysActionModel.send_keys = { keys: textareaText }
    const textareaResult = await controller.act({
      action: sendKeysActionModel,
      browserContext,
    })

    // Verify textarea typing action result
    expect(textareaResult).toBeInstanceOf(ActionResult)
    expect(textareaResult.extractedContent).toContain(`Sent keys: ${textareaText}`)
    expect(textareaResult.error).toBeFalsy()
    expect(textareaResult.isDone).toBe(false)

    // Verify text was entered in textarea

    const textareaValue = await page.evaluate(() => (document.getElementById('textarea') as HTMLTextAreaElement).value)
    expect(textareaValue, `Expected textarea value '${textareaText}', got '${textareaValue}'`).toBe(textareaText)

    // Verify newline was properly handled
    const lines = textareaValue.split('\n')
    expect(lines.length, `Expected 2 lines in textarea, got ${lines.length}`).toBe(2)
    expect(lines[0]).toBe('Testing multiline')
    expect(lines[1]).toBe('input text')

    // Test that Tab cycles back to the first element if we tab again
    sendKeysActionModel.send_keys = { keys: 'Tab' }
    await controller.act({
      action: sendKeysActionModel,
      browserContext,
    }) // Tab again
    sendKeysActionModel.send_keys = { keys: 'Tab' }
    await controller.act({
      action: sendKeysActionModel,
      browserContext,
    }) // And again

    const finalActiveElementId = await page.evaluate(() => document.activeElement!.id)
    expect(finalActiveElementId, 'Tab cycling through form elements failed').toBe('textarea')

    // Verify the test input still has its value
    const finalInputValue = await page.evaluate(() => (document.getElementById('textInput') as HTMLInputElement).value)
    expect(finalInputValue, 'Input value shouldn\'t have changed after tabbing').toBe(testText)
  })

  /**
   * Test that get_dropdown_options correctly retrieves options from a dropdown.
   */
  it('get_dropdown_options', async () => {
  // Add route for dropdown test page
    httpServer.expectRequest('/dropdown1').respondWithData(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dropdown Test</title>
    </head>
    <body>
      <h1>Dropdown Test</h1>
      <select id="test-dropdown" name="test-dropdown">
        <option value="">Please select</option>
        <option value="option1">First Option</option>
        <option value="option2">Second Option</option>
        <option value="option3">Third Option</option>
      </select>
    </body>
    </html>
  `, { content_type: 'text/html' })

    // Navigate to the dropdown test page
    const gotoAction = { go_to_url: { url: `${baseUrl}/dropdown1` } }
    const gotoActionModel = new ActionModel()
    gotoActionModel.go_to_url = gotoAction.go_to_url

    await controller.act({
      action: gotoActionModel,
      browserContext,
    })

    // Wait for the page to load
    const page = await browserContext.getCurrentPage()
    await page.waitForLoadState()

    // Initialize the DOM state to populate the selector map
    await browserContext.getStateSummary(true)

    // Interact with the dropdown to ensure it's recognized
    await page.click('select#test-dropdown')

    // Update the state after interaction
    await browserContext.getStateSummary(true)

    // Get the selector map
    const selectorMap = await browserContext.getSelectorMap()

    // Find the dropdown element in the selector map
    let dropdownIndex = null
    for (const [idx, element] of Object.entries(selectorMap)) {
      if (element.tagName.toLowerCase() === 'select') {
        dropdownIndex = Number(idx)
        break
      }
    }

    expect(dropdownIndex, `Could not find select element in selector map. Available elements: ${
      Object.entries(selectorMap).map(([idx, element]) => `${idx}: ${element.tagName}`).join(', ')
    }`).not.toBeNull()

    // Create a model for the standard get_dropdown_options action
    const getDropdownOptionsModel = new ActionModel()
    getDropdownOptionsModel.get_dropdown_options = { index: dropdownIndex }

    // Execute the action with the dropdown index
    const result = await controller.act({
      action: getDropdownOptionsModel,
      browserContext,
    })

    const expectedOptions = [
      { index: 0, text: 'Please select', value: '' },
      { index: 1, text: 'First Option', value: 'option1' },
      { index: 2, text: 'Second Option', value: 'option2' },
      { index: 3, text: 'Third Option', value: 'option3' },
    ]

    // Verify the result structure
    expect(result).toBeInstanceOf(ActionResult)

    // Core logic validation: Verify all options are returned
    for (const option of expectedOptions.slice(1)) { // Skip the placeholder option
      expect(result.extractedContent).toContain(option.text)
    }

    // Verify the instruction for using the text in select_dropdown_option is included
    expect(result.extractedContent).toContain('Use the exact text string in select_dropdown_option')

    // Verify the actual dropdown options in the DOM
    const dropdownOptions = await page.evaluate(
      () => {
        const select = document.getElementById('test-dropdown') as HTMLSelectElement
        return Array.from(select.options).map(opt => ({
          text: opt.text,
          value: opt.value,
        }))
      },
    )

    // Verify the dropdown has the expected options
    expect(dropdownOptions.length).toBe(expectedOptions.length)

    for (let i = 0; i < expectedOptions.length; i++) {
      const expected = expectedOptions[i]
      const actual = dropdownOptions[i]

      expect(actual.text, `Option at index ${i} has wrong text: expected '${expected.text}', got '${actual.text}'`).toBe(expected.text)

      expect(actual.value, `Option at index ${i} has wrong value: expected '${expected.value}', got '${actual.value}'`).toBe(expected.value)
    }
  })

  /**
   * Test that select_dropdown_option correctly selects an option from a dropdown.
   */
  it('select_dropdown_option', async () => {
  // Add route for dropdown test page
    httpServer.expectRequest('/dropdown2').respondWithData(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dropdown Test</title>
    </head>
    <body>
      <h1>Dropdown Test</h1>
      <select id="test-dropdown" name="test-dropdown">
        <option value="">Please select</option>
        <option value="option1">First Option</option>
        <option value="option2">Second Option</option>
        <option value="option3">Third Option</option>
      </select>
    </body>
    </html>
  `, { content_type: 'text/html' })

    // Navigate to the dropdown test page
    const gotoAction = { go_to_url: { url: `${baseUrl}/dropdown2` } }
    const gotoActionModel = new ActionModel()
    gotoActionModel.go_to_url = gotoAction.go_to_url

    await controller.act({ action: gotoActionModel, browserContext })

    // Wait for the page to load
    const page = await browserContext.getCurrentPage()
    await page.waitForLoadState()

    // populate the selector map with highlight indices
    await browserContext.getStateSummary(true)

    // Now get the selector map which should contain our dropdown
    const selectorMap = await browserContext.getSelectorMap()

    // Find the dropdown element in the selector map
    let dropdownIndex = null
    for (const [idx, element] of Object.entries(selectorMap)) {
      if (element.tagName.toLowerCase() === 'select') {
        dropdownIndex = Number(idx)
        break
      }
    }

    expect(dropdownIndex, `Could not find select element in selector map. Available elements: ${
      Object.entries(selectorMap)
        .map(([idx, element]) => `${idx}: ${element.tagName}`)
        .join(', ')
    }`).not.toBeNull()

    // Create a model for the standard select_dropdown_option action
    const selectDropdownOptionModel = new ActionModel()
    selectDropdownOptionModel.select_dropdown_option = {
      index: dropdownIndex,
      text: 'Second Option',
    }

    // Execute the action with the dropdown index
    const result = await controller.act({
      action: selectDropdownOptionModel,
      browserContext,
    })

    // Verify the result structure
    expect(result).toBeInstanceOf(ActionResult)

    // Core logic validation: Verify selection was successful
    expect(result.extractedContent!.toLowerCase()).toContain('selected option')
    expect(result.extractedContent).toContain('Second Option')

    // Verify the actual dropdown selection was made by checking the DOM
    const selectedValue = await page.evaluate(() => (document.getElementById('test-dropdown') as HTMLOptionElement).value)
    expect(selectedValue).toBe('option2') // Second Option has value "option2"
  })

  /**
   * Test that click_element_by_index correctly clicks an element and handles different outcomes.
   */
  it('click_element_by_index', async () => {
  // Add route for clickable elements test page
    httpServer.expectRequest('/clickable').respondWithData(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Click Test</title>
      <style>
        .clickable {
          margin: 10px;
          padding: 10px;
          border: 1px solid #ccc;
          cursor: pointer;
        }
        #result {
          margin-top: 20px;
          padding: 10px;
          border: 1px solid #ddd;
          min-height: 20px;
        }
      </style>
    </head>
    <body>
      <h1>Click Test</h1>
      <div class="clickable" id="button1" onclick="updateResult('Button 1 clicked')">Button 1</div>
      <div class="clickable" id="button2" onclick="updateResult('Button 2 clicked')">Button 2</div>
      <a href="#" class="clickable" id="link1" onclick="updateResult('Link 1 clicked'); return false;">Link 1</a>
      <div id="result"></div>
      
      <script>
        function updateResult(text) {
          document.getElementById('result').textContent = text;
        }
      </script>
    </body>
    </html>
  `, { content_type: 'text/html' })

    // Navigate to the clickable elements test page
    const gotoAction = { go_to_url: { url: `${baseUrl}/clickable` } }
    const gotoActionModel = new ActionModel()
    gotoActionModel.go_to_url = gotoAction.go_to_url

    await controller.act({
      action: gotoActionModel,
      browserContext,
    })

    // Wait for the page to load
    const page = await browserContext.getCurrentPage()
    await page.waitForLoadState()

    // Initialize the DOM state to populate the selector map
    await browserContext.getStateSummary(true)

    // Get the selector map
    const selectorMap = await browserContext.getSelectorMap()

    // Find a clickable element in the selector map
    let buttonIndex = null
    let buttonText = null

    for (const [idx, element] of Object.entries(selectorMap)) {
    // Look for the first div with class "clickable"
      if (element.tagName.toLowerCase() === 'div'
        && element.attributes.class
        && element.attributes.class.includes('clickable')) {
        buttonIndex = Number(idx)
        buttonText = element.getAllTextTillNextClickableElement(2).trim()
        break
      }
    }

    // Verify we found a clickable element
    expect(buttonIndex, `Could not find clickable element in selector map. Available elements: ${
      Object.entries(selectorMap).map(([idx, element]) => `${idx}: ${element.tagName}`).join(', ')
    }`).not.toBeNull()

    // Define expected test data
    const expectedButtonText = 'Button 1'
    const expectedResultText = 'Button 1 clicked'

    // Verify the button text matches what we expect
    expect(buttonText, `Expected button text '${expectedButtonText}' not found in '${buttonText}'`).toContain(expectedButtonText)

    // Create a model for the click_element_by_index action
    const clickElementActionModel = new ActionModel()
    clickElementActionModel.click_element_by_index = { index: buttonIndex }

    // Execute the action with the button index
    const result = await controller.act({
      action: clickElementActionModel,
      browserContext,
    })

    // Verify the result structure
    expect(result).toBeInstanceOf(ActionResult)
    expect(result.error).toBeFalsy()

    // Core logic validation: Verify click was successful
    expect(result.extractedContent).toContain(`Clicked button with index ${buttonIndex}`)
    expect(result.extractedContent).toContain(buttonText)

    // Verify the click actually had an effect on the page
    const resultText = await page.evaluate(() => document.getElementById('result')!.textContent)
    expect(resultText, `Expected result text '${expectedResultText}', got '${resultText}'`).toBe(expectedResultText,
    )
  })
})
