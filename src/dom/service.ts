import type { Page } from 'playwright'
import type { ViewportInfo } from './history_tree_processor/view'
import type {
  DOMBaseNode,
  DOMState,

  SelectorMap,
} from './views'
import { URL } from 'node:url'
import { Logger } from '../logger'
import { timeExecutionAsync } from '../utils'
import { highlightElement } from './buildDomTree.js'
import {
  DOMElementNode,
  DOMTextNode,
} from './views'

const logger = Logger.getLogger(import.meta.filename)

export class DomService {
  private page: Page
  private xpathCache: Record<string, any>

  constructor(page: Page) {
    this.page = page
    this.xpathCache = {}
  }

  // region - Clickable elements
  @timeExecutionAsync('--get_clickable_elements')
  async getClickableElements(
    {
      highlightElements = true,
      focusElement = -1,
      viewportExpansion = 0,
    }: {
      highlightElements?: boolean
      focusElement?: number
      viewportExpansion?: number
    } = {},

  ): Promise<DOMState> {
    const [elementTree, selectorMap] = await this.buildDomTree(highlightElements, focusElement, viewportExpansion)
    return {
      elementTree,
      selectorMap,
    }
  }

  @timeExecutionAsync('--get_cross_origin_iframes')
  async getCrossOriginIframes(): Promise<string[]> {
    // invisible cross-origin iframes are used for ads and tracking, dont open those
    const hiddenFrameUrls: string[] = await this.page.locator('iframe').filter({ visible: false }).evaluateAll((e: HTMLIFrameElement[]) => e.map(e => e.src))

    const isAdUrl = (url: string): boolean => {
      const parsedUrl = new URL(url)
      return ['doubleclick.net', 'adroll.com', 'googletagmanager.com'].some(
        domain => parsedUrl.hostname.includes(domain),
      )
    }

    return this.page.frames()
      .filter((frame) => {
        try {
          const parsedFrameUrl = new URL(frame.url())
          const parsedPageUrl = new URL(this.page.url())

          return parsedFrameUrl.hostname // exclude data:urls and about:blank
            && parsedFrameUrl.hostname !== parsedPageUrl.hostname // exclude same-origin iframes
            && !hiddenFrameUrls.includes(frame.url()) // exclude hidden frames
            && !isAdUrl(frame.url()) // exclude most common ad network tracker frame URLs
        } catch (e) {
          return false
        }
      })
      .map(frame => frame.url())
  }

  @timeExecutionAsync('--build_dom_tree')
  private async buildDomTree(
    highlightElements: boolean,
    focusElement: number,
    viewportExpansion: number,
  ): Promise<[DOMElementNode, SelectorMap]> {
    if (await this.page.evaluate('1+1') !== 2) {
      throw new Error('The page cannot evaluate javascript code properly')
    }

    if (this.page.url() === 'about:blank') {
      // short-circuit if the page is a new empty tab for speed, no need to inject buildDomTree.js
      return [
        new DOMElementNode(
          {
            tagName: 'body',
            xpath: '',
            attributes: {},
            children: [],
            isVisible: false,
            parent: undefined,
          },
        ),
        {},
      ]
    }

    // NOTE: We execute JS code in the browser to extract important DOM information.
    //       The returned hash map contains information about the DOM tree and the
    //       relationship between the DOM elements.
    const debugMode = logger.getEffectiveLevel() === 10 // logging.DEBUG = 10
    const args = {
      doHighlightElements: highlightElements,
      focusHighlightIndex: focusElement,
      viewportExpansion,
      debugMode,
    }

    try {
      const evalPage = await this.page.evaluate(highlightElement, args)

      // Only log performance metrics in debug mode
      if (debugMode && 'perfMetrics' in evalPage) {
        logger.debug(
          'DOM Tree Building Performance Metrics for: %s\n%s',
          this.page.url(),
          JSON.stringify(evalPage.perfMetrics, null, 2),
        )
      }

      return await this.constructDomTree(evalPage)
    } catch (e) {
      logger.error('Error evaluating JavaScript: %s', e)
      throw e
    }
  }

  @timeExecutionAsync('--construct_dom_tree')
  private async constructDomTree(
    evalPage: Record<string, any>,
  ): Promise<[DOMElementNode, SelectorMap]> {
    const jsNodeMap = evalPage.map
    const jsRootId = evalPage.rootId

    const selectorMap: SelectorMap = {}
    const nodeMap: Record<string, DOMBaseNode> = {}

    for (const [id, nodeData] of Object.entries<any>(jsNodeMap)) {
      const [node, childrenIds] = this.parseNode(nodeData)
      if (!node) {
        continue
      }

      nodeMap[id] = node

      if (node instanceof DOMElementNode && node.highlightIndex !== undefined) {
        selectorMap[node.highlightIndex] = node
      }

      // NOTE: We know that we are building the tree bottom up
      //       and all children are already processed.
      if (node instanceof DOMElementNode) {
        for (const childId of childrenIds) {
          if (!(childId in nodeMap)) {
            continue
          }

          const childNode = nodeMap[childId]

          childNode.parent = node
          node.children.push(childNode)
        }
      }
    }

    const htmlToDict = nodeMap[String(jsRootId)]

    if (!htmlToDict || !(htmlToDict instanceof DOMElementNode)) {
      throw new Error('Failed to parse HTML to dictionary')
    }

    return [htmlToDict, selectorMap]
  }

  private parseNode(
    nodeData: Record<string, any>,
  ): [DOMBaseNode | undefined, number[]] {
    if (!nodeData) {
      return [undefined, []]
    }

    // Process text nodes immediately
    if (nodeData.type === 'TEXT_NODE') {
      const textNode = new DOMTextNode(
        {
          text: nodeData.text,
          isVisible: nodeData.isVisible,
        },
      )
      return [textNode, []]
    }

    // Process coordinates if they exist for element nodes
    let viewportInfo: ViewportInfo | undefined

    if ('viewport' in nodeData) {
      viewportInfo = {
        width: nodeData.viewport.width,
        height: nodeData.viewport.height,
      }
    }

    const elementNode = new DOMElementNode({
      tagName: nodeData.tagName,
      xpath: nodeData.xpath,
      attributes: nodeData.attributes,
      children: [],
      isVisible: nodeData.isVisible || false,
      isInteractive: nodeData.isInteractive || false,
      isTopElement: nodeData.isTopElement || false,
      isInViewport: nodeData.isInViewport || false,
      highlightIndex: nodeData.highlightIndex,
      shadowRoot: nodeData.shadowRoot || false,
      parent: undefined,
      viewportInfo,
    })

    const childrenIds = nodeData.children || []

    return [elementNode, childrenIds]
  }
}
