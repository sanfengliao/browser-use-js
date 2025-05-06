import type { DOMHistoryElement } from '../dom/history_tree_processor/view'
import type { DOMElementNode, SelectorMap } from '../dom/views'
import { DOMState } from '../dom/views'

// 定义 TabInfo 接口
interface ITabInfo {
  pageId: number
  url: string
  title: string
  parentPageId?: number | null // 包含此弹出窗口或跨源 iframe 的父页面
}

// TabInfo 类实现
export class TabInfo implements ITabInfo {
  pageId: number
  url: string
  title: string
  parentPageId?: number | null

  constructor(data: ITabInfo) {
    this.pageId = data.pageId
    this.url = data.url
    this.title = data.title
    this.parentPageId = data.parentPageId
  }

  toJSON(): ITabInfo {
    return {
      pageId: this.pageId,
      url: this.url,
      title: this.title,
      parentPageId: this.parentPageId,
    }
  }
}

// BrowserState 类
export class BrowserState extends DOMState {
  url: string
  title: string
  tabs: TabInfo[]
  screenshot?: string
  pixelsAbove: number
  pixelsBelow: number
  browserErrors: string[]

  constructor(data: {
    url: string
    title: string
    tabs: TabInfo[]
    screenshot?: string
    pixelsAbove?: number
    pixelsBelow?: number
    browserErrors?: string[]
    elementTree: DOMElementNode
    selectorMap: SelectorMap
  }) {
    super(data.elementTree, data.selectorMap)
    this.url = data.url
    this.title = data.title
    this.tabs = data.tabs
    this.screenshot = data.screenshot
    this.pixelsAbove = data.pixelsAbove || 0
    this.pixelsBelow = data.pixelsBelow || 0
    this.browserErrors = data.browserErrors || []
  }
}

// BrowserStateHistory 类
export class BrowserStateHistory {
  url: string
  title: string
  tabs: TabInfo[]
  interactedElement: (DOMHistoryElement | null)[]
  screenshot?: string

  constructor(data: {
    url: string
    title: string
    tabs: TabInfo[]
    interactedElement: (DOMHistoryElement | null)[]
    screenshot?: string
  }) {
    this.url = data.url
    this.title = data.title
    this.tabs = data.tabs
    this.interactedElement = data.interactedElement
    this.screenshot = data.screenshot
  }

  toDict(): Record<string, any> {
    return {
      tabs: this.tabs.map(tab => tab.toJSON()),
      screenshot: this.screenshot,
      interactedElement: this.interactedElement.map(el => el?.toDict() || null),
      url: this.url,
      title: this.title,
    }
  }
}

// 自定义错误类
export class BrowserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserError'
  }
}

export class URLNotAllowedError extends BrowserError {
  constructor(message: string) {
    super(message)
    this.name = 'URLNotAllowedError'
  }
}
