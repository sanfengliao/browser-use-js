import type { CoordinateSet, HashedDomElement, ViewportInfo } from './history_tree_processor/view'
import { timeExecutionSync } from '@/utils'
import { HistoryTreeProcessor } from './history_tree_processor/service'

abstract class DOMBaseNode {
  isVisible: boolean
  parent?: DOMElementNode

  constructor(isVisible: boolean, parent?: DOMElementNode) {
    this.isVisible = isVisible
    this.parent = parent
  }

  abstract toJSON(): Record<string, any>
}

class DOMTextNode extends DOMBaseNode {
  text: string
  type: string

  constructor({ text, isVisible, parent }: { text: string, isVisible: boolean, parent?: DOMElementNode }) {
    super(isVisible, parent)
    this.text = text
    this.type = 'TEXT_NODE'
  }

  hasParentWithHighlightIndex(): boolean {
    let current = this.parent
    while (current !== undefined) {
      // stop if the element has a highlight index (will be handled separately)
      if (current.highlightIndex !== undefined) {
        return true
      }

      current = current.parent
    }
    return false
  }

  isParentInViewport(): boolean {
    if (this.parent === undefined) {
      return false
    }
    return this.parent.isInViewport
  }

  isParentTopElement(): boolean {
    if (this.parent === undefined) {
      return false
    }
    return this.parent.isTopElement
  }

  toJSON() {
    return {
      text: this.text,
      type: this.type,
    }
  }
}

/**
 * xpath: the xpath of the element from the last root node (shadow root or iframe OR document if no shadow root or iframe).
 * To properly reference the element we need to recursively switch the root node until we find the element (work you way up the tree with `.parent`)
 */
class DOMElementNode extends DOMBaseNode {
  tagName: string
  xpath: string
  attributes: Record<string, string>
  children: DOMBaseNode[]
  isInteractive: boolean
  isTopElement: boolean
  isInViewport: boolean
  shadowRoot: boolean
  highlightIndex: number | undefined
  viewportCoordinates: CoordinateSet | undefined
  pageCoordinates: CoordinateSet | undefined
  viewportInfo: ViewportInfo | undefined
  isNew: boolean | undefined
  private _hash: HashedDomElement | undefined

  constructor(
    {
      tagName,
      xpath,
      attributes,
      children,
      isVisible,
      isInteractive = false,
      isTopElement = false,
      isInViewport = false,
      shadowRoot = false,
      viewportCoordinates,
      pageCoordinates,
      viewportInfo,
      parent,
      highlightIndex,
    }: {
      tagName: string
      xpath: string
      attributes: Record<string, string>
      children: DOMBaseNode[]
      isVisible: boolean
      isInteractive?: boolean
      isTopElement?: boolean
      isInViewport?: boolean
      shadowRoot?: boolean
      highlightIndex?: number
      viewportCoordinates?: CoordinateSet
      pageCoordinates?: CoordinateSet
      viewportInfo?: ViewportInfo
      parent?: DOMElementNode
    },
  ) {
    super(isVisible, parent)
    this.tagName = tagName
    this.xpath = xpath
    this.attributes = attributes
    this.children = children
    this.isInteractive = isInteractive
    this.isTopElement = isTopElement
    this.isInViewport = isInViewport
    this.shadowRoot = shadowRoot
    this.highlightIndex = highlightIndex
    this.viewportCoordinates = viewportCoordinates
    this.pageCoordinates = pageCoordinates
    this.viewportInfo = viewportInfo
  }

  toJSON(): Record<string, any> {
    return {
      tag_name: this.tagName,
      xpath: this.xpath,
      attributes: this.attributes,
      is_visible: this.isVisible,
      is_interactive: this.isInteractive,
      is_top_element: this.isTopElement,
      is_in_viewport: this.isInViewport,
      shadow_root: this.shadowRoot,
      highlight_index: this.highlightIndex,
      viewport_coordinates: this.viewportCoordinates,
      page_coordinates: this.pageCoordinates,
      children: this.children.map(child => child.toJSON()),
    }
  }

  toString(): string {
    let tagStr = `<${this.tagName}`

    // Add attributes
    for (const [key, value] of Object.entries(this.attributes)) {
      tagStr += ` ${key}="${value}"`
    }
    tagStr += '>'

    // Add extra info
    const extras = []
    if (this.isInteractive) {
      extras.push('interactive')
    }
    if (this.isTopElement) {
      extras.push('top')
    }
    if (this.shadowRoot) {
      extras.push('shadow-root')
    }
    if (this.highlightIndex !== undefined) {
      extras.push(`highlight:${this.highlightIndex}`)
    }
    if (this.isInViewport) {
      extras.push('in-viewport')
    }

    if (extras.length > 0) {
      tagStr += ` [${extras.join(', ')}]`
    }

    return tagStr
  }

