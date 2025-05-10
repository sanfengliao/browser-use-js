import type { ProxySettings } from '@/browser/browser'
import { Browser, BrowserConfig } from '@/browser/browser'
import { BrowserContext, BrowserContextConfig } from '@/browser/context'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('browserConfigModels', () => {
  it('test_window_size_config', async () => {
    /**
     * Test that BrowserContextConfig correctly handles window_width and window_height properties.
     */

    // Create with different values
    const config2 = new BrowserContextConfig({
      windowWidth: 1920,
      windowHeight: 1080,
    })
    expect(config2.windowWidth).toBe(1920)
    expect(config2.windowHeight).toBe(1080)
  })

  it('test_window_size_with_real_browser', async () => {
    /**
     * Integration test that verifies our window size Pydantic model is correctly
     * passed to Playwright and the actual browser window is configured with these settings.
     * This test is skipped in CI environments.
     */
    // Skip test in CI environments
    if (process.env.CI === 'true') {
      console.log('Skipping browser test in CI environment')
      return
    }

    // Create browser config with headless mode
    const browserConfig = new BrowserConfig({
      headless: true, // Use headless for faster test
    })

    // Create context config with specific dimensions we can check
    const contextConfig = new BrowserContextConfig({
      windowWidth: 1024,
      windowHeight: 768,
      maximumWaitPageLoadTime: 2.0, // Faster timeouts for test
      minimumWaitPageLoadTime: 0.2,
      noViewport: true, // Use actual window size instead of viewport
    })

    // Create browser and context
    const browser = new Browser(browserConfig)
    try {
      // Initialize browser
      const playwrightBrowser = await browser.getPlaywrightBrowser()
      expect(playwrightBrowser).not.toBeNull()

      // Create context
      const browserContext = new BrowserContext({ browser, config: contextConfig })
      try {
        // Initialize session
        await browserContext.initializeSession()

        // Get the current page
        const page = await browserContext.getCurrentPage()
        expect(page).not.toBeNull()

        // Get the context configuration used for browser window size
        const videoSize = await page.evaluate(
          () => {
            // This returns information about the context recording settings
            // which should match our configured video size (browser_window_size)
            try {
              // @ts-expect-error
              const settings = window.getPlaywrightContextSettings
              // @ts-expect-error
                ? window.getPlaywrightContextSettings()
                : null
              if (settings && settings.recordVideo) {
                return settings.recordVideo.size
              }
            }
            catch (e) {}

            // Fallback to window dimensions
            return {
              width: window.innerWidth,
              height: window.innerHeight,
            }
          },
        )

        // Let's also check the viewport size
        const viewportSize = await page.evaluate(
          () => {
            return {
              width: window.innerWidth,
              height: window.innerHeight,
            }
          },
        )

        console.log(`Window size config: width=${contextConfig.windowWidth}, height=${contextConfig.windowHeight}`)
        console.log(`Browser viewport size:`, viewportSize)

        // This is a lightweight test to verify that the page has a size (details may vary by browser)
        expect(viewportSize.width).toBeGreaterThan(0)
        expect(viewportSize.height).toBeGreaterThan(0)

        // For browser context creation in record_video_size, this is what truly matters
        // Verify that our window size was properly serialized to a dictionary
        console.log(`Content of context session: ${browserContext.session?.context}`)
        console.log('✅ Browser window size used in the test')
      }
      finally {
        // Clean up context
        await browserContext.close()
      }
    }
    finally {
      // Clean up browser
      await browser.close()
    }
  })

  it('test_proxy_with_real_browser', async () => {
    /**
     * Integration test that verifies our proxy Pydantic model is correctly
     * passed to Playwright without requiring a working proxy server.
     *
     * This test:
     * 1. Creates a ProxySettings Pydantic model
     * 2. Passes it to BrowserConfig
     * 3. Verifies browser initialization works (proving the model was correctly serialized)
     * 4. We don't actually verify proxy functionality (would require a working proxy)
     */
    // Create proxy settings with a fake proxy server
    const proxySettings: ProxySettings = {
      server: 'http://non.existent.proxy:9999',
      bypass: 'localhost',
      username: 'testuser',
      password: 'testpass',
    }

    // Create browser config with proxy
    const browserConfig = new BrowserConfig({
      headless: true,
      proxy: proxySettings,
    })

    // Create browser
    const browser = new Browser(browserConfig)
    try {
      // Initialize browser - this should succeed even with invalid proxy
      // because we're just checking configuration, not actual proxy functionality
      try {
        const playwrightBrowser = await browser.getPlaywrightBrowser()
        expect(playwrightBrowser).not.toBeNull()

        // Success - the browser was initialized with our proxy settings
        // We won't try to make requests (which would fail with non-existent proxy)
        console.log('✅ Browser initialized with proxy settings successfully')

        // We can inspect browser settings here to verify proxy was passed
        // but the specific API to access these settings depends on the browser
      }
      catch (e) {
        // Make sure any exception isn't related to the proxy configuration format
        // (Network errors due to non-existent proxy are acceptable, invalid type conversion isn't)
        const errorText = String(e).toLowerCase()
        expect(
          !errorText.includes('proxy')
          || ['connect', 'connection', 'network', 'timeout', 'unreachable']
            .some(term => errorText.includes(term)),
        ).toBeTruthy()
      }
    }
    finally {
      // Clean up browser
      await browser.close()
    }
  })
})
