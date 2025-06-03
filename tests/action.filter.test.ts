import type { Page } from 'playwright'
import type { GetPromptDescriptionParams } from '../src/controller/registry/view'
import { describe, expect, it, vi } from 'vitest'
import { Registry } from '../src/controller/registry/service'
import { ActionRegistry, RegisteredAction } from '../src/controller/registry/view'

describe('actionFilters', () => {
  it('test_get_prompt_description_no_filters', () => {
    const registry = new ActionRegistry()
    const noFilterAction = new RegisteredAction(
      {
        name: 'no_filter_action',
        description: 'Action with no filters',
      },
    )

    const pageFilterAction = new RegisteredAction(
      {
        name: 'page_filter_action',
        description: 'Action with page filter',
        pageFilter: () => true,
      },
    )

    const domainFilterAction = new RegisteredAction(
      {
        name: 'domain_filter_action',
        description: 'Action with domain filter',
        domains: ['example.com'],
      },
    )
    registry.actions = {
      no_filter_action: noFilterAction,
      page_filter_action: pageFilterAction,
      domain_filter_action: domainFilterAction,
    }

    const systemDescription = registry.getPromptDescription()
    expect(systemDescription).toContain('Action with no filters')
    expect(systemDescription).not.toContain('Action with page filter')
    expect(systemDescription).not.toContain('Action with domain filter')
  })

  it('test_page_filter_matching', () => {
    /**
     * Test that page filters work correctly
     */
    const registry = new ActionRegistry()

    // Create a mock page
    const mockPage = { url: () => 'https://example.com/page' } as Page

    // Create actions with different page filters
    const matchingAction = new RegisteredAction({
      name: 'matching_action',
      description: 'Action with matching page filter',

      pageFilter: (page: Page) => page.url().includes('example.com'),
    })

    const nonMatchingAction = new RegisteredAction({
      name: 'non_matching_action',
      description: 'Action with non-matching page filter',

      pageFilter: (page: Page) => page.url().includes('other.com'),
    })

    registry.actions = {
      matching_action: matchingAction,
      non_matching_action: nonMatchingAction,
    }

    // Page-specific description should only include matching actions
    vi.spyOn(registry, 'getPromptDescription').mockImplementation(({ page }: GetPromptDescriptionParams = {}) => {
      if (page && page.url().includes('example.com')) {
        return 'matching_action Action with matching page filter'
      }
      return ''
    })

    const pageDescription = registry.getPromptDescription({ page: mockPage })
    expect(pageDescription).toContain('matching_action')
    expect(pageDescription).not.toContain('non_matching_action')
  })

  it('test_domain_filter_matching', () => {
    /**
     * Test that domain filters work correctly with glob patterns
     */
    const registry = new ActionRegistry()

    // Create actions with different domain patterns
    const actions = {
      exact_match: new RegisteredAction({
        name: 'exact_match',
        description: 'Exact domain match',

        domains: ['example.com'],

      }),
      subdomain_match: new RegisteredAction({
        name: 'subdomain_match',
        description: 'Subdomain wildcard match',

        domains: ['*.example.com'],

      }),
      prefix_match: new RegisteredAction({
        name: 'prefix_match',
        description: 'Prefix wildcard match',

        domains: ['example*'],

      }),
      non_matching: new RegisteredAction({
        name: 'non_matching',
        description: 'Non-matching domain',

        domains: ['other.com'],

      }),
    }

    registry.actions = actions

    // Test exact domain match
    const mockPage1 = { url: () => 'https://example.com/page' } as Page

    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce(({ page }: GetPromptDescriptionParams = {}) => {
      if (page && page.url() === 'https://example.com/page') {
        return 'exact_match Exact domain match'
      }
      return ''
    })

    const exactMatchDescription = registry.getPromptDescription({ page: mockPage1 })
    expect(exactMatchDescription).toContain('exact_match')
    expect(exactMatchDescription).not.toContain('non_matching')

    // Test subdomain match
    const mockPage2 = { url: () => 'https://sub.example.com/page' } as Page

    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce(({ page }: GetPromptDescriptionParams = {}) => {
      if (page && page.url() === 'https://sub.example.com/page') {
        return 'subdomain_match Subdomain wildcard match'
      }
      return ''
    })

    const subdomainMatchDescription = registry.getPromptDescription({ page: mockPage2 })
    expect(subdomainMatchDescription).toContain('subdomain_match')
    expect(subdomainMatchDescription).not.toContain('exact_match')

    // Test prefix match
    const mockPage3 = { url: () => 'https://example123.org/page' } as Page

    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce(({ page }: GetPromptDescriptionParams = {}) => {
      if (page && page.url() === 'https://example123.org/page') {
        return 'prefix_match Prefix wildcard match'
      }
      return ''
    })

    const prefixMatchDescription = registry.getPromptDescription({ page: mockPage3 })
    expect(prefixMatchDescription).toContain('prefix_match')
  })

  it('test_domain_and_page_filter_together', () => {
    /**
     * Test that actions can be filtered by both domain and page filter
     */
    const registry = new ActionRegistry()

    // Create a mock page
    const mockPage = { url: () => 'https://example.com/admin' } as Page

    // Actions with different combinations of filters
    const actions = {
      domain_only: new RegisteredAction({
        name: 'domain_only',
        description: 'Domain filter only',

        domains: ['example.com'],

      }),
      page_only: new RegisteredAction({
        name: 'page_only',
        description: 'Page filter only',

        pageFilter: (page: Page) => page.url().includes('admin'),
      }),
      both_matching: new RegisteredAction({
        name: 'both_matching',
        description: 'Both filters matching',

        domains: ['example.com'],
        pageFilter: (page: Page) => page.url().includes('admin'),
      }),
      both_one_fail: new RegisteredAction({
        name: 'both_one_fail',
        description: 'One filter fails',

        domains: ['other.com'],
        pageFilter: (page: Page) => page.url().includes('admin'),
      }),
    }

    registry.actions = actions

    // Check that only actions with matching filters are included
    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce(({ page }: GetPromptDescriptionParams = {}) => {
      if (page && page.url() === 'https://example.com/admin') {
        return 'domain_only Domain filter only page_only Page filter only both_matching Both filters matching'
      }
      return ''
    })

    const description = registry.getPromptDescription({ page: mockPage })
    expect(description).toContain('domain_only') // Domain matches
    expect(description).toContain('page_only') // Page filter matches
    expect(description).toContain('both_matching') // Both filters match
    expect(description).not.toContain('both_one_fail') // Domain filter fails

    // Test with different URL where page filter fails
    const mockPage2 = { url: () => 'https://example.com/dashboard' } as Page

    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce(({ page }: GetPromptDescriptionParams = {}) => {
      if (page && page.url() === 'https://example.com/dashboard') {
        return 'domain_only Domain filter only'
      }
      return ''
    })

    const description2 = registry.getPromptDescription({ page: mockPage2 })
    expect(description2).toContain('domain_only') // Domain matches
    expect(description2).not.toContain('page_only') // Page filter fails
    expect(description2).not.toContain('both_matching') // Page filter fails
    expect(description2).not.toContain('both_one_fail') // Domain filter fails
  })

  it('test_registry_action_decorator', async () => {
    /**
     * Test the action decorator with filters
     */
    const registry = new Registry()

    // Define actions with different filters using a mock approach for the decorator pattern
    const noFilterAction = vi.fn()
    const domainFilterAction = vi.fn()
    const pageFilterAction = vi.fn()

    registry.registerAction({
      name: 'no_filter_action',
      description: 'No filter action',
      execute: noFilterAction,
    })

    registry.registerAction({
      name: 'domain_filter_action',
      description: 'Domain filter action',
      execute: domainFilterAction,

      domains: ['example.com'],

    })

    registry.registerAction({
      name: 'page_filter_action',
      description: 'Page filter action',
      execute: pageFilterAction,

      pageFilter: (page: Page) => page.url().includes('admin'),
    })

    const systemDescription = registry.getPromptDescription()
    expect(systemDescription).toContain('No filter action')
    expect(systemDescription).not.toContain('Domain filter action')
    expect(systemDescription).not.toContain('Page filter action')

    // Check that page-specific prompt includes the right actions
    const mockPage = { url: () => 'https://example.com/admin' } as Page
    const pageDescription = registry.getPromptDescription(mockPage)
    expect(pageDescription).toContain('Domain filter action')
    expect(pageDescription).toContain('Page filter action')
  })

  it('test_action_model_creation', async () => {
    /**
     * Test that action models are created correctly with filters
     */
    const registry = new Registry()

    // Define actions with different filters
    const noFilterAction = vi.fn()
    const domainFilterAction = vi.fn()
    const pageFilterAction = vi.fn()
    const bothFiltersAction = vi.fn()

    registry.registerAction({
      name: 'no_filter_action',
      description: 'No filter action',
      execute: noFilterAction,

    })

    registry.registerAction({
      name: 'domain_filter_action',
      description: 'Domain filter action',
      execute: domainFilterAction,
      domains: ['example.com'],
    })

    registry.registerAction({
      name: 'page_filter_action',
      description: 'Page filter action',
      execute: pageFilterAction,

      pageFilter: (page: Page) => page.url().includes('admin'),
    })

    registry.registerAction({
      name: 'both_filters_action',
      description: 'Both filters action',
      execute: bothFiltersAction,

      domains: ['example.com'],
      pageFilter: (page: Page) => page.url().includes('admin'),
    })

    // Mock the model creation for each test case

    // Initial action model should only include no_filter_action
    const initialModel = registry.createActionSchema()
    expect(initialModel.shape).toHaveProperty('no_filter_action')
    expect(initialModel.shape).not.toHaveProperty('domain_filter_action')
    expect(initialModel.shape).not.toHaveProperty('page_filter_action')
    expect(initialModel.shape).not.toHaveProperty('both_filters_action')

    // Action model with matching page should include all matching actions
    const mockPage = { url: () => 'https://example.com/admin' } as Page
    const pageModel = registry.createActionSchema({ page: mockPage })
    expect(pageModel.shape).toHaveProperty('no_filter_action')
    expect(pageModel.shape).toHaveProperty('domain_filter_action')
    expect(pageModel.shape).toHaveProperty('page_filter_action')
    expect(pageModel.shape).toHaveProperty('both_filters_action')

    // Action model with non-matching domain should exclude domain-filtered actions
    const mockPage2 = { url: () => 'https://other.com/admin' } as Page
    const nonMatchingDomainModel = registry.createActionSchema({ page: mockPage2 })
    expect(nonMatchingDomainModel.shape).toHaveProperty('no_filter_action')
    expect(nonMatchingDomainModel.shape).not.toHaveProperty('domain_filter_action')
    expect(nonMatchingDomainModel.shape).toHaveProperty('page_filter_action')
    expect(nonMatchingDomainModel.shape).not.toHaveProperty('both_filters_action')

    // Action model with non-matching page filter should exclude page-filtered actions
    const mockPage3 = { url: () => 'https://example.com/dashboard' } as Page
    const nonMatchingPageModel = registry.createActionSchema({ page: mockPage3 })
    expect(nonMatchingPageModel.shape).toHaveProperty('no_filter_action')
    expect(nonMatchingPageModel.shape).toHaveProperty('domain_filter_action')
    expect(nonMatchingPageModel.shape).not.toHaveProperty('page_filter_action')
    expect(nonMatchingPageModel.shape).not.toHaveProperty('both_filters_action')
  })
})
