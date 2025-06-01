import { BrowserContextOptions } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserProfile, BrowserSession } from '@/browser/session'

describe('browser Session Viewport and Proxy Tests', () => {
  let browserSession: BrowserSession | null = null

  afterEach(async () => {
    if (browserSession) {
      try {
        await browserSession.stop()
      } catch (error) {
        // Ignore cleanup errors
      }
      browserSession = null
    }
  })

  it('proxy settings pydantic model', async () => {
    /**
     * Test that ProxySettings as a Pydantic model is correctly converted to a dictionary when used.
     */
    // Create ProxySettings with Pydantic model
    const proxySettings: BrowserContextOptions['proxy'] = {
      server: 'http://example.proxy:8080',
      bypass: 'localhost',
      username: 'testuser',
      password: 'testpass',
    }

    // Verify the model has correct dict-like access
    expect(proxySettings.server).toBe('http://example.proxy:8080')
    expect(proxySettings.bypass || null).toBe('localhost')
    expect(proxySettings.nonexistent || 'default').toBe('default')

    // Verify model_dump works correctly
    const proxyDict = { ...proxySettings }
    expect(typeof proxyDict).toBe('object')
    expect(proxyDict.server).toBe('http://example.proxy:8080')
    expect(proxyDict.bypass).toBe('localhost')
    expect(proxyDict.username).toBe('testuser')
    expect(proxyDict.password).toBe('testpass')

    // We don't launch the actual browser - we just verify the model itself works as expected
  })

  it('window size with real browser', async () => {
    /**
     * Integration test that verifies our window size Pydantic model is correctly
     * passed to Playwright and the actual browser window is configured with these settings.
     * This test is skipped in CI environments.
     */
    // Create browser profile with headless mode and specific dimensions
    const browserProfile = new BrowserProfile({
      headless: true, // window size gets converted to viewport size in headless mode
      windowSize: { width: 999, height: 888 },
      maximumWaitPageLoadTime: 2.0,
      minimumWaitPageLoadTime: 0.2,
    })

    // Create browser session
    browserSession = new BrowserSession({ browserProfile })

    try {
      await browserSession.start()
      // Get the current page
      const page = await browserSession.getCurrentPage()
      expect(page).not.toBeFalsy() // Failed to get current page

      // Get the context configuration used for browser window size
      const videoSize = await page.evaluate(
        () => {
          // This returns information about the context recording settings
          // which should match our configured video size (browser_window_size)
          try {
            const settings = window.getPlaywrightContextSettings
              ? window.getPlaywrightContextSettings()
              : null
            if (settings && settings.recordVideo) {
              return settings.recordVideo.size
            }
          } catch (e) {}

          // Fallback to window dimensions
          return {
            width: window.innerWidth,
            height: window.innerHeight,
          }
        },
      )

      // Let's also check the viewport size
      const actualSize = await page.evaluate(
        () => {
          return {
            width: window.innerWidth,
            height: window.innerHeight,
          }
        },
      )

      console.log(`Browser configured windowSize=${JSON.stringify(browserSession.browserProfile.windowSize)}`)
      console.log(`Browser configured viewport: ${JSON.stringify(browserSession.browserProfile.viewport)}`)
      console.log(`Browser content actual size: ${JSON.stringify(actualSize)}`)

      // This is a lightweight test to verify that the page has a size (details may vary by browser)
      expect(actualSize.width).toBeGreaterThan(0) // Expected viewport width to be positive
      expect(actualSize.height).toBeGreaterThan(0) // Expected viewport height to be positive

      // assert that windowSize got converted to viewport in headless mode
      expect(browserSession.browserProfile.headless).toBe(true)
      expect(browserSession.browserProfile.viewport).toEqual({ width: 999, height: 888 })
      expect(browserSession.browserProfile.windowSize).toBeFalsy()
      expect(browserSession.browserProfile.windowPosition).toBeFalsy()
      expect(browserSession.browserProfile.noViewport).toBe(false)
      // screen should be the detected display size (or default if no display detected)
      expect(browserSession.browserProfile.screen).not.toBeFalsy()
      expect(browserSession.browserProfile.screen!.width).toBeGreaterThan(0)
      expect(browserSession.browserProfile.screen!.height).toBeGreaterThan(0)
    } finally {
      await browserSession.stop()
      browserSession = null
    }
  })

  it('proxy with real browser', async () => {
    /**
     * Integration test that verifies our proxy Pydantic model is correctly
     * passed to Playwright without requiring a working proxy server.
     *
     * This test:
     * 1. Creates a ProxySettings Pydantic model
     * 2. Passes it to BrowserProfile
     * 3. Verifies browser initialization works (proving the model was correctly serialized)
     * 4. We don't actually verify proxy functionality (would require a working proxy)
     */
    // Create proxy settings with a fake proxy server
    const proxySettings: BrowserContextOptions['proxy'] = {
      server: 'http://non.existent.proxy:9999',
      bypass: 'localhost',
      username: 'testuser',
      password: 'testpass',
    }

    // Test model serialization
    const proxyDict = { ...proxySettings }
    expect(typeof proxyDict).toBe('object')
    expect(proxyDict.server).toBe('http://non.existent.proxy:9999')

    // Create browser profile with proxy
    const browserProfile = new BrowserProfile({
      headless: true,
      proxy: proxySettings,
    })

    // Create browser session
    browserSession = new BrowserSession({ browserProfile })

    try {
      await browserSession.start()
      // Success - the browser was initialized with our proxy settings
      // We won't try to make requests (which would fail with non-existent proxy)
      console.log('✅ Browser initialized with proxy settings successfully')
      expect(browserSession.browserProfile.proxy).toBe(proxySettings)
      // TODO: create a network request in the browser and verify it goes through the proxy?
      // would require setting up a whole fake proxy in a fixture
    } finally {
      await browserSession.stop()
      browserSession = null
    }
  })
})
