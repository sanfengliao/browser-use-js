/**
 * Test script for BrowserSession.start() method to ensure proper initialization,
 * concurrency handling, and error handling.
 *
 * Tests cover:
 * - Calling .start() on a session that's already started
 * - Simultaneously calling .start() from two parallel coroutines
 * - Calling .start() on a session that's started but has a closed browser connection
 * - Calling .close() on a session that hasn't been started yet
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserProfile } from '@/browser/profile'
import { BrowserSession } from '@/browser/session'

// Set up test logging
const logger = console
// logger.setLevel(logging.DEBUG)

describe('testBrowserSessionStart', () => {
  /** Tests for BrowserSession.start() method initialization and concurrency. */

  let browserProfile: BrowserProfile
  let browserSession: BrowserSession

  beforeEach(async () => {
    /** Create and provide a BrowserProfile with headless mode. */
    browserProfile = new BrowserProfile({ headless: true })

    /** Create a BrowserSession instance without starting it. */
    browserSession = new BrowserSession({ browserProfile })
  })

  afterEach(async () => {
    // Cleanup: ensure session is stopped
    try {
      await browserSession.stop()
    } catch (error) {
      // pass
    }
  })

  it('start already started session', async () => {
    /** Test calling .start() on a session that's already started. */
    // logger.info('Testing start on already started session')

    // Start the session for the first time
    const result1 = await browserSession.start()
    expect(browserSession.initialized).toBe(true)
    expect(browserSession.browserContext).not.toBeFalsy()
    expect(result1).toBe(browserSession)

    // Start the session again - should return immediately without re-initialization
    const result2 = await browserSession.start()
    expect(result2).toBe(browserSession)
    expect(browserSession.initialized).toBe(true)
    expect(browserSession.browserContext).not.toBeFalsy()

    // Both results should be the same instance
    expect(result1).toBe(result2)
  })

  it('concurrent start calls', async () => {
    /** Test simultaneously calling .start() from two parallel coroutines. */
    // logger.info('Testing concurrent start calls')

    // Track how many times the lock is actually acquired for initialization

    // Start two concurrent calls to start()
    const results = await Promise.allSettled([
      browserSession.start(),
      browserSession.start(),
    ])

    // Both should succeed and return the same session instance
    expect(results.every(result =>
      result.status === 'fulfilled' && result.value === browserSession,
    )).toBe(true)
    expect(browserSession.initialized).toBe(true)
    expect(browserSession.browserContext).not.toBeFalsy()

    // The lock should have been acquired twice (once per coroutine)
    // but only one should have done the actual initialization
  })

  it('start with closed browser connection', async () => {
    /** Test calling .start() on a session that's started but has a closed browser connection. */
    // logger.info('Testing start with closed browser connection')

    // Start the session normally
    await browserSession.start()
    expect(browserSession.initialized).toBe(true)
    expect(browserSession.browserContext).not.toBeFalsy()

    // Simulate a closed browser connection by closing the browser
    if (browserSession.browser) {
      await browserSession.browser.close()
    }

    // The session should detect the closed connection and reinitialize
    const result = await browserSession.start()
    expect(result).toBe(browserSession)
    expect(browserSession.initialized).toBe(true)
    expect(browserSession.browserContext).not.toBeFalsy()
  })

  it('start with missing browser context', async () => {
    /** Test calling .start() when browser_context is None but initialized is True. */
    // logger.info('Testing start with missing browser context')

    // Manually set initialized to True but leave browser_context as None
    browserSession.initialized = true
    browserSession.browserContext = undefined

    // Start should detect this inconsistent state and reinitialize
    const result = await browserSession.start()
    expect(result).toBe(browserSession)
    expect(browserSession.initialized).toBe(true)
    expect(browserSession.browserContext).not.toBeFalsy()
  })

  it('close unstarted session', async () => {
    /** Test calling .close() on a session that hasn't been started yet. */
    // logger.info('Testing close on unstarted session')

    // Ensure session is not started
    expect(browserSession.initialized).toBe(false)
    expect(browserSession.browserContext).toBeFalsy()

    // Close should not raise an exception
    await browserSession.stop()

    // State should remain unchanged
    expect(browserSession.initialized).toBe(false)
    expect(browserSession.browserContext).toBeFalsy()
  })

  it('close alias method', async () => {
    /** Test the deprecated .close() alias method. */
    // logger.info('Testing deprecated close alias method')

    // Start the session
    await browserSession.start()
    expect(browserSession.initialized).toBe(true)

    // Use the deprecated close method
    await browserSession.close()

    // Session should be stopped
    expect(browserSession.initialized).toBe(false)
  })

  it('multiple concurrent operations after start', async () => {
    /** Test that multiple operations can run concurrently after start() completes. */
    // logger.info('Testing multiple concurrent operations after start')

    // Start the session
    await browserSession.start()

    // Run multiple operations concurrently that require initialization
    const getTabs = async () => {
      return await browserSession.getTabsInfo()
    }

    const getCurrentPage = async () => {
      return await browserSession.getCurrentPage()
    }

    const takeScreenshot = async () => {
      return await browserSession.takeScreenshot()
    }

    // All operations should succeed concurrently
    const results = await Promise.allSettled([
      getTabs(),
      getCurrentPage(),
      takeScreenshot(),
    ])

    // Check that all operations completed successfully
    expect(results.length).toBe(3)
    expect(results.every(r => r.status === 'fulfilled')).toBe(true)
  })

  it('start with keep alive profile', async () => {
    /** Test start/stop behavior with keep_alive=True profile. */
    // logger.info('Testing start with keep_alive profile')

    const profile = new BrowserProfile({ headless: true, keepAlive: true })
    const session = new BrowserSession({ browserProfile: profile })

    try {
      await session.start()
      expect(session.initialized).toBe(true)

      // Stop should not actually close the browser with keep_alive=True
      await session.stop()
      // initialized flag should still be False after stop()
      expect(session.initialized).toBe(false)
    } finally {
      // Force cleanup for test
      session.browserProfile.keepAlive = false
      await session.stop()
    }
  })

  it('require initialization decorator already started', async () => {
    /** Test @require_initialization decorator when session is already started. */
    // logger.info('Testing @require_initialization decorator with already started session')

    // Start the session first
    await browserSession.start()
    expect(browserSession.initialized).toBe(true)
    expect(browserSession.browserContext).not.toBeNull()

    // Track if start() gets called again by monitoring the lock acquisition

    // Call a method decorated with @require_initialization
    // This should work without calling start() again
    const tabsInfo = await browserSession.getTabsInfo()

    // Verify the method worked and start() wasn't called again (lock not acquired)
    expect(Array.isArray(tabsInfo)).toBe(true)

    expect(browserSession.initialized).toBe(true)
  })

  it('require initialization decorator not started', async () => {
    /** Test @require_initialization decorator when session is not started. */
    // logger.info('Testing @require_initialization decorator with unstarted session')

    // Ensure session is not started
    expect(browserSession.initialized).toBe(false)
    expect(browserSession.browserContext).toBeFalsy()

    // Track calls to start() method
    const originalStart = browserSession.start
    let startCallCount = 0

    const countingStart = async () => {
      startCallCount += 1
      return await originalStart.call(browserSession)
    };

    (browserSession as any).start = countingStart

    // Call a method that requires initialization
    const tabsInfo = await browserSession.getTabsInfo()

    // Verify the decorator called start() and the session is now initialized
    expect(startCallCount).toBe(1) // start() should have been called once
    expect(browserSession.initialized).toBe(true)
    expect(browserSession.browserContext).toBeTruthy()
    expect(Array.isArray(tabsInfo)).toBe(true) // Should return valid tabs info
  })

  it('require initialization decorator with closed page', async () => {
    /** Test @require_initialization decorator handles closed pages correctly. */
    // logger.info('Testing @require_initialization decorator with closed page')

    // Start the session and get a page
    await browserSession.start()
    const currentPage = await browserSession.getCurrentPage()
    expect(currentPage).not.toBeNull()
    expect(currentPage.isClosed()).toBe(false)

    // Close the current page
    await currentPage.close()

    // Call a method decorated with @require_initialization
    // This should create a new tab since the current page is closed
    const tabsInfo = await browserSession.getTabsInfo()

    // Verify a new page was created
    expect(Array.isArray(tabsInfo)).toBe(true)
    const newCurrentPage = await browserSession.getCurrentPage()
    expect(newCurrentPage).not.toBeNull()
    expect(newCurrentPage.isClosed()).toBe(false)
    expect(newCurrentPage).not.toBe(currentPage) // Should be a different page
  })
})
