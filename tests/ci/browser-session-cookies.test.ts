/**
 * Test script for BrowserSession cookie functionality.
 *
 * Tests cover:
 * - Loading cookies from cookies_file on browser start
 * - Saving cookies to cookies_file
 * - Verifying cookies are applied to browser context
 */

import fs, { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserProfile } from '@/browser/profile'
import { BrowserSession } from '@/browser/session'

// Set up test logging
const logger = console

describe('testBrowserSessionCookies', () => {
  /** Tests for BrowserSession cookie loading and saving functionality. */

  let tempCookiesFile: string
  let browserProfileWithCookies: BrowserProfile
  let browserSessionWithCookies: BrowserSession

  async function createTempCookiesFile(): Promise<string> {
    /** Create a temporary cookies file with test cookies. */
    const tempPath = join(tmpdir(), `cookies_${Date.now()}.json`)
    const testCookies = [
      {
        name: 'test_cookie',
        value: 'test_value',
        domain: 'localhost',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
      {
        name: 'session_cookie',
        value: 'session_12345',
        domain: 'localhost',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]
    writeFileSync(tempPath, JSON.stringify(testCookies))
    return tempPath
  }

  function createBrowserProfileWithCookies(cookiesFile: string): BrowserProfile {
    /** Create a BrowserProfile with cookies_file set. */
    return new BrowserProfile({
      headless: true,
      cookiesFile,
    })
  }

  function createBrowserSessionWithCookies(profile: BrowserProfile): BrowserSession {
    /** Create a BrowserSession with cookie file configured. */
    return new BrowserSession({ browserProfile: profile })
  }

  beforeEach(async () => {
    tempCookiesFile = await createTempCookiesFile()
    browserProfileWithCookies = createBrowserProfileWithCookies(tempCookiesFile)
    browserSessionWithCookies = createBrowserSessionWithCookies(browserProfileWithCookies)
  })

  afterEach(async () => {
    // Cleanup
    try {
      await browserSessionWithCookies.stop()
    } catch (error) {
      // Ignore cleanup errors
    }

    if (existsSync(tempCookiesFile)) {
      unlinkSync(tempCookiesFile)
    }
  })

  it('cookies loaded on start', async () => {
    /** Test that cookies are loaded from cookies_file when browser starts. */
    // Start the browser session
    await browserSessionWithCookies.start()

    // Verify cookies were loaded
    const cookies = await browserSessionWithCookies.getCookies()
    expect(cookies.length).toBeGreaterThanOrEqual(2) // Expected at least 2 cookies to be loaded

    // Check specific cookies
    const cookieNames = new Set(cookies.map(cookie => cookie.name))
    expect(cookieNames.has('test_cookie')).toBe(true)
    expect(cookieNames.has('session_cookie')).toBe(true)

    // Verify cookie values
    const testCookie = cookies.find(c => c.name === 'test_cookie')
    expect(testCookie?.value).toBe('test_value')
    expect(testCookie?.domain).toBe('localhost')
  })

  it('cookies available in page', async () => {
    /** Test that loaded cookies are available to web pages. */
    // Start the browser session
    await browserSessionWithCookies.start()

    // Navigate to test page
    const page = await browserSessionWithCookies.getCurrentPage()
    await page.goto('http://localhost/')
    await page.setContent(`
    <html>
      <body>
        <h1>Cookie Test Page</h1>
        <script>
          document.write("<p>Cookies: " + document.cookie + "</p>");
        </script>
      </body>
    </html>
  `)

    // Check that cookies are available to the page
    const pageCookies = await page.evaluate(() => document.cookie)
    expect(pageCookies).toContain('test_cookie=test_value')
  })

  it('save cookies', async () => {
    /** Test saving cookies to file. */
    // Create a new temp file for saving
    const saveDir = dirname(tempCookiesFile)
    const savePath = join(saveDir, 'saved_cookies.json')

    const session = new BrowserSession({ browserProfile: browserProfileWithCookies })
    await session.start()

    // Navigate to a page and set a new cookie
    const page = await session.getCurrentPage()
    await page.goto('about:blank')
    await page.context().addCookies([{
      name: 'new_cookie',
      value: 'new_value',
      domain: 'localhost',
      path: '/',
    }])

    // Save cookies
    await session.saveCookies(savePath)

    // Verify saved file exists and contains cookies
    expect(existsSync(savePath)).toBe(true)
    const savedCookiesText = fs.readFileSync(savePath, 'utf8')
    const savedCookies = JSON.parse(savedCookiesText)
    expect(savedCookies.length).toBeGreaterThanOrEqual(3) // Original 2 + 1 new

    const cookieNames = new Set(savedCookies.map((cookie: any) => cookie.name))
    expect(cookieNames.has('new_cookie')).toBe(true)

    // Cleanup
    if (existsSync(savePath)) {
      unlinkSync(savePath)
    }
    await session.stop()
  })

  it('nonexistent cookies file', async () => {
    /** Test that browser starts normally when cookies_file doesn't exist. */
    // Use a non-existent file path
    const profile = new BrowserProfile({
      headless: true,

      cookiesFile: '/tmp/nonexistent_cookies.json',
    })

    const session = new BrowserSession({ browserProfile: profile })
    // Should start without errors
    await session.start()

    // Should have no cookies
    const cookies = await session.getCookies()
    expect(cookies.length).toBe(0)

    await session.stop()
  })

  it('invalid cookies file', async () => {
    /** Test that browser handles invalid cookie file gracefully. */
    // Create a file with invalid JSON
    const invalidFile = join(tmpdir(), `invalid_cookies_${Date.now()}.json`)
    writeFileSync(invalidFile, 'not valid json')

    const profile = new BrowserProfile({
      headless: true,

      cookiesFile: invalidFile,
    })

    const session = new BrowserSession({ browserProfile: profile })
    // Should start without errors (warning logged)
    await session.start()

    // Should have no cookies
    const cookies = await session.getCookies()
    expect(cookies.length).toBe(0)

    await session.stop()

    // Cleanup
    if (existsSync(invalidFile)) {
      unlinkSync(invalidFile)
    }
  })

  it('relative cookies file path', async () => {
    /** Test that relative cookies_file paths work correctly. */
    const tempDir = join(tmpdir(), `test_dir_${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })

    // Create profile with relative path
    const profile = new BrowserProfile({
      headless: true,
      cookiesFile: 'test_cookies.json', // Relative path
      downloadsDir: tempDir,
    })

    // Copy test cookies to expected location
    const expectedPath = join(tempDir, 'test_cookies.json')
    const relativeCookies = [{
      name: 'relative_cookie',
      value: 'relative_value',
      domain: 'localhost',
      path: '/',
    }]
    writeFileSync(expectedPath, JSON.stringify(relativeCookies))

    const session = new BrowserSession({ browserProfile: profile })
    await session.start()

    const cookies = await session.getCookies()
    const cookieNames = new Set(cookies.map(cookie => cookie.name))
    expect(cookieNames.has('relative_cookie')).toBe(true)

    // Cleanup
    if (existsSync(expectedPath)) {
      unlinkSync(expectedPath)
    }
    await session.stop()
  })
})
