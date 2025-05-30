import type { BrowserStateSummary } from '@/browser/views'
import { BrowserContext, BrowserContextConfig } from '@/browser/context'
import { DOMElementNode } from '@/dom/views'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('browserContext tests', () => {
  it('test_is_url_allowed', () => {
    /**
     * Test the _is_url_allowed method to verify that it correctly checks URLs against
     * the allowed domains configuration.
     * Scenario 1: When allowed_domains is None, all URLs should be allowed.
     * Scenario 2: When allowed_domains is a list, only URLs matching the allowed domain(s) are allowed.
     * Scenario 3: When the URL is malformed, it should return False.
     */
    // Create a dummy Browser mock. Only the 'config' attribute is needed for _is_url_allowed.
    const dummyBrowser = { config: {} }
    // Set an empty config for dummyBrowser; it won't be used in _is_url_allowed.

    // Scenario 1: allowed_domains is None, any URL should be allowed.
    const config1 = new BrowserContextConfig({ })
    const context1 = new BrowserContext({ browser: dummyBrowser as any, config: config1 })
    expect(context1.isUrlAllowed('http://anydomain.com')).toBe(true)
    expect(context1.isUrlAllowed('https://anotherdomain.org/path')).toBe(true)

    // Scenario 2: allowed_domains is provided.
    const allowed = ['example.com', 'mysite.org']
    const config2 = new BrowserContextConfig({ allowedDomains: allowed })
    const context2 = new BrowserContext({ browser: dummyBrowser as any, config: config2 })

    // URL exactly matching
    expect(context2.isUrlAllowed('http://example.com')).toBe(true)
    // URL with subdomain (should be allowed)
    expect(context2.isUrlAllowed('http://sub.example.com/path')).toBe(true)
    // URL with different domain (should not be allowed)
    expect(context2.isUrlAllowed('http://notexample.com')).toBe(false)
    // URL that matches second allowed domain
    expect(context2.isUrlAllowed('https://mysite.org/page')).toBe(true)
    // URL with port number, still allowed (port is stripped)
    expect(context2.isUrlAllowed('http://example.com:8080')).toBe(true)

    // Scenario 3: Malformed URL or empty domain
    // URL parsing will return an empty hostname for some malformed URLs.
    expect(context2.isUrlAllowed('notaurl')).toBe(false)
  })

  it('test_convert_simple_xpath_to_css_selector', () => {
    /**
     * Test the _convert_simple_xpath_to_css_selector method of BrowserContext.
     * This verifies that simple XPath expressions (with and without indices) are correctly converted to CSS selectors.
     */
    // Test empty xpath returns empty string
    expect(BrowserContext._convertSimpleXpathToCssSelector('')).toBe('')

    // Test a simple xpath without indices
    const xpath = '/html/body/div/span'
    const expected = 'html > body > div > span'
    const result = BrowserContext._convertSimpleXpathToCssSelector(xpath)
    expect(result).toBe(expected)

    // Test xpath with an index on one element: [2] should translate to :nth-of-type(2)
    const xpathWithIndex = '/html/body/div[2]/span'
    const expectedWithIndex = 'html > body > div:nth-of-type(2) > span'
    const resultWithIndex = BrowserContext._convertSimpleXpathToCssSelector(xpathWithIndex)
    expect(resultWithIndex).toBe(expectedWithIndex)

    // Test xpath with indices on multiple elements:
    // For "li[3]" -> li:nth-of-type(3) and for "a[1]" -> a:nth-of-type(1)
    const xpathWithMultipleIndices = '/ul/li[3]/a[1]'
    const expectedWithMultipleIndices = 'ul > li:nth-of-type(3) > a:nth-of-type(1)'
    const resultWithMultipleIndices = BrowserContext._convertSimpleXpathToCssSelector(xpathWithMultipleIndices)
    expect(resultWithMultipleIndices).toBe(expectedWithMultipleIndices)
  })

  // it('test_get_initial_state', () => {
  //   /**
  //    * Test the _get_initial_state method to verify it returns the correct initial BrowserState.
  //    * The test checks that when a dummy page with a URL is provided,
  //    * the returned state contains that URL and other default values.
  //    */
  //   // Create a dummy browser since only its existence is needed.
  //   const dummyBrowser = { config: {} }
  //   const context = new BrowserContext({ browser: dummyBrowser as any, config: new BrowserContextConfig() })

  //   // Define a dummy page with a 'url' attribute.
  //   const dummyPage = { url: 'http://dummy.com' }

  //   // Call _get_initial_state with a page: URL should be set from page.url.
  //   const stateWithPage = context._getInitialState({ page: dummyPage as any })
  //   expect(stateWithPage.url).toBe(dummyPage.url)
  //   // Verify that the element_tree is initialized with tag 'root'
  //   expect(stateWithPage.elementTree.tagName).toBe('root')

  //   // Call _get_initial_state without a page: URL should be empty.
  //   const stateWithoutPage = context._getInitialState()
  //   expect(stateWithoutPage.url).toBe('')
  // })

  it('test_execute_javascript', async () => {
    /**
     * Test the execute_javascript method by mocking the current page's evaluate function.
     * This ensures that when execute_javascript is called, it correctly returns the value
     * from the page's evaluate method.
     */
    // Define a dummy page with an async evaluate method.
    const dummyPage = {
      evaluate: async (script: string) => 'dummy_result',
      isClosed() {
        return false
      },
    }

    // Create a dummy session object with a dummy current_page.
    const dummySession = {
      agentCurrentPage: dummyPage,
      context: {
        pages() {
          return [dummyPage]
        },
      },
    }

    // Create a dummy browser mock with a minimal config.
    const dummyBrowser = { config: {} }

    // Initialize the BrowserContext with the dummy browser and config.
    const context = new BrowserContext({ browser: dummyBrowser as any, config: new BrowserContextConfig() })
    context.agentCurrentPage = dummyPage as any
    // Manually set the session to our dummy session.
    context.session = dummySession as any

    // Call execute_javascript and verify it returns the expected result.
    const result = await context.executeJavaScript('return 1+1')
    expect(result).toBe('dummy_result')
  })

  it('test_enhanced_css_selector_for_element', async () => {
    /**
     * Test the _enhanced_css_selector_for_element method to verify that
     * it returns the correct CSS selector string for a dummy DOMElementNode.
     * The test checks that:
     *   - The provided xpath is correctly converted (handling indices),
     *   - Class attributes are appended as CSS classes,
     *   - Standard and dynamic attributes (including ones with special characters)
     *     are correctly added to the selector.
     */
    // Create a dummy DOMElementNode instance with a complex set of attributes.
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

    // Call the method with include_dynamic_attributes=True.
    const actualSelector = BrowserContext.enhancedCssSelectorForElement(dummyElement, true)

    // Expected conversion:
    // 1. The xpath "/html/body/div[2]" converts to "html > body > div:nth-of-type(2)".
    // 2. The class attribute "foo bar" appends ".foo.bar".
    // 3. The "id" attribute is added as [id="my-id"].
    // 4. The "placeholder" attribute contains quotes; it is added as
    //    [placeholder*="some \"quoted\" text"].
    // 5. The dynamic attribute "data-testid" is added as [data-testid="123"].
    const expectedSelector
      = 'html > body > div:nth-of-type(2).foo.bar[id="my-id"][placeholder*="some \\"quoted\\" text"][data-testid="123"]'

    expect(actualSelector).toBe(expectedSelector)
  })

  it('test_get_scroll_info', async () => {
    /**
     * Test the get_scroll_info method by mocking the page's evaluate method.
     * This dummy page returns preset values for window.scrollY, window.innerHeight,
     * and document.documentElement.scrollHeight. The test then verifies that the
     * computed scroll information (pixels_above and pixels_below) match the expected values.
     */
    // Define a dummy page with an async evaluate method returning preset values.
    const dummyPage = {
      evaluate: async (script: string) => {
        if (script.toString().includes('window.scrollY')) {
          return 100 // scrollY
        }
        else if (script.toString().includes('window.innerHeight')) {
          return 500 // innerHeight
        }
        else if (script.toString().includes('document.documentElement.scrollHeight')) {
          return 1200 // total scrollable height
        }
        return null
      },
    }

    // Create a dummy session with a dummy current_page.
    const dummySession = {
      agentCurrentPage: dummyPage,
      context: { // We also need a dummy context attribute but it won't be used in this test.
        pages() {
          return [dummyPage]
        },
      },
    }

    // Create a dummy browser mock.
    const dummyBrowser = { config: {} }

    // Initialize BrowserContext with the dummy browser and config.
    const context = new BrowserContext({ browser: dummyBrowser as any, config: new BrowserContextConfig() })
    context.agentCurrentPage = dummyPage as any
    // Manually set the session to our dummy session.
    context.session = dummySession as any

    // Call get_scroll_info on the dummy page.
    const [pixelsAbove, pixelsBelow] = await context.getScrollInfo(dummySession.agentCurrentPage as any)

    // Expected calculations:
    // pixelsAbove = scrollY = 100
    // pixelsBelow = total_height - (scrollY + innerHeight) = 1200 - (100 + 500) = 600
    expect(pixelsAbove).toBe(100)
    expect(pixelsBelow).toBe(600)
  })

  it('test_reset_context', async () => {
    /**
     * Test the reset_context method to ensure it correctly closes all existing tabs,
     * resets the cached state, and creates a new page.
     */
    // Dummy Page with close and wait_for_load_state methods.
    class DummyPage {
      url: string
      closed: boolean

      constructor(url = 'http://dummy.com') {
        this.url = url
        this.closed = false
      }

      async close() {
        this.closed = true
        this.url = ''
      }

      async waitForLoadState() {}
    }

    // Dummy Context that holds pages and can create a new page.
    class DummyContext {
      _pages: DummyPage[]

      constructor() {
        this._pages = []
      }

      pages() {
        return this._pages
      }

      async newPage() {
        const newPage = new DummyPage('')
        this._pages.push(newPage)
        return newPage
      }
    }

    // Create a dummy session with a context containing two pages.
    const dummyContext = new DummyContext()
    const page1 = new DummyPage('http://page1.com')
    const page2 = new DummyPage('http://page2.com')
    dummyContext.pages().push(page1, page2)

    const dummySession = {
      context: dummyContext,
      currentPage: page1,
      cachedState: null as any as BrowserStateSummary,
    }

    // Create a dummy browser mock.
    const dummyBrowser = { config: {} }

    // Initialize BrowserContext using our dummy_browser and config,
    // and manually set its session to our dummy session.
    const context = new BrowserContext({ browser: dummyBrowser as any, config: new BrowserContextConfig() });
    (context as any).session = dummySession

    // Confirm session has 2 pages before reset.
    expect(dummySession.context.pages().length).toBe(2)

    // Call reset_context which should close existing pages,
    // reset the cached state, and create a new page as current_page.
    await context.resetContext()

    // Verify that initial pages were closed.
    expect(page1.closed).toBe(true)
    expect(page2.closed).toBe(true)

    // Check that a new page is created and set as current_page.
    expect(dummySession.currentPage).not.toBeNull()
    const newPage = dummySession.currentPage

    // New page URL should be empty as per _get_initial_state.
    expect(newPage.url).toBe('')

    // Verify that cached_state is reset to an initial BrowserState.
    const state = dummySession.cachedState
    expect(state).toBe(undefined)
  })

  it('test_take_screenshot', async () => {
    /**
     * Test the take_screenshot method to verify that it returns a base64 encoded screenshot string.
     * A dummy page with a mocked screenshot method is used, returning a predefined byte string.
     */
    const dummyPage = {
      screenshot: async (options: any) => {
        // Verify that parameters are forwarded correctly.
        expect(options.fullPage).toBe(true)
        expect(options.animations).toBe('disabled')

        // Return a test byte array.
        return Buffer.from('test')
      },
      isClosed() {
        return false
      },
      waitForLoadState() {
        return Promise.resolve()
      },
    }

    // Create a dummy session with the DummyPage as the current_page.
    const dummySession = {
      agentCurrentPage: dummyPage,
      context: { // We also need a dummy context attribute but it won't be used in this test.
        pages() {
          return [dummyPage]
        },
      },
    }
    // Create a dummy browser mock.
    const dummyBrowser = { config: {} }

    // Initialize the BrowserContext with the dummy browser and config.
    const context = new BrowserContext({ browser: dummyBrowser as any, config: new BrowserContextConfig() })
    context.agentCurrentPage = dummyPage as any
    // Manually set the session to our dummy session.
    (context as any).session = dummySession

    // Call take_screenshot and check that it returns the expected base64 encoded string.
    const result = await context.takeScreenshot(true)
    const expected = Buffer.from('test').toString('base64')

    expect(result).toBe(expected)
  })

  it('test_refresh_page_behavior', async () => {
    /**
     * Test the refresh_page method of BrowserContext to verify that it correctly reloads the current page
     * and waits for the page's load state. This is done by creating a dummy page that flags when its
     * reload and wait_for_load_state methods are called.
     */
    const dummyPage = {
      reloadCalled: false,
      waitForLoadStateCalled: false,

      async reload() {
        this.reloadCalled = true
      },

      async waitForLoadState() {
        this.waitForLoadStateCalled = true
      },
      isClosed() {
        return false
      },
    }

    // Create a dummy session with the DummyPage as the current_page.
    const dummySession = {
      agentCurrentPage: dummyPage,
      context: { // We also need a dummy context attribute but it won't be used in this test.
        pages() {
          return [dummyPage]
        },
      },
    }

    // Create a dummy browser mock
    const dummyBrowser = { config: {} }

    // Initialize BrowserContext with the dummy browser and config,
    // and manually set its session to our dummy session.
    const context = new BrowserContext({ browser: dummyBrowser as any, config: new BrowserContextConfig() })
    context.agentCurrentPage = dummyPage as any
    (context as any).session = dummySession

    // Call refresh_page and verify that reload and waitForLoadState were called.
    await context.refreshPage()

    expect(dummyPage.reloadCalled).toBe(true)
    expect(dummyPage.waitForLoadStateCalled).toBe(true)
  })

  it('test_remove_highlights_failure', async () => {
    /**
     * Test the remove_highlights method to ensure that if the page.evaluate call fails,
     * the exception is caught and does not propagate (i.e. the method handles errors gracefully).
     */
    // Dummy page that always raises an exception when evaluate is called.
    const dummyPage = {
      evaluate: async (script: string) => {
        throw new Error('dummy error')
      },
    }

    // Create a dummy session with the DummyPage as current_page.
    const dummySession = {
      currentPage: dummyPage,
      context: null, // Not used in this test
    }

    // Create a dummy browser mock.
    const dummyBrowser = { config: {} }

    // Initialize BrowserContext with the dummy browser and configuration.
    const context = new BrowserContext({ browser: dummyBrowser as any, config: new BrowserContextConfig() });
    (context as any).session = dummySession

    // Call remove_highlights and verify that no exception is raised.
    // In Vitest, we don't need a try/catch here, the test will automatically fail if
    // an unhandled exception is thrown.
    await context.removeHighlights()

    // If we get here without an exception, the test has passed
    expect(true).toBe(true)
  })
})
