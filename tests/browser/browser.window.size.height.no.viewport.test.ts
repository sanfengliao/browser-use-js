import { Browser, BrowserConfig } from '@/browser/browser'
import { BrowserContextConfig } from '@/browser/context'
import { expect, it } from 'vitest'

it('test browser window sizing with no_viewport option', async () => {
  console.log('Testing browser window sizing with no_viewport=False...')

  // Create browser with headless mode disabled for visual verification
  const browser = new Browser(new BrowserConfig({ headless: true }))

  try {
    // Configure browser context with specific window dimensions
    const contextConfig = new BrowserContextConfig({
      windowWidth: 1440,
      windowHeight: 900,
      noViewport: false,
    })

    // Create a new browser context with our config
    const browserContext = await browser.newContext(contextConfig)

    try {
      // Get the current page
      const page = await browserContext.getCurrentPage()

      // Navigate to a simple test page
      await page.goto('https://example.com')

      // Wait for page to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Get the actual viewport dimensions
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))

      console.log('Configured size: width=1440, height=900')
      console.log(`Actual viewport size: ${JSON.stringify(viewport)}`)

      // Get the actual window size
      const windowSize = await page.evaluate(
        () => ({
          width: window.outerWidth,
          height: window.outerHeight,
        }),
      )
      console.log(`Actual window size: ${JSON.stringify(windowSize)}`)

      // Add assertions to verify the viewport is close to our configured size
      // Note: exact matching isn't always possible due to browser chrome/decorations
      expect(viewport.width).toBeGreaterThan(1400)
      expect(viewport.height).toBeGreaterThan(850)
    }
    finally {
      // Clean up the browser context
      await browserContext.close()
    }
  }
  finally {
    // Ensure browser is closed even if test fails
    await browser.close()
  }
})

// Add a second test with no_viewport=true for comparison
