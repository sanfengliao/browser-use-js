import * as crypto from 'node:crypto'
import { BrowserContext } from '@/browser/context'
import { DOMElementNode } from '../views'
import { DOMHistoryElement, HashedDomElement } from './view'

export class HistoryTreeProcessor {
  /**
   * Operations on the DOM elements
   *
   * @dev be careful - text nodes can change even if elements stay the same
   */

  static convertDomElementToHistoryElement(domElement: DOMElementNode): DOMHistoryElement {
    const parentBranchPath = HistoryTreeProcessor.getParentBranchPath(domElement)

    const cssSelector = BrowserContext.enhancedCssSelectorForElement(domElement)

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
    const hashedDomHistoryElement = HistoryTreeProcessor.hashDomHistoryElement(domHistoryElement)

    function processNode(node: DOMElementNode): DOMElementNode | undefined {
      if (node.highlightIndex !== undefined) {
        const hashedNode = HistoryTreeProcessor.hashDomElement(node)
        if (HistoryTreeProcessor.compareHashedElements(hashedNode, hashedDomHistoryElement)) {
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
    const hashedDomHistoryElement = HistoryTreeProcessor.hashDomHistoryElement(domHistoryElement)
    const hashedDomElement = HistoryTreeProcessor.hashDomElement(domElement)

    return HistoryTreeProcessor.compareHashedElements(hashedDomHistoryElement, hashedDomElement)
  }

  private static hashDomHistoryElement(domHistoryElement: DOMHistoryElement): HashedDomElement {
    const branchPathHash = HistoryTreeProcessor.parentBranchPathHash(domHistoryElement.entireParentBranchPath)
    const attributesHash = HistoryTreeProcessor.attributesHash(domHistoryElement.attributes)
    const xpathHash = HistoryTreeProcessor.xpathHash(domHistoryElement.xpath)

    return new HashedDomElement(branchPathHash, attributesHash, xpathHash)
  }

  static hashDomElement(domElement: DOMElementNode): HashedDomElement {
    const parentBranchPath = HistoryTreeProcessor.getParentBranchPath(domElement)
    const branchPathHash = HistoryTreeProcessor.parentBranchPathHash(parentBranchPath)
    const attributesHash = HistoryTreeProcessor.attributesHash(domElement.attributes)
    const xpathHash = HistoryTreeProcessor.xpathHash(domElement.xpath)
    // const textHash = HistoryTreeProcessor._textHash(domElement);

    return new HashedDomElement(branchPathHash, attributesHash, xpathHash)
  }

  private static getParentBranchPath(domElement: DOMElementNode): string[] {
    const parents: DOMElementNode[] = []
    let currentElement: DOMElementNode = domElement

    while (currentElement.parent !== undefined) {
      parents.push(currentElement)
      currentElement = currentElement.parent
    }

    parents.reverse()

    return parents.map(parent => parent.tagName)
  }

  private static parentBranchPathHash(parentBranchPath: string[]): string {
    const parentBranchPathString = parentBranchPath.join('/')
    return crypto.createHash('sha256').update(parentBranchPathString).digest('hex')
  }

  private static attributesHash(attributes: Record<string, string>): string {
    const attributesString = Object.entries(attributes)
      .map(([key, value]) => `${key}=${value}`)
      .join('')
    return crypto.createHash('sha256').update(attributesString).digest('hex')
  }

  private static xpathHash(xpath: string): string {
    return crypto.createHash('sha256').update(xpath).digest('hex')
  }

  private static textHash(domElement: DOMElementNode): string {
    const textString = domElement.getAllTextTillNextClickableElement(-1)
    return crypto.createHash('sha256').update(textString).digest('hex')
  }

  private static compareHashedElements(a: HashedDomElement, b: HashedDomElement): boolean {
    return (
      a.branchPathHash === b.branchPathHash
      && a.attributesHash === b.attributesHash
      && a.xpathHash === b.xpathHash
    )
  }
}
