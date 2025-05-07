import { Browser, BrowserConfig } from '@/browser/browser'
import { expect, it } from 'vitest'

it('test_take_full_page_screenshot', { timeout: 0 }, async () => {
  const browser = new Browser(new BrowserConfig({
    headless: false,
    disableSecurity: true,
  }))
  try {
    const context = await browser.newContext()
    const page = await context.getCurrentPage()
    // Go to a test page
    await page.goto('https://example.com')

    // Wait for 3 seconds
    await new Promise(resolve => setTimeout(resolve, 3000))

    // Take full page screenshot
    const screenshotB64 = await context.takeScreenshot(true)

    // Wait for 3 seconds
    await new Promise(resolve => setTimeout(resolve, 3000))

    // Verify screenshot is not empty and is valid base64
    expect(screenshotB64).not.toBeNull()
    expect(typeof screenshotB64).toBe('string')
    expect(screenshotB64.length).toBeGreaterThan(0)

    // Test we can decode the base64 string
    try {
      Buffer.from(screenshotB64, 'base64')
    }
    catch (e) {
      throw new Error(`Failed to decode base64 screenshot: ${e}`)
    }
  }

  finally {
    browser.close()
  }
})
