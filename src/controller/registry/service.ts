import type { ActionResult } from '@/agent/view'
import type { BrowserContext } from '@/browser/context'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Page } from 'playwright'
import type { ZodType } from 'zod'
import type { RegisteredActionParams, RequiredActionContext } from './view'
import { ProductTelemetry } from '@/telemetry/service'
import { ControllerRegisteredFunctionsTelemetryEvent } from '@/telemetry/view'
import { z } from 'zod'
import zodToJsonSchema from 'zod-to-json-schema'
import { timeExecutionAsync } from '../../utils'
import { ActionRegistry, RegisteredAction } from './view'

type Context = any

interface ExecuteActionParams<C> {
  actionName: string
  params: any
  browser?: BrowserContext
  pageExtractionLlm?: BaseChatModel
  sensitiveData?: Record<string, string>
  availableFilePaths?: string[]
  context?: C
}

interface CreateActionSchemaParams {
  includeActions?: string[]
  page?: any
}

export class Registry<C = Context> {
  /** Service for registering and managing actions */

  registry: ActionRegistry
  telemetry: ProductTelemetry
  excludeActions: string[]

  constructor(excludeActions?: string[]) {
    this.registry = new ActionRegistry()
    this.telemetry = new ProductTelemetry()
    this.excludeActions = excludeActions || []
  }

  registerAction<T extends ZodType, C extends RequiredActionContext>(
    params: RegisteredActionParams<T, C>,
  ) {
    this.registry.actions[params.name] = new RegisteredAction<T, any>(params) as any
  }

  @timeExecutionAsync('--execute_action')
  async executeAction(params: ExecuteActionParams<C>): Promise<ActionResult | string> {
    /** Execute a registered action */
    const {
      actionName,
      params: actionParams,
      browser,
      pageExtractionLlm,
      sensitiveData,
      availableFilePaths,
      context,
    } = params

    if (!this.registry.actions[actionName]) {
      throw new Error(`Action ${actionName} not found`)
    }

    const action = this.registry.actions[actionName]

    try {
      const validatedParams = action.paramSchema.parse(actionParams)

      if (sensitiveData) {
        this.replaceSensitiveData(validatedParams, sensitiveData)
      }

      const requiredActionContext = action.requiredActionContext as RequiredActionContext

      if (requiredActionContext.browser && !browser) {
        throw new Error(`Action ${actionName} requires browser but none provided.`)
      }
      if (requiredActionContext.pageExtractionLlm && !pageExtractionLlm) {
        throw new Error(`Action ${actionName} requires pageExtractionLlm but none provided.`)
      }
      if (requiredActionContext.availableFilePaths && !availableFilePaths) {
        throw new Error(`Action ${actionName} requires availableFilePaths but none provided.`)
      }
      if (requiredActionContext.context && !context) {
        throw new Error(`Action ${actionName} requires context but none provided.`)
      }

      return Promise.resolve(action.execute(validatedParams, {
        browser,
        pageExtractionLlm,
        availableFilePaths,
        context,
        hasSensitiveData: !!sensitiveData,
      }))
    }
    catch (e) {
      throw new Error(`Error executing action ${actionName}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private replaceSensitiveData(params: any, sensitiveData: Record<string, string>): any {
    /** Replaces the sensitive data in the params */
    // In TypeScript, we'd use a regex approach similar to the Python version

    console.log('Replacing sensitive data in params')

    const secretPattern = /<secret>(.*?)<\/secret>/g
    const allMissingPlaceholders = new Set<string>()

    const replaceSecrets = (value: any): any => {
      if (typeof value === 'string') {
        const matches = Array.from(value.matchAll(secretPattern), m => m[1])

        let result = value
        for (const placeholder of matches) {
          if (sensitiveData[placeholder]) {
            result = result.replace(`<secret>${placeholder}</secret>`, sensitiveData[placeholder])
          }
          else {
            allMissingPlaceholders.add(placeholder)
          }
        }

        return result
      }
      else if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) {
          return value.map(replaceSecrets)
        }
        else {
          const result: Record<string, any> = {}
          for (const [k, v] of Object.entries(value)) {
            result[k] = replaceSecrets(v)
          }
          return result
        }
      }

      return value
    }

    const processedParams = replaceSecrets(params)

    // Log a warning if any placeholders are missing
    if (allMissingPlaceholders.size > 0) {
      console.warn(`Missing or empty keys in sensitive_data dictionary: ${[...allMissingPlaceholders].join(', ')}`)
    }

    return processedParams
  }

  createActionSchema(params?: CreateActionSchemaParams) {
    const { includeActions, page } = params || {}

    // Filter actions based on page if provided:
    //   if page is null, only include actions with no filters
    //   if page is provided, only include actions that match the page

    const availableActions: Record<string, RegisteredAction> = {}
    for (const [name, action] of Object.entries(this.registry.actions)) {
      if (includeActions && !includeActions.includes(name)) {
        continue
      }

      // If no page provided, only include actions with no filters
      if (!page) {
        if (!action.pageFilter && !action.domains) {
          availableActions[name] = action
        }
        continue
      }

      // Check page_filter if present
      const domainIsAllowed = ActionRegistry.matchDomains(action.domains, page.url())
      const pageIsAllowed = ActionRegistry.matchPageFilter(action.pageFilter, page)

      // Include action if both filters match (or if either is not present)
      if (domainIsAllowed && pageIsAllowed) {
        availableActions[name] = action
      }
    }

    const schema = Object.entries(availableActions).reduce((acc, [name, action]) => {
      acc[name] = z.optional(action.paramSchema).describe(action.description)
      return acc
    }, {} as Record<string, ZodType>)

    this.telemetry.capture(
      new ControllerRegisteredFunctionsTelemetryEvent(
        Object.entries(availableActions).map(([name, action]) => ({
          name,
          params: zodToJsonSchema(action.paramSchema),
        })),
      ),
    )

    return z.object(schema)
  }

  /**
   * Get a description of all actions for the prompt
   * If page is provided, only include actions that are available for that page
   * based on their filter_func
   */
  getPromptDescription(page?: Page): string {
    return this.registry.getPromptDescription({ page })
  }
}
