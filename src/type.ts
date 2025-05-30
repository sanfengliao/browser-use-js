export type AnyFunction = (...args: any[]) => any

declare global {
  interface Window {
    isPdfViewer: boolean
    _eventListenerTrackerInitialized: boolean
    getEventListenersForNode: (node: Node) => any
    _BrowserUseonTabVisibilityChange: (params: any) => void
  }
}
