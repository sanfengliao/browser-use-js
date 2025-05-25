export abstract class BaseTelemetryEvent {
  abstract name: string
  get properties(): Record<string, any> {
    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(this)) {
      if (key !== 'name') {
        result[key] = value
      }
    }
    return result
  }
}

export interface RegisteredFunction {
  name: string
  params: Record<string, any>
}

export class ControllerRegisteredFunctionsTelemetryEvent extends BaseTelemetryEvent {
  registeredFunctions: RegisteredFunction[]
  name: string = 'controller_registered_functions'

  constructor(registeredFunctions: RegisteredFunction[]) {
    super()
    this.registeredFunctions = registeredFunctions
  }
}

export interface AgentEventParams {
  task: string
  model: string
  modelProvider: string
  plannerLLm?: string
  maxSteps: number
  maxActionsPerStep: number
  useVision: boolean
  useValidation: boolean
  version: string
  source: string
  actionErrors: (string | undefined)[]
  actionHistory: (Record<string, any>[] | undefined)[]
  urlVisited: (string | undefined)[]

  // end details
  steps: number
  totalInputTokens: number
  totalDurationSeconds: number
  success?: boolean
  finalResultResponse?: string
  errorMessage?: string
}

export class AgentTelemetryEvent extends BaseTelemetryEvent {
  // start details
  task: string
  model: string
  modelProvider: string
  plannerLLm?: string
  maxSteps: number
  maxActionsPerStep: number
  useVision: boolean
  useValidation: boolean
  version: string
  source: string
  actionErrors: (string | undefined)[]
  actionHistory: (Record<string, any>[] | undefined)[]
  urlVisited: (string | undefined)[]

  // end details
  steps: number
  totalInputTokens: number
  totalDurationSeconds: number
  success?: boolean
  finalResultResponse?: string
  errorMessage?: string
  readonly name: string = 'agent_event'

  constructor(params: AgentEventParams) {
    super()
    this.task = params.task
    this.model = params.model
    this.modelProvider = params.modelProvider
    this.plannerLLm = params.plannerLLm
    this.maxSteps = params.maxSteps
    this.maxActionsPerStep = params.maxActionsPerStep
    this.useVision = params.useVision
    this.useValidation = params.useValidation
    this.version = params.version
    this.source = params.source
    this.actionErrors = params.actionErrors
    this.actionHistory = params.actionHistory
    this.urlVisited = params.urlVisited
    this.steps = params.steps
    this.totalInputTokens = params.totalInputTokens
    this.totalDurationSeconds = params.totalDurationSeconds
    this.success = params.success
    this.finalResultResponse = params.finalResultResponse
    this.errorMessage = params.errorMessage
  }
}
