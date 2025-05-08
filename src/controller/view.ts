// Action Input Models
export interface SearchGoogleAction {
  query: string
}

export interface GoToUrlAction {
  url: string
}

export interface ClickElementAction {
  index: number
  xpath?: string
}

export interface InputTextAction {
  index: number
  text: string
  xpath?: string
}

export interface DoneAction {
  text: string
  success: boolean
}

export interface SwitchTabAction {
  pageId: number
}

export interface OpenTabAction {
  url: string
}

export interface CloseTabAction {
  pageId: number
}

export interface ScrollAction {
  amount?: number // The number of pixels to scroll. If undefined, scroll down/up one page
}

export interface SendKeysAction {
  keys: string
}

export interface ExtractPageContentAction {
  value: string
}

export interface NoParamsAction {
  // 空接口，表示无参数
}

export function createNoParamsAction(_data: any): NoParamsAction {
  return {}
}

export interface Position {
  x: number
  y: number
}

export interface DragDropAction {
  // Element-based approach
  elementSource?: string // CSS selector or XPath of the element to drag from
  elementTarget?: string // CSS selector or XPath of the element to drop onto
  elementSourceOffset?: Position // Precise position within the source element to start drag (in pixels from top-left corner)
  elementTargetOffset?: Position // Precise position within the target element to drop (in pixels from top-left corner)

  // Coordinate-based approach (used if selectors not provided)
  coordSourceX?: number // Absolute X coordinate on page to start drag from (in pixels)
  coordSourceY?: number // Absolute Y coordinate on page to start drag from (in pixels)
  coordTargetX?: number // Absolute X coordinate on page to drop at (in pixels)
  coordTargetY?: number // Absolute Y coordinate on page to drop at (in pixels)

  // Common options
  steps?: number // Number of intermediate points for smoother movement (5-20 recommended), defaults to 10
  delayMs?: number // Delay in milliseconds between steps (0 for fastest, 10-20 for more natural), defaults to 5
}

// 创建 DragDropAction 的辅助函数，提供默认值
export function createDragDropAction(data: Partial<DragDropAction> = {}): DragDropAction {
  return {
    ...data,
    steps: data.steps ?? 10,
    delayMs: data.delayMs ?? 5,
  }
}
