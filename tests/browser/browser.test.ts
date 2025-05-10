import type { ProxySettings } from '@/browser/browser'
import type { AnyFunction } from '@/type'
import childProcess from 'node:child_process'
import { Browser, BrowserConfig } from '@/browser/browser'
import { BrowserContext, BrowserContextConfig } from '@/browser/context'
import axios from 'axios'
import * as playwright from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('browser Tests', () => {
  it('test_builtin_browser_launch', async () => {
    /**
     * Test that the standard browser is launched correctly:
     * When no remote (cdp or wss) or chrome instance is provided, the Browser class uses _setup_builtin_browser.
     * This test mocks playwright to return dummy objects, and asserts that get_playwright_browser returns the expected DummyBrowser.
     */

    class DummyBrowser {}

    const chromiumLaunch = vi.spyOn(playwright.chromium, 'launch')
    chromiumLaunch.mockResolvedValue(new DummyBrowser() as any)

    // Create browser with test configuration
    const config = new BrowserConfig({
      headless: true,
      disableSecurity: false,
      extraBrowserArgs: ['--test'],
    })

    const browserObj = new Browser(config)
    const resultBrowser = await browserObj.getPlaywrightBrowser()

    expect(resultBrowser).toBeInstanceOf(DummyBrowser)
    expect(resultBrowser).not.toBeNull()

    await browserObj.close()
  })

  it('test_cdp_browser_launch', async () => {
    /**
     * Test that when a CDP URL is provided in the configuration, the Browser uses _setup_cdp
     * and returns the expected DummyBrowser.
     */

    class DummyBrowser {}

    // @ts-expect-error
    vi.spyOn(playwright.chromium, 'connectOverCDP').mockImplementation(async (endpointUrl: string, options) => {
      expect(endpointUrl).toBe('ws://dummy-cdp-url')
      return new DummyBrowser()
    })

    // Create browser with CDP URL configuration
    const config = new BrowserConfig({ cdpUrl: 'ws://dummy-cdp-url' })
    const browserObj = new Browser(config)
    const resultBrowser = await browserObj.getPlaywrightBrowser()

    expect(resultBrowser).toBeInstanceOf(DummyBrowser)

    await browserObj.close()
  })

  it('test_wss_browser_launch', async () => {
    /**
     * Test that when a WSS URL is provided in the configuration,
     * the Browser uses setup_wss and returns the expected DummyBrowser.
     */

    class DummyBrowser {}

    // @ts-expect-error
    vi.spyOn(playwright.chromium, 'connect').mockImplementation(async (endpointUrl: string, options) => {
      expect(endpointUrl).toBe('ws://dummy-wss-url')
      return new DummyBrowser()
    })
    // Create browser with WSS URL configuration
    const config = new BrowserConfig({ wssUrl: 'ws://dummy-wss-url' })
    const browserObj = new Browser(config)
    const resultBrowser = await browserObj.getPlaywrightBrowser()

    expect(resultBrowser).toBeInstanceOf(DummyBrowser)

    await browserObj.close()
  })

  it('test_user_provided_browser_launch', async () => {
    /**
     * Test that when a browser_binary_path is provided the Browser class uses
     * _setup_user_provided_browser branch and returns the expected DummyBrowser object
     * by reusing an existing Chrome instance.
     */

    // Mock requests.get for checking chrome debugging endpoint
    vi.mock('axios', () => ({
      get: vi.fn((url) => {
        if (url === 'http://localhost:9222/json/version') {
          return Promise.resolve({
            status: 200,
            ok: true,
            json: () => Promise.resolve({}),
          })
        }
        throw new Error('Connection failed')
      }),
    }))

    vi.mock('child_process', () => ({
      spawn: vi.fn((command, args) => {
        return { pid: 1234 }
      }),
    }))

    // Define dummy classes for mocking
    class DummyBrowser {}

    // @ts-expect-error
    vi.spyOn(playwright.chromium, 'connectOverCDP').mockImplementation((endpointUrl) => {
      expect(endpointUrl).toBe('http://localhost:9222')
      return new DummyBrowser()
    })

    // Mock the internal async_playwright function

    // Create browser with user-provided Chrome configuration
    const config = new BrowserConfig({
      browserBinaryPath: 'dummy/chrome',
      extraBrowserArgs: ['--dummy-arg'],
    })

    const browserObj = new Browser(config)
    const resultBrowser = await browserObj.getPlaywrightBrowser()

    expect(resultBrowser).toBeInstanceOf(DummyBrowser)

    await browserObj.close()
  })

  it('test_user_provided_browser_launch_on_custom_chrome_remote_debugging_port', async () => {
    /**
     * Test that when a browser_binary_path and chrome_remote_debugging_port are provided, the Browser class uses
     * _setup_user_provided_browser branch and returns the expected DummyBrowser object
     * by launching a new Chrome instance with --remote-debugging-port=chrome_remote_debugging_port argument.
     */

    // Custom remote debugging port
    const customChromeRemoteDebuggingPort = 9223

    // Mock fetch for checking chrome debugging endpoint
    vi.doMock('axios', () => ({
      get: vi.fn((url) => {
        if (url === `http://localhost:${customChromeRemoteDebuggingPort}/json/version`) {
          return Promise.resolve({
            status: 200,
            ok: true,
            json: () => Promise.resolve({}),
          })
        }
        throw new Error('Connection failed')
      }),
    }))

    // Mock child_process.spawn for launching Chrome
    vi.doMock('child_process', () => ({
      spawn: vi.fn((command, args) => {
        expect(args).toContain(`--remote-debugging-port=${customChromeRemoteDebuggingPort}`)
        return { pid: 1234 }
      }),
    }))

    // Define dummy classes for mocking
    class DummyBrowser {}

    // @ts-expect-error
    vi.spyOn(playwright.chromium, 'connectOverCDP').mockImplementation((endpointUrl) => {
      expect(endpointUrl).toBe('http://localhost:9223')
      return new DummyBrowser()
    })

    // Create browser with custom debugging port configuration
    const config = new BrowserConfig({
      browserBinaryPath: 'dummy/chrome',
      chromeRemoteDebuggingPort: customChromeRemoteDebuggingPort,
      extraBrowserArgs: ['--dummy-arg'],
    })

    const browserObj = new Browser(config)
    const resultBrowser = await browserObj.getPlaywrightBrowser()

    expect(resultBrowser).toBeInstanceOf(DummyBrowser)

    await browserObj.close()
  })

  it('test_builtin_browser_disable_security_args', async () => {
    /**
     * Test that the standard browser launch includes disable-security arguments when disable_security is True.
     * This verifies that _setup_builtin_browser correctly appends the security disabling arguments along with
     * the base arguments and any extra arguments provided.
     */

    // These are the base arguments defined in _setup_builtin_browser.
    const baseArgs = [
      '--no-sandbox',
      // '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      // '--disable-background-timer-throttling',
      // '--disable-popup-blocking',
      // '--disable-backgrounding-occluded-windows',
      // '--disable-renderer-backgrounding',
      '--disable-window-activation',
      '--disable-focus-on-load',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-startup-window',
      '--window-position=0,0',
    ]

    // When disable_security is True, these arguments should be added.
    const disableSecurityArgs = [
      '--disable-web-security',
      '--disable-site-isolation-trials',
      '--disable-features=IsolateOrigins,site-per-process',
    ]

    // Additional arbitrary argument for testing extra args
    const extraArgs = ['--dummy-extra']

    // Define dummy classes for mocking
    class DummyBrowser {}

    // @ts-expect-error
    vi.spyOn(playwright.chromium, 'launch').mockImplementation((options: any) => {
      const { headless, args, proxy } = options

      // Expected args is the base args plus disable security args and the extra args.
      const expectedArgs = [...baseArgs, ...disableSecurityArgs, ...extraArgs]

      expect(headless).toBe(true)
      expectedArgs.forEach((arg) => {
        expect(args).include(arg)
      })
      expect(proxy).toBeUndefined()

      return new DummyBrowser()
    })

    // Create browser with security disabled
    const config = new BrowserConfig({
      headless: true,
      disableSecurity: true,
      extraBrowserArgs: extraArgs,
    })

    const browserObj = new Browser(config)
    const resultBrowser = await browserObj.getPlaywrightBrowser()

    expect(resultBrowser).toBeInstanceOf(DummyBrowser)

    await browserObj.close()
  })

  it('test_new_context_creation', async () => {
    /**
     * Test that the new_context method returns a BrowserContext with the correct attributes.
     * This verifies that the BrowserContext is initialized with the provided Browser instance and configuration.
     */

    // Mock the getPlaywrightBrowser method to return a dummy browser
    class DummyBrowser {}

    const config = new BrowserConfig()
    const browserObj = new Browser(config)

    const customContextConfig = new BrowserContextConfig()
    const context = await browserObj.newContext(customContextConfig)

    expect(context).toBeInstanceOf(BrowserContext)
    expect(context.browser).toBe(browserObj)
    expect(context.config).toBeInstanceOf(BrowserContextConfig)

    await browserObj.close()
  })

  it('test_user_provided_browser_launch_failure', async () => {
    /**
     * Test that when a Chrome instance cannot be started or connected to,
     * the Browser._setup_user_provided_browser branch eventually raises a RuntimeError.
     * We simulate failure by:
     *   - Forcing fetch to always throw an error (so no existing instance is found).
     *   - Mocking child_process.spawn to do nothing.
     *   - Replacing setTimeout to avoid delays.
     *   - Having the dummy playwright's connect_over_cdp method always throw an Exception.
     */

    // Mock fetch to always fail
    vi.doMock('axios', () => ({
      get: vi.fn(() => Promise.reject(new Error('Simulated connection failure'))),
    }))

    // Mock spawn to do nothing
    vi.doMock('child_process', () => ({
      spawn: vi.fn(() => ({ pid: 1234 })),
    }))

    // Mock setTimeout to avoid delays
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any) => {
      fn()
      return 0 as any
    })

    vi.spyOn(playwright.chromium, 'connectOverCDP').mockImplementation(() => {
      throw new Error('Connection failed simulation')
    })

    // Mock the internal async_playwright function

    // Create browser with user-provided Chrome configuration
    const config = new BrowserConfig({
      browserBinaryPath: 'dummy/chrome',
      extraBrowserArgs: ['--dummy-arg'],
    })

    const browserObj = new Browser(config)

    // Expect a runtime error
    await expect(browserObj.getPlaywrightBrowser()).rejects.toThrow(/To start chrome in Debug mode/)

    await browserObj.close()
  })

  it('test_get_playwright_browser_caching', async () => {
    /**
     * Test that get_playwright_browser returns a cached browser instance.
     * On the first call, the browser is initialized; on subsequent calls,
     * the same instance is returned.
     */

    // Define dummy classes for mocking
    class DummyBrowser {
      close() {}
    }

    const chromiumLaunch = vi.spyOn(playwright.chromium, 'launch').mockResolvedValue(new DummyBrowser() as any)

    // Create browser with test configuration
    const config = new BrowserConfig({
      headless: true,
      disableSecurity: false,
      extraBrowserArgs: ['--test'],
    })

    const browserObj = new Browser(config)
    const firstBrowser = await browserObj.getPlaywrightBrowser()
    const secondBrowser = await browserObj.getPlaywrightBrowser()

    expect(firstBrowser).toBe(secondBrowser) // Same instance should be returned

    await browserObj.close()
  })

  it('test_close_error_handling', async () => {
    /**
     * Test that the close method properly handles exceptions thrown by
     * playwright_browser.close() and playwright.stop(), ensuring that the
     * browser's attributes are set to null even if errors occur.
     */

    // Create dummy objects that throw errors on close/stop
    const dummyBrowserWithError = {
      async close() {
        throw new Error('Close error simulation')
      },
    }

    const dummyPlaywrightWithError = {
      async stop() {
        throw new Error('Stop error simulation')
      },
    }

    // Create browser instance
    const config = new BrowserConfig()
    const browserObj = new Browser(config);

    // Set the dummy objects
    (browserObj).playwrightBrowser = dummyBrowserWithError as any

    // Close should not throw even though internal methods do
    await browserObj.close()

    // Verify that attributes are nulled
    expect(browserObj.playwrightBrowser).toBeUndefined()
  })

  it('test_standard_browser_launch_with_proxy', async () => {
    /**
     * Test that when a proxy is provided in the BrowserConfig, the _setup_builtin_browser method
     * correctly passes the proxy parameter to the playwright.chromium.launch method.
     * This test sets up a dummy async_playwright context and verifies that the dummy proxy is received.
     */

    // Create a dummy proxy settings instance
    const dummyProxy: ProxySettings = {
      server: 'http://dummy.proxy',
    }

    // Define dummy classes for mocking
    class DummyBrowser {
      close() {}
    }

    vi.spyOn(playwright.chromium, 'launch').mockImplementation((options: any) => {
      const { proxy } = options

      // Assert that the proxy passed equals the dummy proxy provided in the configuration
      expect(proxy).toBeInstanceOf(Object)
      expect(proxy.server).toBe('http://dummy.proxy')

      return new DummyBrowser() as any
    })

    // Create browser with proxy configuration
    const config = new BrowserConfig({
      headless: false,
      disableSecurity: false,
      proxy: dummyProxy,
    })

    const browserObj = new Browser(config)
    const resultBrowser = await browserObj.getPlaywrightBrowser()

    expect(resultBrowser).toBeInstanceOf(DummyBrowser)

    await browserObj.close()
  })
  it('test_browser_window_size', async () => {
    /**
     * Test that when window_width and window_height are provided in BrowserContextConfig,
     * they're properly converted to a dictionary when passed to Playwright.
     */

    // Define dummy page class
    class DummyPage {
      url() { return 'about:blank' }

      async goto(url: string) {}
      async waitForLoadState(state: string) {}
      async title() { return 'Test Page' }
      async bringToFront() {}
      async evaluate(script: string) { return true }
      isClosed() { return false }
    }

    // Define dummy context class
    class DummyContext {
      tracing = this
      pages() {
        return [new DummyPage()]
      }

      async newPage() { return new DummyPage() }
      async addInitScript(script: string) {}
      async start() {}
      async stop(path?: string) {}
      on(event: string, handler: AnyFunction) {}
      async close() {}
      async grantPermissions(permissions: string[], origin?: string) {}
    }

    // Define dummy browser class with assertions
    class DummyBrowser {
      contexts: DummyContext[] = []

      async newContext(options: any) {
        // Assert that viewport is a dictionary with expected values
        expect(options.viewport).toBeInstanceOf(Object)
        expect(options.viewport.width).toBe(1280)
        expect(options.viewport.height).toBe(1100)

        const context = new DummyContext()
        this.contexts.push(context)
        return context
      }

      async close() {}
    }

    vi.spyOn(playwright.chromium, 'launch').mockImplementation((options: any) => {
      return new DummyBrowser() as any
    })

    // Create browser with default config
    const browserObj = new Browser()

    // Get browser instance
    const playwrightBrowser = await browserObj.getPlaywrightBrowser()

    // Create context config with specific window size
    const contextConfig = new BrowserContextConfig({
      windowWidth: 1280,
      windowHeight: 1100,
      noViewport: false,
    })

    // Create browser context - this will test if window dimensions are properly converted
    const browserContext = new BrowserContext({
      browser: browserObj,
      config: contextConfig,
    })

    await browserContext.initializeSession()

    // Clean up
    await browserContext.close()
    await browserObj.close()
  })
})
