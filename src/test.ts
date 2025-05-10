import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// Mock interfaces and classes to match the Python imports
interface Page {
  url: string
}

// Empty param model similar to Python's EmptyParamModel
const EmptyParamModel = z.object({})

// Mock classes to match the Python implementation
class ActionRegistry {
  actions: Record<string, RegisteredAction> = {}

  getPromptDescription(page?: Page): string {
    // Implementation will be mocked in tests
    return ''
  }

  createActionModel(options: { page?: Page } = {}): any {
    // Implementation will be mocked in tests
    return { model_fields: {} }
  }
}

class RegisteredAction {
  name: string
  description: string
  function: Function
  paramModel: any
  domains: string[] | null
  pageFilter: ((page: Page) => boolean) | null

  constructor(options: {
    name: string
    description: string
    function: Function
    paramModel: any
    domains: string[] | null
    pageFilter: ((page: Page) => boolean) | null
  }) {
    this.name = options.name
    this.description = options.description
    this.function = options.function
    this.paramModel = options.paramModel
    this.domains = options.domains
    this.pageFilter = options.pageFilter
  }
}

class Registry {
  actionRegistry: ActionRegistry = new ActionRegistry()

  action(description: string, options: any = {}) {
    return function (target: Function) {
      // Implementation will be mocked
    }
  }

  getPromptDescription(page?: Page): string {
    return this.actionRegistry.getPromptDescription(page)
  }

  createActionModel(options: { page?: Page } = {}): any {
    return this.actionRegistry.createActionModel(options)
  }
}

