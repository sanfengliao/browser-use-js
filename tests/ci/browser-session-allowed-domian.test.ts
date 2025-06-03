import { describe, expect, it } from 'vitest'
import { BrowserProfile } from '../../src/browser/profile'
import { BrowserSession } from '../../src/browser/session'

describe('testUrlAllowlistSecurity', () => {
  /** Tests for URL allowlist security bypass prevention and URL allowlist glob pattern matching. */

  it('authentication bypass prevention', () => {
    /** Test that the URL allowlist cannot be bypassed using authentication credentials. */
    // Create a context config with a sample allowed domain
    const browserProfile = new BrowserProfile({ allowedDomains: ['example.com'] })
    const browserSession = new BrowserSession({ browserProfile })

    // Security vulnerability test cases
    // These should all be detected as malicious despite containing "example.com"
    expect(browserSession.isUrlAllowed('https://example.com:password@malicious.com')).toBe(false)
    expect(browserSession.isUrlAllowed('https://example.com@malicious.com')).toBe(false)
    expect(browserSession.isUrlAllowed('https://example.com%20@malicious.com')).toBe(false)
    expect(browserSession.isUrlAllowed('https://example.com%3A@malicious.com')).toBe(false)

    // Make sure legitimate auth credentials still work
    expect(browserSession.isUrlAllowed('https://user:password@example.com')).toBe(true)
  })

  it('glob pattern matching', () => {
    /** Test that glob patterns in allowed_domains work correctly. */
    // Test *.example.com pattern (should match subdomains and main domain)
    let browserProfile = new BrowserProfile({ allowedDomains: ['*.example.com'] })
    let browserSession = new BrowserSession({ browserProfile })

    // Should match subdomains
    expect(browserSession.isUrlAllowed('https://sub.example.com')).toBe(true)
    expect(browserSession.isUrlAllowed('https://deep.sub.example.com')).toBe(true)

    // Should also match main domain
    expect(browserSession.isUrlAllowed('https://example.com')).toBe(true)

    // Should not match other domains
    expect(browserSession.isUrlAllowed('https://notexample.com')).toBe(false)
    expect(browserSession.isUrlAllowed('https://example.org')).toBe(false)

    // Test more complex glob patterns
    browserProfile = new BrowserProfile({
      allowedDomains: ['*.google.com', 'https://wiki.org', 'https://good.com', 'chrome://version', 'brave://*'],
    })
    browserSession = new BrowserSession({ browserProfile })

    // Should match domains ending with google.com
    expect(browserSession.isUrlAllowed('https://google.com')).toBe(true)
    expect(browserSession.isUrlAllowed('https://www.google.com')).toBe(true)
    // make sure we dont allow *good.com patterns, only *.good.com
    expect(browserSession.isUrlAllowed('https://evilgood.com')).toBe(false)

    // Should match domains starting with wiki
    expect(browserSession.isUrlAllowed('http://wiki.org')).toBe(false)
    expect(browserSession.isUrlAllowed('https://wiki.org')).toBe(true)

    // Should not match internal domains because scheme was not provided
    expect(browserSession.isUrlAllowed('chrome://google.com')).toBe(false)
    expect(browserSession.isUrlAllowed('chrome://abc.google.com')).toBe(false)

    // Test browser internal URLs
    expect(browserSession.isUrlAllowed('chrome://settings')).toBe(false)
    expect(browserSession.isUrlAllowed('chrome://version')).toBe(true)
    expect(browserSession.isUrlAllowed('chrome-extension://version/')).toBe(false)
    expect(browserSession.isUrlAllowed('brave://anything/')).toBe(true)
    expect(browserSession.isUrlAllowed('about:blank')).toBe(true)

    // Test security for glob patterns (authentication credentials bypass attempts)
    // These should all be detected as malicious despite containing allowed domain patterns
    expect(browserSession.isUrlAllowed('https://allowed.example.com:password@notallowed.com')).toBe(false)
    expect(browserSession.isUrlAllowed('https://subdomain.example.com@evil.com')).toBe(false)
    expect(browserSession.isUrlAllowed('https://sub.example.com%20@malicious.org')).toBe(false)
    expect(browserSession.isUrlAllowed('https://anygoogle.com@evil.org')).toBe(false)
  })

  it('glob pattern edge cases', () => {
    /** Test edge cases for glob pattern matching to ensure proper behavior. */
    // Test with domains containing glob pattern in the middle
    let browserProfile = new BrowserProfile({ allowedDomains: ['*.google.com', 'https://wiki.org'] })
    let browserSession = new BrowserSession({ browserProfile })

    // Verify that 'wiki*' pattern doesn't match domains that merely contain 'wiki' in the middle
    expect(browserSession.isUrlAllowed('https://notawiki.com')).toBe(false)
    expect(browserSession.isUrlAllowed('https://havewikipages.org')).toBe(false)
    expect(browserSession.isUrlAllowed('https://my-wiki-site.com')).toBe(false)

    // Verify that '*google.com' doesn't match domains that have 'google' in the middle
    expect(browserSession.isUrlAllowed('https://mygoogle.company.com')).toBe(false)

    // Create context with potentially risky glob pattern that demonstrates security concerns
    browserProfile = new BrowserProfile({ allowedDomains: ['*.google.com', '*.google.co.uk'] })
    browserSession = new BrowserSession({ browserProfile })

    // Should match legitimate Google domains
    expect(browserSession.isUrlAllowed('https://www.google.com')).toBe(true)
    expect(browserSession.isUrlAllowed('https://mail.google.co.uk')).toBe(true)

    // Shouldn't match potentially malicious domains with a similar structure
    // This demonstrates why the previous pattern was risky and why it's now rejected
    expect(browserSession.isUrlAllowed('https://www.google.evil.com')).toBe(false)
  })
})
