import type { ActionResultData } from '@/agent/view'
import type { BrowserContext } from '@/browser/context'

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Page } from 'playwright'

import type { Primitive, ZodType } from 'zod'
import { z } from 'zod'

import { zodToJsonSchema } from 'zod-to-json-schema'

export interface RequiredActionContext {
  browser?: boolean
  pageExtractionLlm?: boolean
  availableFilePaths?: boolean
  context?: boolean
  hasSensitiveData?: boolean
}

interface ActionContext {
  browser: BrowserContext
  pageExtractionLlm: BaseChatModel
  availableFilePaths: string[]
  context: any
  hasSensitiveData: boolean
}

type Falsy = false | 0 | -0 | 0n | '' | '' | `` | null | undefined | typeof Number.NaN

type GetActionContext<T extends RequiredActionContext> = 0 extends (1 & T) ? Partial<ActionContext> : {
  [K in keyof T]: T[K] extends Falsy ? undefined : K extends keyof ActionContext ? ActionContext[K] : never
}

type B = GetActionContext<RequiredActionContext>

type ActionFunction<T extends ZodType = ZodType, C extends RequiredActionContext = any> = (params: z.infer<T>, ext: GetActionContext<C>) => string | Promise<string> | ActionResultData | Promise<ActionResultData>

export interface RegisteredActionParams<T extends ZodType = ZodType, C extends RequiredActionContext = RequiredActionContext> {
  name: string
  description: string
  execute?: ActionFunction<T, C>
  paramSchema?: T
  domains?: string[] // e.g. ['*.google.com', 'www.bing.com', 'yahoo.*]
  pageFilter?: (page: Page) => boolean
  requiredActionContext?: C
}

export type ActionParameters = any

export interface ExecuteActions {
  [actionName: string]: ActionParameters
}
/**
 * Base model for dynamically created action models
 */
export class ActionModel {
  [actionName: string]: ActionParameters
  /**
   * Get the index of the action
   * @returns The index of the action or undefined if not found
   */
  getIndex(): number | undefined {
    // {'clicked_element': {'index':5}}
    const params = Object.values(this)
    if (!params.length) {
      return undefined
    }

    for (const param of params) {
      if (param !== null && typeof param === 'object' && 'index' in param) {
        return param.index
      }
    }
    return undefined
  }

  /**
   * Overwrite the index of the action
   * @param index The new index value
   */
  setIndex(index: number): void {
    // Get the action name and params
    const actionName = Object.keys(this)[0]
    const actionParams = (this as any)[actionName]

    // Update the index directly on the model
    if (actionParams && typeof actionParams === 'object' && 'index' in actionParams) {
      actionParams.index = index
    }
  }
}

export class RegisteredAction<T extends ZodType = ZodType, C extends RequiredActionContext = RequiredActionContext> {
  /** Model for a registered action */
  paramSchema: T
  name: string
  description: string
  execute: ActionFunction<T, C>
  // filters: provide specific domains or a function to determine whether the action should be available on the given page or not
  domains?: string[] // e.g. ['*.google.com', 'www.bing.com', 'yahoo.*]
  pageFilter?: (page: Page) => boolean
  requiredActionContext: C

  constructor(params: RegisteredActionParams<T, C>) {
    this.name = params.name
    this.description = params.description
    this.execute = params.execute || (() => 'do nothing')
    this.domains = params.domains
    this.pageFilter = params.pageFilter
    this.paramSchema = params.paramSchema || z.object({}) as any
    this.requiredActionContext = params.requiredActionContext || ({} as any)
  }

  promptDescription(): string {
    /** Get a description of the action for the prompt */
    return `${this.description}:
      {
        "${this.name}": ${JSON.stringify(zodToJsonSchema(this.paramSchema))},
      }
    `
  }
}

export interface GetPromptDescriptionParams {
  page?: Page
}

export class ActionRegistry {
  /** Model representing the action registry */
  actions: Record<string, RegisteredAction<z.ZodType, any>> = {}

  static matchDomains(domains: string[] | undefined, url: string): boolean {
    /**
     * Match a list of domain glob patterns against a URL.
     *
     * Args:
     *   domainPatterns: A list of domain patterns that can include glob patterns (* wildcard)
     *   url: The URL to match against
     *
     * Returns:
     *   True if the URL's domain matches the pattern, False otherwise
     */
    if (!domains || !url) {
      return true
    }

    try {
      const parsedUrl = new URL(url)
      if (!parsedUrl.hostname) {
        return false
      }

      let domain = parsedUrl.hostname
      // Remove port if present (shouldn't be needed with URL class but kept for consistency)
      if (domain.includes(':')) {
        domain = domain.split(':')[0]
      }

      for (const domainPattern of domains) {
        // Simple glob pattern matching for * wildcard
        const regexPattern = domainPattern.replace(/\./g, '\\.').replace(/\*/g, '.*')
        const regex = new RegExp(`^${regexPattern}$`)
        if (regex.test(domain)) {
          return true
        }
      }
      return false
    }
    catch (e) {
      return false
    }
  }

  static matchPageFilter(pageFilter: ((page: Page) => boolean) | undefined, page: Page): boolean {
    /** Match a page filter against a page */
    if (!pageFilter) {
      return true
    }
    return pageFilter(page)
  }

  /**
   * Get a description of all actions for the prompt
   *
   * Args:
   *   page: If provided, filter actions by page using pageFilter and domains.
   *
   * Returns:
   *   A string description of available actions.
   *   - If page is undefined: return only actions with no pageFilter and no domains (for system prompt)
   *   - If page is provided: return only filtered actions that match the current page (excluding unfiltered actions)
   */
  getPromptDescription(params?: GetPromptDescriptionParams): string {
    const { page } = params || {}

    if (!page) {
      // For system prompt (no page provided), include only actions with no filters
      return Object.values(this.actions)
        .filter(action => action.pageFilter === undefined && action.domains === undefined)
        .map(action => action.promptDescription())
        .join('\n')
    }

    // only include filtered actions for the current page
    const filteredActions: RegisteredAction[] = []

    for (const action of Object.values(this.actions)) {
      if (!(action.domains || action.pageFilter)) {
        // skip actions with no filters, they are already included in the system prompt
        continue
      }

      const domainIsAllowed = ActionRegistry.matchDomains(action.domains, page.url())
      const pageIsAllowed = ActionRegistry.matchPageFilter(action.pageFilter, page)

      if (domainIsAllowed && pageIsAllowed) {
        filteredActions.push(action)
      }
    }

    return filteredActions.map(action => action.promptDescription()).join('\n')
  }
}
