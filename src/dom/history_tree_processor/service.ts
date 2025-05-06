import * as crypto from 'node:crypto'
import { DOMElementNode } from '../views'
import { DOMHistoryElement, HashedDomElement } from './view'

export class HistoryTreeProcessor {
  /**
   * Operations on the DOM elements
   *
   * @dev be careful - text nodes can change even if elements stay the same
   */

  static convertDomElementToHistoryElement(domElement: DOMElementNode): DOMHistoryElement {
    const parentBranchPath = HistoryTreeProcessor._getParentBranchPath(domElement)

    // TODO: import BrowserContext
    const cssSelector = BrowserContext._enhancedCssSelectorForElement(domElement)

    return new DOMHistoryElement({
      tagName: domElement.tagName,
      xpath: domElement.xpath,
      highlightIndex: domElement.highlightIndex,
      entireParentBranchPath: parentBranchPath,
      attributes: domElement.attributes,
      shadowRoot: domElement.shadowRoot,
      cssSelector,
      pageCoordinates: domElement.pageCoordinates,
      viewportCoordinates: domElement.viewportCoordinates,
      viewportInfo: domElement.viewportInfo,
    },
    )
  }

  static findHistoryElementInTree(domHistoryElement: DOMHistoryElement, tree: DOMElementNode): DOMElementNode | undefined {
    const hashedDomHistoryElement = HistoryTreeProcessor._hashDomHistoryElement(domHistoryElement)

    function processNode(node: DOMElementNode): DOMElementNode | undefined {
      if (node.highlightIndex !== undefined) {
        const hashedNode = HistoryTreeProcessor._hashDomElement(node)
        if (HistoryTreeProcessor._compareHashedElements(hashedNode, hashedDomHistoryElement)) {
          return node
        }
      }

      for (const child of node.children) {
        if (child instanceof DOMElementNode) {
          const result = processNode(child)
          if (result !== undefined) {
            return result
          }
        }
      }

      return undefined
    }

    return processNode(tree)
  }

  static compareHistoryElementAndDomElement(domHistoryElement: DOMHistoryElement, domElement: DOMElementNode): boolean {
    const hashedDomHistoryElement = HistoryTreeProcessor._hashDomHistoryElement(domHistoryElement)
    const hashedDomElement = HistoryTreeProcessor._hashDomElement(domElement)

    return HistoryTreeProcessor._compareHashedElements(hashedDomHistoryElement, hashedDomElement)
  }

  static _hashDomHistoryElement(domHistoryElement: DOMHistoryElement): HashedDomElement {
    const branchPathHash = HistoryTreeProcessor._parentBranchPathHash(domHistoryElement.entireParentBranchPath)
    const attributesHash = HistoryTreeProcessor._attributesHash(domHistoryElement.attributes)
    const xpathHash = HistoryTreeProcessor._xpathHash(domHistoryElement.xpath)

    return new HashedDomElement(branchPathHash, attributesHash, xpathHash)
  }

  static _hashDomElement(domElement: DOMElementNode): HashedDomElement {
    const parentBranchPath = HistoryTreeProcessor._getParentBranchPath(domElement)
    const branchPathHash = HistoryTreeProcessor._parentBranchPathHash(parentBranchPath)
    const attributesHash = HistoryTreeProcessor._attributesHash(domElement.attributes)
    const xpathHash = HistoryTreeProcessor._xpathHash(domElement.xpath)
    // const textHash = HistoryTreeProcessor._textHash(domElement);

    return new HashedDomElement(branchPathHash, attributesHash, xpathHash)
  }

  static _getParentBranchPath(domElement: DOMElementNode): string[] {
    const parents: DOMElementNode[] = []
    let currentElement: DOMElementNode = domElement

    while (currentElement.parent !== undefined) {
      parents.push(currentElement)
      currentElement = currentElement.parent
    }

    parents.reverse()

    return parents.map(parent => parent.tagName)
  }

  static _parentBranchPathHash(parentBranchPath: string[]): string {
    const parentBranchPathString = parentBranchPath.join('/')
    return crypto.createHash('sha256').update(parentBranchPathString).digest('hex')
  }

  static _attributesHash(attributes: Record<string, string>): string {
    const attributesString = Object.entries(attributes)
      .map(([key, value]) => `${key}=${value}`)
      .join('')
    return crypto.createHash('sha256').update(attributesString).digest('hex')
  }

  static _xpathHash(xpath: string): string {
    return crypto.createHash('sha256').update(xpath).digest('hex')
  }

  static _textHash(domElement: DOMElementNode): string {
    const textString = domElement.getAllTextTillNextClickableElement(-1)
    return crypto.createHash('sha256').update(textString).digest('hex')
  }

  static _compareHashedElements(a: HashedDomElement, b: HashedDomElement): boolean {
    return (
      a.branchPathHash === b.branchPathHash
      && a.attributesHash === b.attributesHash
      && a.xpathHash === b.xpathHash
    )
  }
}

// Placeholder for external dependency
// In actual implementation, this should be imported from the correct module
class BrowserContext {
  static _enhancedCssSelectorForElement(domElement: DOMElementNode): string {
    // This is a placeholder, actual implementation would come from the imported module
    return ''
  }
}
