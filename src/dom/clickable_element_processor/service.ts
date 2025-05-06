import * as crypto from 'node:crypto'
import { DOMElementNode } from '../views'

export class ClickableElementProcessor {
  /**
   *  Get all clickable elements in the DOM tree
   * @param domElement
   * @returns
   */
  static getClickableElementsHashes(domElement: DOMElementNode): Set<string> {
    const clickableElements = ClickableElementProcessor.getClickableElements(domElement)
    return new Set(clickableElements.map(element => ClickableElementProcessor.hashDomElement(element)))
  }

  /**
   * Get all clickable elements in the DOM tree
   * @param domElement
   * @returns
   */
  static getClickableElements(domElement: DOMElementNode): DOMElementNode[] {
    const clickableElements: DOMElementNode[] = []
    for (const child of domElement.children) {
      if (child instanceof DOMElementNode) {
        if (child.highlightIndex !== undefined) {
          clickableElements.push(child)
        }

        clickableElements.push(...ClickableElementProcessor.getClickableElements(child))
      }
    }

    return clickableElements
  }

  static hashDomElement(domElement: DOMElementNode): string {
    const parentBranchPath = ClickableElementProcessor._getParentBranchPath(domElement)
    const branchPathHash = ClickableElementProcessor._parentBranchPathHash(parentBranchPath)
    const attributesHash = ClickableElementProcessor._attributesHash(domElement.attributes)
    const xpathHash = ClickableElementProcessor._xpathHash(domElement.xpath)
    // const textHash = DomTreeProcessor._textHash(domElement);

    return ClickableElementProcessor._hashString(`${branchPathHash}-${attributesHash}-${xpathHash}`)
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
    return ClickableElementProcessor._hashString(attributesString)
  }

  static _xpathHash(xpath: string): string {
    return ClickableElementProcessor._hashString(xpath)
  }

  static _textHash(domElement: DOMElementNode): string {
    /** */
    const textString = domElement.getAllTextTillNextClickableElement(-1)
    return ClickableElementProcessor._hashString(textString)
  }

  static _hashString(string: string): string {
    return crypto.createHash('sha256').update(string).digest('hex')
  }
}
