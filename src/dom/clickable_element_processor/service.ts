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
        if (child.highlightIndex) {
          clickableElements.push(child)
        }

        clickableElements.push(...ClickableElementProcessor.getClickableElements(child))
      }
    }

    return clickableElements
  }

  static hashDomElement(domElement: DOMElementNode): string {
    const parentBranchPath = ClickableElementProcessor.getParentBranchPath(domElement)
    const branchPathHash = ClickableElementProcessor.parentBranchPathHash(parentBranchPath)
    const attributesHash = ClickableElementProcessor.attributesHash(domElement.attributes)
    const xpathHash = ClickableElementProcessor.xpathHash(domElement.xpath)
    // const textHash = DomTreeProcessor._textHash(domElement);

    return ClickableElementProcessor.hashString(`${branchPathHash}-${attributesHash}-${xpathHash}`)
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
    return ClickableElementProcessor.hashString(attributesString)
  }

  private static xpathHash(xpath: string): string {
    return ClickableElementProcessor.hashString(xpath)
  }

  private static textHash(domElement: DOMElementNode): string {
    /** */
    const textString = domElement.getAllTextTillNextClickableElement(-1)
    return ClickableElementProcessor.hashString(textString)
  }

  private static hashString(string: string): string {
    return crypto.createHash('sha256').update(string).digest('hex')
  }
}
