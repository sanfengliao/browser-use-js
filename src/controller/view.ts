// Action Input Models
export interface SearchGoogleAction {
  search_google: {
    query: string
  }
}

export interface GoToUrlAction {
  go_to_url: {
    url: string
  }

}

export interface ClickElementAction {
  click_element_by_index: {
    index: number
    xpath?: string
  }

}

export interface InputTextAction {
  input_text: {
    index: number
    text: string
    xpath?: string
  }

}

export interface DoneAction {
  done: {
    text?: string
    success: boolean
    data?: any
  }

}

export interface SwitchTabAction {
  switch_tab: {
    pageId: number
  }

}

export interface OpenTabAction {
  open_tab: {
    url: string
  }
}

export interface CloseTabAction {
  close_tab: {
    pageId: number
  }
}

export interface ScrollUpAction {
  scroll_up: {
    amount?: number // The number of pixels to scroll. If undefined, scroll up one page
  }

}

export interface ScrollDownAction {
  scroll_up: {
    amount?: number // The number of pixels to scroll. If undefined, scroll up one page
  }

}

export interface SendKeysAction {
  send_keys: {
    keys: string
  }

}

export interface ExtractPageContentAction {
  extract_content: {
    goal: string // The goal of the extraction
  }

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
  drag_drop: {
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
}

// 创建 DragDropAction 的辅助函数，提供默认值
export function createDragDropAction(data: Partial<DragDropAction['drag_drop']> = {}): DragDropAction {
  return {
    drag_drop: {
      ...data,
      delayMs: data.delayMs ?? 5,
      steps: data.steps ?? 10,
    },
  }
}