  get hash(): HashedDomElement {
    return HistoryTreeProcessor.hashDomElement(this)
  }

  set hash(value: HashedDomElement) {
    this._hash = value
  }

  getAllTextTillNextClickableElement(maxDepth: number = -1): string {
    const textParts: string[] = []

    const collectText = (node: DOMBaseNode, currentDepth: number): void => {
      if (maxDepth !== -1 && currentDepth > maxDepth) {
        return
      }

      // Skip this branch if we hit a highlighted element (except for the current node)
      if (node instanceof DOMElementNode && node !== this && node.highlightIndex !== undefined) {
        return
      }

      if (node instanceof DOMTextNode) {
        textParts.push(node.text)
      } else if (node instanceof DOMElementNode) {
        for (const child of node.children) {
          collectText(child, currentDepth + 1)
        }
      }
    }

    collectText(this, 0)
    return textParts.join('\n').trim()
  }

  @timeExecutionSync('--clickable_elements_to_string')
  clickableElementsToString(includeAttributes?: string[]): string {
    const formattedText: string[] = []

    const processNode = (node: DOMBaseNode, depth: number): void => {
      let nextDepth = depth
      const depthStr = '\t'.repeat(depth)

      if (node instanceof DOMElementNode) {
        // Add element with highlight_index
        if (node.highlightIndex !== undefined) {
          nextDepth += 1

          const text = node.getAllTextTillNextClickableElement()
          let attributesHtmlStr = ''
          if (includeAttributes) {
            const attributesToInclude: Record<string, string> = {}
            for (const key of includeAttributes) {
              if (key in node.attributes) {
                attributesToInclude[key] = String(node.attributes[key])
              }
            }

            // Easy LLM optimizations
            // if tag == role attribute, don't include it
            if (node.tagName === attributesToInclude.role) {
              delete attributesToInclude.role
            }

            // if aria-label == text of the node, don't include it
            if (
              'aria-label' in attributesToInclude
              && attributesToInclude['aria-label'].trim() === text.trim()
            ) {
              delete attributesToInclude['aria-label']
            }

            // if placeholder == text of the node, don't include it
            if (
              'placeholder' in attributesToInclude
              && attributesToInclude.placeholder.trim() === text.trim()
            ) {
              delete attributesToInclude.placeholder
            }

            if (Object.keys(attributesToInclude).length > 0) {
              // Format as key1='value1' key2='value2'
              attributesHtmlStr = Object.entries(attributesToInclude)
                .map(([key, value]) => `${key}='${value}'`)
                .join(' ')
            }
          }

          // Build the line
          let highlightIndicator
          if (node.isNew) {
            highlightIndicator = `*[${node.highlightIndex}]*`
          } else {
            highlightIndicator = `[${node.highlightIndex}]`
          }

          let line = `${depthStr}${highlightIndicator}<${node.tagName}`

          if (attributesHtmlStr) {
            line += ` ${attributesHtmlStr}`
          }

          if (text) {
            // Add space before >text only if there were NO attributes added before
            if (!attributesHtmlStr) {
              line += ' '
            }
            line += `>${text}`
          } else if (!attributesHtmlStr) {
            // Add space before /> only if neither attributes NOR text were added
            line += ' '
          }

          line += ' />' // 1 token
          formattedText.push(line)
        }

        // Process children regardless
        for (const child of node.children) {
          processNode(child, nextDepth)
        }
      } else if (node instanceof DOMTextNode) {
        // Add text only if it doesn't have a highlighted parent
        if (
          !node.hasParentWithHighlightIndex()
          && node.parent
          && node.parent.isVisible
          && node.parent.isTopElement
        ) {
          formattedText.push(`${depthStr}${node.text}`)
        }
      }
    }

    processNode(this, 0)
    return formattedText.join('\n')
  }

  getFileUploadElement(checkSiblings: boolean = true): DOMElementNode | undefined {
    // Check if current element is a file input
    if (this.tagName === 'input' && this.attributes.type === 'file') {
      return this
    }

    // Check children
    for (const child of this.children) {
      if (child instanceof DOMElementNode) {
        const result = child.getFileUploadElement(false)
        if (result) {
          return result
        }
      }
    }

    // Check siblings only for the initial call
    if (checkSiblings && this.parent) {
      for (const sibling of this.parent.children) {
        if (sibling !== this && sibling instanceof DOMElementNode) {
          const result = sibling.getFileUploadElement(false)
          if (result) {
            return result
          }
        }
      }
    }

    return undefined
  }
}

type SelectorMap = Record<number, DOMElementNode>

interface DOMState {
  elementTree: DOMElementNode
  selectorMap: SelectorMap
}

export {
  DOMBaseNode,
  DOMElementNode,
  DOMState,
  DOMTextNode,
  SelectorMap,
}
