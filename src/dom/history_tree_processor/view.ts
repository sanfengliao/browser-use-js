/**
 * Hash of the dom element to be used as a unique identifier
 */
interface HashedDomElement {
  branchPathHash: string
  attributesHash: string
  xpathHash: string
}

interface Coordinates {
  x: number
  y: number
}

interface CoordinateSet {
  topLeft: Coordinates
  topRight: Coordinates
  bottomLeft: Coordinates
  bottomRight: Coordinates
  center: Coordinates
  width: number
  height: number
}

interface ViewportInfo {
  scrollX?: number
  scrollY?: number
  width: number
  height: number
}

class DOMHistoryElement {
  tagName: string
  xpath: string
  highlightIndex: number | undefined
  entireParentBranchPath: string[]
  attributes: Record<string, string>
  shadowRoot: boolean
  cssSelector: string | undefined
  pageCoordinates: CoordinateSet | undefined
  viewportCoordinates: CoordinateSet | undefined
  viewportInfo: ViewportInfo | undefined

  constructor(
    {
      tagName,
      xpath,
      highlightIndex,
      entireParentBranchPath,
      attributes,
      shadowRoot = false,
      cssSelector = undefined,
      pageCoordinates = undefined,
      viewportCoordinates = undefined,
      viewportInfo = undefined,
    }: {
      tagName: string
      xpath: string
      highlightIndex: number | undefined
      entireParentBranchPath: string[]
      attributes: Record<string, string>
      shadowRoot: boolean
      cssSelector: string | undefined
      pageCoordinates: CoordinateSet | undefined
      viewportCoordinates: CoordinateSet | undefined
      viewportInfo: ViewportInfo | undefined
    },
  ) {
    this.tagName = tagName
    this.xpath = xpath
    this.highlightIndex = highlightIndex
    this.entireParentBranchPath = entireParentBranchPath
    this.attributes = attributes
    this.shadowRoot = shadowRoot
    this.cssSelector = cssSelector
    this.pageCoordinates = pageCoordinates
    this.viewportCoordinates = viewportCoordinates
    this.viewportInfo = viewportInfo
  }

  toJSON() {
    const pageCoordinates = this.pageCoordinates ? { ...this.pageCoordinates } : undefined
    const viewportCoordinates = this.viewportCoordinates ? { ...this.viewportCoordinates } : undefined
    const viewportInfo = this.viewportInfo ? { ...this.viewportInfo } : undefined

    return {
      tagName: this.tagName,
      xpath: this.xpath,
      highlightIndex: this.highlightIndex,
      entireParentBranchPath: this.entireParentBranchPath,
      attributes: this.attributes,
      shadowRoot: this.shadowRoot,
      cssSelector: this.cssSelector,
      pageCoordinates,
      viewportCoordinates,
      viewportInfo,
    }
  }
}

export {
  Coordinates,
  CoordinateSet,
  DOMHistoryElement,
  HashedDomElement,
  ViewportInfo,
}
