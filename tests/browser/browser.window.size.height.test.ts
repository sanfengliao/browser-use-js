/**
 * Example test demonstrating the browser_window_size feature.
 * This test shows how to set a custom window size for the browser.
 */

import { Browser, BrowserConfig } from '@/browser/browser'
import { BrowserContextConfig } from '@/browser/context'
import { expect, it } from 'vitest'

/**
 * Compare configured window size with actual size and report differences
 */
function validateWindowSize(configured: Record<string, number>, actual: Record<string, number>): void {
  // Allow for small differences due to browser chrome, scrollbars, etc.
  const widthDiff = Math.abs(configured.width - actual.width)
  const heightDiff = Math.abs(configured.height - actual.height)

  // Tolerance of 5% or 20px, whichever is greater
  const widthTolerance = Math.max(configured.width * 0.05, 20)
  const heightTolerance = Math.max(configured.height * 0.05, 20)

  if (widthDiff > widthTolerance || heightDiff > heightTolerance) {
    console.log('WARNING: Significant difference between configured and actual window size!')
    console.log(`Width difference: ${widthDiff}px, Height difference: ${heightDiff}px`)

    // Add test assertions
    expect(widthDiff).toBeLessThanOrEqual(widthTolerance)
    expect(heightDiff).toBeLessThanOrEqual(heightTolerance)
  }
  else {
    console.log('Window size validation passed: actual size matches configured size within tolerance')
  }
}

/**
 * Main test that demonstrates setting a custom browser window size
 */
it('browser window size demonstration', { timeout: -1 }, async () => {
  // Create a browser with a specific window size
  const config = new BrowserContextConfig({
    windowWidth: 800,
    windowHeight: 400, // Small size to clearly demonstrate the fix
  })

  let browser: Browser | null = null
  let browserContext: any = null

  try {
    // Initialize the browser with error handling
    try {
      browser = new Browser(
        new BrowserConfig({
          headless: false, // Use non-headless mode to see the window
        }),
      )
    }
    catch (e) {
      console.log(`Failed to initialize browser: ${e}`)
      throw e
    }

    // Create a browser context
    try {
      browserContext = await browser.newContext(config)
    }
    catch (e) {
      console.log(`Failed to create browser context: ${e}`)
      throw e
    }

    // Get the current page
    const page = await browserContext.getCurrentPage()

    // Navigate to a test page with error handling
    try {
      await page.goto('https://example.com')
      await page.waitForLoadState('domcontentloaded')
    }
    catch (e) {
      console.log(`Failed to navigate to example.com: ${e}`)
      console.log('Continuing with test anyway...')
    }

    // Wait a bit to see the window
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Get the actual viewport size using JavaScript
    const viewportSize = await page.evaluate(
      () => {
        return {
          width: window.innerWidth,
          height: window.innerHeight,
        }
      },
    )

    console.log(`Configured window size: width=${config.windowWidth}, height=${config.windowHeight}`)
    console.log(`Actual viewport size: ${JSON.stringify(viewportSize)}`)

    // Validate the window size
    validateWindowSize({ width: config.windowWidth, height: config.windowHeight }, viewportSize)

    // Get the actual outer window size (includes browser chrome)
    const outerWindowSize = await page.evaluate(
      () => {
        return {
          width: window.outerWidth,
          height: window.outerHeight,
        }
      },
    )
    console.log(`Actual outer window size: ${JSON.stringify(outerWindowSize)}`)

    // Wait a bit more to see the window
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  catch (e) {
    console.log(`Unexpected error: ${e}`)
    throw e
  }
  finally {
    // Close resources
    if (browserContext) {
      await browserContext.close()
    }
    if (browser) {
      await browser.close()
    }
  }
})