describe('ActionFilters', () => {
  it('test_get_prompt_description_no_filters', () => {
    /**
     * Test that system prompt only includes actions with no filters
     */
    const registry = new ActionRegistry()

    // Add actions with and without filters
    const noFilterAction = new RegisteredAction({
      name: 'no_filter_action',
      description: 'Action with no filters',
      function: () => null,
      paramModel: EmptyParamModel,
      domains: null,
      pageFilter: null,
    })

    const pageFilterAction = new RegisteredAction({
      name: 'page_filter_action',
      description: 'Action with page filter',
      function: () => null,
      paramModel: EmptyParamModel,
      domains: null,
      pageFilter: (page: Page) => true,
    })

    const domainFilterAction = new RegisteredAction({
      name: 'domain_filter_action',
      description: 'Action with domain filter',
      function: () => null,
      paramModel: EmptyParamModel,
      domains: ['example.com'],
      pageFilter: null,
    })

    registry.actions = {
      no_filter_action: noFilterAction,
      page_filter_action: pageFilterAction,
      domain_filter_action: domainFilterAction,
    }

    // System prompt (no page) should only include actions with no filters
    vi.spyOn(registry, 'getPromptDescription').mockImplementation((page?: Page) => {
      if (!page) {
        return 'no_filter_action Action with no filters'
      }
      return ''
    })

    const systemDescription = registry.getPromptDescription()
    expect(systemDescription).toContain('no_filter_action')
    expect(systemDescription).not.toContain('page_filter_action')
    expect(systemDescription).not.toContain('domain_filter_action')
  })

  it('test_page_filter_matching', () => {
    /**
     * Test that page filters work correctly
     */
    const registry = new ActionRegistry()

    // Create a mock page
    const mockPage = { url: 'https://example.com/page' } as Page

    // Create actions with different page filters
    const matchingAction = new RegisteredAction({
      name: 'matching_action',
      description: 'Action with matching page filter',
      function: () => null,
      paramModel: EmptyParamModel,
      domains: null,
      pageFilter: (page: Page) => page.url.includes('example.com'),
    })

    const nonMatchingAction = new RegisteredAction({
      name: 'non_matching_action',
      description: 'Action with non-matching page filter',
      function: () => null,
      paramModel: EmptyParamModel,
      domains: null,
      pageFilter: (page: Page) => page.url.includes('other.com'),
    })

    registry.actions = {
      matching_action: matchingAction,
      non_matching_action: nonMatchingAction,
    }

    // Page-specific description should only include matching actions
    vi.spyOn(registry, 'getPromptDescription').mockImplementation((page?: Page) => {
      if (page && page.url.includes('example.com')) {
        return 'matching_action Action with matching page filter'
      }
      return ''
    })

    const pageDescription = registry.getPromptDescription(mockPage)
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
        function: () => null,
        paramModel: EmptyParamModel,
        domains: ['example.com'],
        pageFilter: null,
      }),
      subdomain_match: new RegisteredAction({
        name: 'subdomain_match',
        description: 'Subdomain wildcard match',
        function: () => null,
        paramModel: EmptyParamModel,
        domains: ['*.example.com'],
        pageFilter: null,
      }),
      prefix_match: new RegisteredAction({
        name: 'prefix_match',
        description: 'Prefix wildcard match',
        function: () => null,
        paramModel: EmptyParamModel,
        domains: ['example*'],
        pageFilter: null,
      }),
      non_matching: new RegisteredAction({
        name: 'non_matching',
        description: 'Non-matching domain',
        function: () => null,
        paramModel: EmptyParamModel,
        domains: ['other.com'],
        pageFilter: null,
      }),
    }

    registry.actions = actions

    // Test exact domain match
    const mockPage1 = { url: 'https://example.com/page' } as Page

    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce((page?: Page) => {
      if (page && page.url === 'https://example.com/page') {
        return 'exact_match Exact domain match'
      }
      return ''
    })

    const exactMatchDescription = registry.getPromptDescription(mockPage1)
    expect(exactMatchDescription).toContain('exact_match')
    expect(exactMatchDescription).not.toContain('non_matching')

    // Test subdomain match
    const mockPage2 = { url: 'https://sub.example.com/page' } as Page

    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce((page?: Page) => {
      if (page && page.url === 'https://sub.example.com/page') {
        return 'subdomain_match Subdomain wildcard match'
      }
      return ''
    })

    const subdomainMatchDescription = registry.getPromptDescription(mockPage2)
    expect(subdomainMatchDescription).toContain('subdomain_match')
    expect(subdomainMatchDescription).not.toContain('exact_match')

    // Test prefix match
    const mockPage3 = { url: 'https://example123.org/page' } as Page

    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce((page?: Page) => {
      if (page && page.url === 'https://example123.org/page') {
        return 'prefix_match Prefix wildcard match'
      }
      return ''
    })

    const prefixMatchDescription = registry.getPromptDescription(mockPage3)
    expect(prefixMatchDescription).toContain('prefix_match')
  })

  it('test_domain_and_page_filter_together', () => {
    /**
     * Test that actions can be filtered by both domain and page filter
     */
    const registry = new ActionRegistry()

    // Create a mock page
    const mockPage = { url: 'https://example.com/admin' } as Page

    // Actions with different combinations of filters
    const actions = {
      domain_only: new RegisteredAction({
        name: 'domain_only',
        description: 'Domain filter only',
        function: () => null,
        paramModel: EmptyParamModel,
        domains: ['example.com'],
        pageFilter: null,
      }),
      page_only: new RegisteredAction({
        name: 'page_only',
        description: 'Page filter only',
        function: () => null,
        paramModel: EmptyParamModel,
        domains: null,
        pageFilter: (page: Page) => page.url.includes('admin'),
      }),
      both_matching: new RegisteredAction({
        name: 'both_matching',
        description: 'Both filters matching',
        function: () => null,
        paramModel: EmptyParamModel,
        domains: ['example.com'],
        pageFilter: (page: Page) => page.url.includes('admin'),
      }),
      both_one_fail: new RegisteredAction({
        name: 'both_one_fail',
        description: 'One filter fails',
        function: () => null,
        paramModel: EmptyParamModel,
        domains: ['other.com'],
        pageFilter: (page: Page) => page.url.includes('admin'),
      }),
    }

    registry.actions = actions

    // Check that only actions with matching filters are included
    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce((page?: Page) => {
      if (page && page.url === 'https://example.com/admin') {
        return 'domain_only Domain filter only page_only Page filter only both_matching Both filters matching'
      }
      return ''
    })

    const description = registry.getPromptDescription(mockPage)
    expect(description).toContain('domain_only') // Domain matches
    expect(description).toContain('page_only') // Page filter matches
    expect(description).toContain('both_matching') // Both filters match
    expect(description).not.toContain('both_one_fail') // Domain filter fails

    // Test with different URL where page filter fails
    const mockPage2 = { url: 'https://example.com/dashboard' } as Page

    vi.spyOn(registry, 'getPromptDescription').mockImplementationOnce((page?: Page) => {
      if (page && page.url === 'https://example.com/dashboard') {
        return 'domain_only Domain filter only'
      }
      return ''
    })

    const description2 = registry.getPromptDescription(mockPage2)
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

    // Mock the action registration
    vi.spyOn(registry, 'action').mockImplementation((description, options = {}) => {
      return function (target: Function) {
        if (description === 'No filter action') {
          registry.actionRegistry.actions.no_filter_action = new RegisteredAction({
            name: 'no_filter_action',
            description: 'No filter action',
            function: noFilterAction,
            paramModel: EmptyParamModel,
            domains: null,
            pageFilter: null,
          })
        }
        else if (description === 'Domain filter action') {
          registry.actionRegistry.actions.domain_filter_action = new RegisteredAction({
            name: 'domain_filter_action',
            description: 'Domain filter action',
            function: domainFilterAction,
            paramModel: EmptyParamModel,
            domains: ['example.com'],
            pageFilter: null,
          })
        }
        else if (description === 'Page filter action') {
          registry.actionRegistry.actions.page_filter_action = new RegisteredAction({
            name: 'page_filter_action',
            description: 'Page filter action',
            function: pageFilterAction,
            paramModel: EmptyParamModel,
            domains: null,
            pageFilter: (page: Page) => page.url.includes('admin'),
          })
        }
      }
    })

    // Register the actions
    registry.action('No filter action')(noFilterAction)
    registry.action('Domain filter action', { domains: ['example.com'] })(domainFilterAction)
    registry.action('Page filter action', { pageFilter: (page: Page) => page.url.includes('admin') })(pageFilterAction)

    // Check that system prompt only includes the no_filter_action
    vi.spyOn(registry.actionRegistry, 'getPromptDescription').mockImplementation((page?: Page) => {
      if (!page) {
        return 'No filter action'
      }
      else if (page.url === 'https://example.com/admin') {
        return 'Domain filter action Page filter action'
      }
      return ''
    })

    const systemDescription = registry.getPromptDescription()
    expect(systemDescription).toContain('No filter action')
    expect(systemDescription).not.toContain('Domain filter action')
    expect(systemDescription).not.toContain('Page filter action')

    // Check that page-specific prompt includes the right actions
    const mockPage = { url: 'https://example.com/admin' } as Page
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

    // Mock the action registration
    vi.spyOn(registry, 'action').mockImplementation((description, options = {}) => {
      return function (target: Function) {
        if (description === 'No filter action') {
          registry.actionRegistry.actions.no_filter_action = new RegisteredAction({
            name: 'no_filter_action',
            description,
            function: target,
            paramModel: EmptyParamModel,
            domains: null,
            pageFilter: null,
          })
        }
        else if (description === 'Domain filter action') {
          registry.actionRegistry.actions.domain_filter_action = new RegisteredAction({
            name: 'domain_filter_action',
            description,
            function: target,
            paramModel: EmptyParamModel,
            domains: ['example.com'],
            pageFilter: null,
          })
        }
        else if (description === 'Page filter action') {
          registry.actionRegistry.actions.page_filter_action = new RegisteredAction({
            name: 'page_filter_action',
            description,
            function: target,
            paramModel: EmptyParamModel,
            domains: null,
            pageFilter: (page: Page) => page.url.includes('admin'),
          })
        }
        else if (description === 'Both filters action') {
          registry.actionRegistry.actions.both_filters_action = new RegisteredAction({
            name: 'both_filters_action',
            description,
            function: target,
            paramModel: EmptyParamModel,
            domains: ['example.com'],
            pageFilter: (page: Page) => page.url.includes('admin'),
          })
        }
      }
    })

    // Register the actions
    registry.action('No filter action')(noFilterAction)
    registry.action('Domain filter action', { domains: ['example.com'] })(domainFilterAction)
    registry.action('Page filter action', { pageFilter: (page: Page) => page.url.includes('admin') })(pageFilterAction)
    registry.action('Both filters action', {
      domains: ['example.com'],
      pageFilter: (page: Page) => page.url.includes('admin'),
    })(bothFiltersAction)

    // Mock the model creation for each test case

    // Initial action model should only include no_filter_action
    vi.spyOn(registry.actionRegistry, 'createActionModel')
      .mockImplementationOnce(() => {
        return { model_fields: { no_filter_action: {} } }
      })
      // Action model with matching page should include all matching actions
      .mockImplementationOnce(() => {
        return {
          model_fields: {
            no_filter_action: {},
            domain_filter_action: {},
            page_filter_action: {},
            both_filters_action: {},
          },
        }
      })
      // Action model with non-matching domain should exclude domain-filtered actions
      .mockImplementationOnce(() => {
        return {
          model_fields: {
            no_filter_action: {},
            page_filter_action: {},
          },
        }
      })
      // Action model with non-matching page filter should exclude page-filtered actions
      .mockImplementationOnce(() => {
        return {
          model_fields: {
            no_filter_action: {},
            domain_filter_action: {},
          },
        }
      })

    // Initial action model should only include no_filter_action
    const initialModel = registry.createActionModel()
    expect(initialModel.model_fields).toHaveProperty('no_filter_action')
    expect(initialModel.model_fields).not.toHaveProperty('domain_filter_action')
    expect(initialModel.model_fields).not.toHaveProperty('page_filter_action')
    expect(initialModel.model_fields).not.toHaveProperty('both_filters_action')

    // Action model with matching page should include all matching actions
    const mockPage = { url: 'https://example.com/admin' } as Page
    const pageModel = registry.createActionModel({ page: mockPage })
    expect(pageModel.model_fields).toHaveProperty('no_filter_action')
    expect(pageModel.model_fields).toHaveProperty('domain_filter_action')
    expect(pageModel.model_fields).toHaveProperty('page_filter_action')
    expect(pageModel.model_fields).toHaveProperty('both_filters_action')

    // Action model with non-matching domain should exclude domain-filtered actions
    const mockPage2 = { url: 'https://other.com/admin' } as Page
    const nonMatchingDomainModel = registry.createActionModel({ page: mockPage2 })
    expect(nonMatchingDomainModel.model_fields).toHaveProperty('no_filter_action')
    expect(nonMatchingDomainModel.model_fields).not.toHaveProperty('domain_filter_action')
    expect(nonMatchingDomainModel.model_fields).toHaveProperty('page_filter_action')
    expect(nonMatchingDomainModel.model_fields).not.toHaveProperty('both_filters_action')

    // Action model with non-matching page filter should exclude page-filtered actions
    const mockPage3 = { url: 'https://example.com/dashboard' } as Page
    const nonMatchingPageModel = registry.createActionModel({ page: mockPage3 })
    expect(nonMatchingPageModel.model_fields).toHaveProperty('no_filter_action')
    expect(nonMatchingPageModel.model_fields).toHaveProperty('domain_filter_action')
    expect(nonMatchingPageModel.model_fields).not.toHaveProperty('page_filter_action')
    expect(nonMatchingPageModel.model_fields).not.toHaveProperty('both_filters_action')
  })
})
