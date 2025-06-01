import { Server } from 'node:http'
import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BrowserProfile, BrowserSession } from '@/browser/session'
import { DOMElementNode } from '@/dom/views'

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
      res.send('<html><head><title>Test Home Page</title></head><body><h1>Test Home Page</h1><p>Welcome to the test site</p></body></html>')
    })

    this.app.get('/scroll_test', (req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.send(`
            <html>
            <head>
                <title>Scroll Test</title>
                <style>
                    body { height: 3000px; }
                    .marker { position: absolute; }
                    #top { top: 0; }
                    #middle { top: 1000px; }
                    #bottom { top: 2000px; }
                </style>
            </head>
            <body>
                <div id="top" class="marker">Top of the page</div>
                <div id="middle" class="marker">Middle of the page</div>
                <div id="bottom" class="marker">Bottom of the page</div>
            </body>
            </html>
            `)
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

describe('testBrowserContext', () => {
  /** Tests for browser context functionality using real browser instances. */

  let httpServer: TestServer
  let baseUrl: string
  let browserSession: BrowserSession

  beforeAll(async () => {
    httpServer = new TestServer()
    await httpServer.start()
    /** Return the base URL for the test HTTP server. */
    baseUrl = httpServer.urlFor('')
  })
  beforeEach(async () => {
    /** Create and provide a BrowserSession instance with security disabled. */
    browserSession = new BrowserSession({
      browserProfile: new BrowserProfile({
        headless: true,
      }),
    })
    await browserSession.start()
  })

  afterEach(async () => {
    await browserSession.stop()
  })

  afterAll(async () => {
    await httpServer.stop()
  })

  it('is url allowed', () => {
    /**
     * Test the _is_url_allowed method to verify that it correctly checks URLs against
     * the allowed domains configuration.
     */
    // Scenario 1: allowed_domains is None, any URL should be allowed.
    const config1 = new BrowserProfile({ allowedDomains: undefined })
    const context1 = new BrowserSession({ browserProfile: config1 })
    expect(context1.isUrlAllowed('http://anydomain.com')).toBe(true)
    expect(context1.isUrlAllowed('https://anotherdomain.org/path')).toBe(true)

    // Scenario 2: allowed_domains is provided.
    // Note: match_url_with_domain_pattern defaults to https:// scheme when none is specified
    const allowed = ['https://example.com', 'http://example.com', 'http://*.mysite.org', 'https://*.mysite.org']
    const config2 = new BrowserProfile({ allowedDomains: allowed })
    const context2 = new BrowserSession({ browserProfile: config2 })

    // URL exactly matching
    expect(context2.isUrlAllowed('http://example.com')).toBe(true)
    // URL with subdomain (should not be allowed)
    expect(context2.isUrlAllowed('http://sub.example.com/path')).toBe(false)
    // URL with subdomain for wildcard pattern (should be allowed)
    expect(context2.isUrlAllowed('http://sub.mysite.org')).toBe(true)
    // URL that matches second allowed domain
    expect(context2.isUrlAllowed('https://mysite.org/page')).toBe(true)
    // URL with port number, still allowed (port is stripped)
    expect(context2.isUrlAllowed('http://example.com:8080')).toBe(true)
    expect(context2.isUrlAllowed('https://example.com:443')).toBe(true)

    // Scenario 3: Malformed URL or empty domain
    // urlparse will return an empty netloc for some malformed URLs.
    expect(context2.isUrlAllowed('notaurl')).toBe(false)
  })

  it('convert simple xpath to css selector', () => {
    /**
     * Test the _convert_simple_xpath_to_css_selector method of BrowserSession.
     * This verifies that simple XPath expressions are correctly converted to CSS selectors.
     */
    // Test empty xpath returns empty string
    expect(BrowserSession.convertSimpleXPathToCssSelector('')).toBe('')

    // Test a simple xpath without indices
    const xpath = '/html/body/div/span'
    const expected = 'html > body > div > span'
    const result = BrowserSession.convertSimpleXPathToCssSelector(xpath)
    expect(result).toBe(expected)

    // Test xpath with an index on one element: [2] should translate to :nth-of-type(2)
    const xpath2 = '/html/body/div[2]/span'
    const expected2 = 'html > body > div:nth-of-type(2) > span'
    const result2 = BrowserSession.convertSimpleXPathToCssSelector(xpath2)
    expect(result2).toBe(expected2)

    // Test xpath with indices on multiple elements
    const xpath3 = '/ul/li[3]/a[1]'
    const expected3 = 'ul > li:nth-of-type(3) > a:nth-of-type(1)'
    const result3 = BrowserSession.convertSimpleXPathToCssSelector(xpath3)
    expect(result3).toBe(expected3)
  })

  it('enhanced css selector for element', () => {
    /**
     * Test the _enhanced_css_selector_for_element method to verify that
     * it returns the correct CSS selector string for a DOMElementNode.
     */
    // Create a DOMElementNode instance with a complex set of attributes
    const dummyElement = new DOMElementNode({
      tagName: 'div',
      isVisible: true,
      parent: undefined,
      xpath: '/html/body/div[2]',
      attributes: {
        'class': 'foo bar',
        'id': 'my-id',
        'placeholder': 'some "quoted" text',
        'data-testid': '123',
      },
      children: [],
    })

    // Call the method with include_dynamic_attributes=True
    const actualSelector = BrowserSession.enhancedCssSelectorForElement(dummyElement, true)

    // Expected conversion includes the xpath conversion, class attributes, and other attributes
    const expectedSelector = 'html > body > div:nth-of-type(2).foo.bar[id="my-id"][placeholder*="some \\"quoted\\" text"][data-testid="123"]'
    expect(actualSelector).toBe(expectedSelector)
  })

  it('navigate and get current page', async () => {
    /** Test that navigate method changes the URL and get_current_page returns the proper page. */
    // Navigate to the test page
    await browserSession.navigate(`${baseUrl}/`)

    // Get the current page
    const page = await browserSession.getCurrentPage()

    // Verify the page URL matches what we navigated to
    expect(page.url()).toContain(`${baseUrl}/`)

    // Verify the page title
    const title = await page.title()
    expect(title).toBe('Test Home Page')
  })

  it('refresh page', async () => {
    /** Test that refresh_page correctly reloads the current page. */
    // Navigate to the test page
    await browserSession.navigate(`${baseUrl}/`)

    // Get the current page before refresh
    const pageBefore = await browserSession.getCurrentPage()

    // Refresh the page
    await browserSession.refresh()

    // Get the current page after refresh
    const pageAfter = await browserSession.getCurrentPage()

    // Verify it's still on the same URL
    expect(pageAfter.url()).toBe(pageBefore.url())

    // Verify the page title is still correct
    const title = await pageAfter.title()
    expect(title).toBe('Test Home Page')
  })

  it('execute javascript', async () => {
    /** Test that execute_javascript correctly executes JavaScript in the current page. */
    // Navigate to a test page
    await browserSession.navigate(`${baseUrl}/`)

    // Execute a simple JavaScript snippet that returns a value
    const result = await browserSession.executeJavascript(() => document.title)

    // Verify the result
    expect(result).toBe('Test Home Page')

    // Execute JavaScript that modifies the page
    await browserSession.executeJavascript(() => {
      document.body.style.backgroundColor = 'red'
    })

    // Verify the change by reading back the value
    const bgColor = await browserSession.executeJavascript(() => document.body.style.backgroundColor)
    expect(bgColor).toBe('red')
  })

  it('get scroll info', async () => {
    /** Test that get_scroll_info returns the correct scroll position information. */
    // Navigate to the scroll test page
    await browserSession.navigate(`${baseUrl}/scroll_test`)
    const page = await browserSession.getCurrentPage()

    // Get initial scroll info
    const { pixelsAbove: pixelsAboveInitial, pixelsBelow: pixelsBelowInitial } = await browserSession.getScrollInfo(page)

    // Verify initial scroll position
    expect(pixelsAboveInitial).toBe(0) // 'Initial scroll position should be at the top'
    expect(pixelsBelowInitial).toBeGreaterThan(0) // 'There should be content below the viewport'

    // Scroll down the page
    await browserSession.executeJavascript(() => window.scrollBy(0, 500))
    await new Promise(resolve => setTimeout(resolve, 200)) // Brief delay for scroll to complete

    // Get new scroll info
    const { pixelsAbove: pixelsAboveAfterScroll, pixelsBelow: pixelsBelowAfterScroll } = await browserSession.getScrollInfo(page)

    // Verify new scroll position
    expect(pixelsAboveAfterScroll).toBeGreaterThan(0) // 'Page should be scrolled down'
    expect(pixelsAboveAfterScroll).toBeGreaterThanOrEqual(400) // 'Page should be scrolled down at least 400px'
    expect(pixelsBelowAfterScroll).toBeLessThan(pixelsBelowInitial) // 'Less content should be below viewport after scrolling'
  })

  it('take screenshot', async () => {
    /** Test that take_screenshot returns a valid base64 encoded image. */
    // Navigate to the test page
    await browserSession.navigate(`${baseUrl}/`)

    // Take a screenshot
    const screenshotBase64 = await browserSession.takeScreenshot()

    // Verify the screenshot is a valid base64 string
    expect(typeof screenshotBase64).toBe('string')
    expect(screenshotBase64.length).toBeGreaterThan(0)

    // Verify it can be decoded as base64
    try {
      const imageData = Buffer.from(screenshotBase64, 'base64')
      // Verify the data starts with a valid image signature (PNG file header)
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
      expect(imageData.subarray(0, 8)).toEqual(pngHeader) // 'Screenshot is not a valid PNG image'
    } catch (e) {
      throw new Error(`Failed to decode screenshot as base64: ${e}`)
    }
  })

  it('switch tab operations', async () => {
    /** Test tab creation, switching, and closing operations. */
    // Navigate to home page in first tab
    await browserSession.navigate(`${baseUrl}/`)

    // Create a new tab
    await browserSession.createNewTab(`${baseUrl}/scroll_test`)

    // Verify we have two tabs now
    const tabsInfo = await browserSession.getTabsInfo()
    expect(tabsInfo.length).toBe(2) // 'Should have two tabs open'

    // Verify current tab is the scroll test page
    const currentPage = await browserSession.getCurrentPage()
    expect(currentPage.url()).toContain(`${baseUrl}/scroll_test`)

    // Switch back to the first tab
    await browserSession.switchToTab(0)

    // Verify we're back on the home page
    const currentPageAfterSwitch = await browserSession.getCurrentPage()
    expect(currentPageAfterSwitch.url()).toContain(`${baseUrl}/`)

    // Close the second tab
    await browserSession.closeTab(1)

    // Verify we only have one tab left
    const tabsInfoAfterClose = await browserSession.getTabsInfo()
    expect(tabsInfoAfterClose.length).toBe(1) // 'Should have one tab open after closing the second'
  })

  it('remove highlights', async () => {
    /** Test that remove_highlights successfully removes highlight elements. */
    // Navigate to a test page
    await browserSession.navigate(`${baseUrl}/`)

    // Add a highlight via JavaScript
    await browserSession.executeJavascript(() => {
      const container = document.createElement('div')
      container.id = 'playwright-highlight-container'
      document.body.appendChild(container)

      const highlight = document.createElement('div')
      highlight.id = 'playwright-highlight-1'
      container.appendChild(highlight)

      const element = document.querySelector('h1') as HTMLElement
      element.setAttribute('browser-user-highlight-id', 'playwright-highlight-1')
    })

    // Verify the highlight container exists
    const containerExists = await browserSession.executeJavascript(
      () => document.getElementById('playwright-highlight-container') !== null,
    )
    expect(containerExists).toBe(true) // 'Highlight container should exist before removal'

    // Call remove_highlights
    await browserSession.removeHighlights()

    // Verify the highlight container was removed
    const containerExistsAfter = await browserSession.executeJavascript(
      () => document.getElementById('playwright-highlight-container') !== null,
    )
    expect(containerExistsAfter).toBe(false) // 'Highlight container should be removed'

    // Verify the highlight attribute was removed from the element
    const attributeExists = await browserSession.executeJavascript(
      () => document.querySelector('h1')!.hasAttribute('browser-user-highlight-id'),
    )
    expect(attributeExists).toBe(false) // 'browser-user-highlight-id attribute should be removed'
  })
})
