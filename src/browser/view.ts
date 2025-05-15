import type { DOMHistoryElement } from '../dom/history_tree_processor/view'
import type { DOMState } from '../dom/views'

// 定义 TabInfo 接口
interface ITabInfo {
  pageId: number
  url: string
  title: string
  parentPageId?: number // 包含此弹出窗口或跨源 iframe 的父页面
}

// TabInfo 类实现
export class TabInfo implements ITabInfo {
  pageId: number
  url: string
  title: string
  parentPageId?: number

  constructor(data: ITabInfo) {
    this.pageId = data.pageId
    this.url = data.url
    this.title = data.title
    this.parentPageId = data.parentPageId
  }
}

// BrowserState 类
export interface BrowserState extends DOMState {
  url: string
  title: string
  tabs: TabInfo[]
  screenshot?: string
  pixelsAbove?: number
  pixelsBelow?: number
  browserErrors?: string[]

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

  toJSON() {
    return {
      tabs: this.tabs.map((tab) => {
        return {
          ...tab,
        }
      }),
      screenshot: this.screenshot,
      interactedElement: this.interactedElement.map(el => el?.toJSON() || null),
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
