export abstract class BaseTelemetryEvent {
  abstract get name(): string

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

export interface AgentStepParams {
  agentId: string
  step: number
  stepError: string[]
  consecutiveFailures: number
  actions: Record<string, any>[]
}

export class AgentStepTelemetryEvent extends BaseTelemetryEvent {
  agentId: string
  step: number
  stepError: string[]
  consecutiveFailures: number
  actions: Record<string, any>[]
  readonly name: string = 'agent_step'

  constructor(params: AgentStepParams) {
    super()
    this.agentId = params.agentId
    this.step = params.step
    this.stepError = params.stepError
    this.consecutiveFailures = params.consecutiveFailures
    this.actions = params.actions
  }
}

export interface AgentRunParams {
  agentId: string
  useVision: boolean
  task: string
  modelName: string
  chatModelLibrary: string
  version: string
  source: string
}

export class AgentRunTelemetryEvent extends BaseTelemetryEvent {
  agentId: string
  useVision: boolean
  task: string
  modelName: string
  chatModelLibrary: string
  version: string
  source: string
  readonly name: string = 'agent_run'

  constructor(params: AgentRunParams) {
    super()
    this.agentId = params.agentId
    this.useVision = params.useVision
    this.task = params.task
    this.modelName = params.modelName
    this.chatModelLibrary = params.chatModelLibrary
    this.version = params.version
    this.source = params.source
  }
}

export interface AgentEndParams {
  agentId: string
  steps: number
  maxStepsReached: boolean
  isDone: boolean
  success?: boolean
  totalInputTokens: number
  totalDurationSeconds: number
  errors: (string | null)[]
}

export class AgentEndTelemetryEvent extends BaseTelemetryEvent {
  agentId: string
  steps: number
  maxStepsReached: boolean
  isDone: boolean
  success?: boolean
  totalInputTokens: number
  totalDurationSeconds: number
  errors: (string | null)[]
  readonly name: string = 'agent_end'

  constructor(params: AgentEndParams) {
    super()
    this.agentId = params.agentId
    this.steps = params.steps
    this.maxStepsReached = params.maxStepsReached
    this.isDone = params.isDone
    this.success = params.success
    this.totalInputTokens = params.totalInputTokens
    this.totalDurationSeconds = params.totalDurationSeconds
    this.errors = params.errors
  }
}
