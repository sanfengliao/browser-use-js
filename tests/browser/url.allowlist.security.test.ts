import { BrowserContext, BrowserContextConfig } from '@/browser/context'
import { describe, expect, it } from 'vitest'

/**
 * Tests for URL allowlist security bypass prevention.
 */
describe('urlAllowlistSecurity', () => {
  it('test_authentication_bypass_prevention', () => {
    /**
     * Test that the URL allowlist cannot be bypassed using authentication credentials.
     */
    // Create a context config with a sample allowed domain
    const config = new BrowserContextConfig({ allowedDomains: ['example.com'] })
    const context = new BrowserContext({ browser: null as any, config })

    // Security vulnerability test cases
    // These should all be detected as malicious despite containing "example.com"
    expect(context.isUrlAllowed('https://example.com:password@malicious.com')).toBe(false)
    expect(context.isUrlAllowed('https://example.com@malicious.com')).toBe(false)
    expect(context.isUrlAllowed('https://example.com%20@malicious.com')).toBe(false)
    expect(context.isUrlAllowed('https://example.com%3A@malicious.com')).toBe(false)

    // Make sure legitimate auth credentials still work
    expect(context.isUrlAllowed('https://user:password@example.com')).toBe(true)
  })

  it('test_path_traversal_prevention', () => {
    /**
     * Test that the URL allowlist cannot be bypassed using path traversal techniques.
     */
    // Create a context config with a sample allowed domain
    const config = new BrowserContextConfig({ allowedDomains: ['example.com'] })
    const context = new BrowserContext({ browser: null as any, config })

    // Path traversal attempts that should be blocked
    expect(context.isUrlAllowed('https://malicious.com/example.com')).toBe(false)
    expect(context.isUrlAllowed('https://malicious.com/path/to/example.com')).toBe(false)
    expect(context.isUrlAllowed('https://malicious.com/.example.com')).toBe(false)
    expect(context.isUrlAllowed('https://malicious.com?param=example.com')).toBe(false)

    // Legitimate paths on allowed domain should work
    expect(context.isUrlAllowed('https://example.com/path/to/resource')).toBe(true)
    expect(context.isUrlAllowed('https://example.com/malicious.com/resource')).toBe(true)
  })

  it('test_subdomain_handling', () => {
    /**
     * Test proper handling of subdomains for URL allowlist.
     */
    // Create a context config with a sample allowed domain
    const config = new BrowserContextConfig({ allowedDomains: ['example.com'] })
    const context = new BrowserContext({ browser: null as any, config })

    // Legitimate subdomains should be allowed
    expect(context.isUrlAllowed('https://sub.example.com')).toBe(true)
    expect(context.isUrlAllowed('https://deep.sub.example.com')).toBe(true)

    // Domain that ends with our allowed domain but isn't a subdomain
    expect(context.isUrlAllowed('https://notexample.com')).toBe(false)
    expect(context.isUrlAllowed('https://malicious-example.com')).toBe(false)

    // Attempts to spoof with "example.com" in the left part of the domain
    expect(context.isUrlAllowed('https://example.com.malicious.org')).toBe(false)
  })

  it('test_unicode_and_punycode_handling', () => {
    /**
     * Test handling of Unicode characters and Punycode in domain names.
     */
    // Create a context config with a sample allowed domain
    const config = new BrowserContextConfig({ allowedDomains: ['example.com', 'xn--80akhbyknj4f.com'] }) // xn--80akhbyknj4f.com is Punycode
    const context = new BrowserContext({ browser: null as any, config })

    // Unicode domains should be properly normalized
    expect(context.isUrlAllowed('https://sub.éxample.com')).toBe(false) // Not the same as example.com

    // Punycode domains should work if explicitly allowed
    expect(context.isUrlAllowed('https://xn--80akhbyknj4f.com')).toBe(true)

    // Homograph attacks (visually similar characters)
    expect(context.isUrlAllowed('https://examplе.com')).toBe(false) // Uses Cyrillic 'е' instead of Latin 'e'
  })

  it('test_protocol_handling', () => {
    /**
     * Test that different protocols are properly handled.
     */
    // Create a context config with a sample allowed domain
    const config = new BrowserContextConfig({ allowedDomains: ['example.com'] })
    const context = new BrowserContext({ browser: null as any, config })

    // Standard protocols should work
    expect(context.isUrlAllowed('https://example.com')).toBe(true)
    expect(context.isUrlAllowed('http://example.com')).toBe(true)

    // Other protocols should also work if the domain matches
    expect(context.isUrlAllowed('ftp://example.com')).toBe(true)
    expect(context.isUrlAllowed('ws://example.com')).toBe(true)

    // Data URLs and other potentially dangerous schemes should be rejected
    // regardless of what comes after them
    expect(context.isUrlAllowed('data:text/html;base64,example.com')).toBe(false)
    expect(context.isUrlAllowed('javascript:alert(document.domain)')).toBe(false)
    expect(context.isUrlAllowed('file:///etc/passwd')).toBe(false)
  })

  it('test_empty_allowlist_behavior', () => {
    /**
     * Test behavior when allowedDomains is empty or null.
     */
    // When allowedDomains is null, all domains should be allowed
    const configWithNull = new BrowserContextConfig()
    const contextWithNull = new BrowserContext({ browser: null as any, config: configWithNull })
    expect(contextWithNull.isUrlAllowed('https://any-domain.com')).toBe(true)
    expect(contextWithNull.isUrlAllowed('https://another-domain.org')).toBe(true)

    // When allowedDomains is empty array, no domains should be allowed
    const configWithEmpty = new BrowserContextConfig({ allowedDomains: [] })
    const contextWithEmpty = new BrowserContext({ browser: null as any, config: configWithEmpty })
    expect(contextWithEmpty.isUrlAllowed('https://any-domain.com')).toBe(false)
    expect(contextWithEmpty.isUrlAllowed('https://example.com')).toBe(false)
  })

  it('test_multiple_allowed_domains', () => {
    /**
     * Test behavior with multiple allowed domains.
     */
    // Create a context config with multiple allowed domains
    const config = new BrowserContextConfig({ allowedDomains: ['example.com', 'trusted.org', 'safe-site.net'] })
    const context = new BrowserContext({ browser: null as any, config })

    // All allowed domains should work
    expect(context.isUrlAllowed('https://example.com/path')).toBe(true)
    expect(context.isUrlAllowed('https://trusted.org/path')).toBe(true)
    expect(context.isUrlAllowed('https://safe-site.net/path')).toBe(true)

    // Subdomains of all allowed domains should work
    expect(context.isUrlAllowed('https://sub.example.com')).toBe(true)
    expect(context.isUrlAllowed('https://sub.trusted.org')).toBe(true)

    // Other domains should be blocked
    expect(context.isUrlAllowed('https://malicious.com')).toBe(false)
    expect(context.isUrlAllowed('https://example.net')).toBe(false) // Similar but not in allowlist
  })
})
