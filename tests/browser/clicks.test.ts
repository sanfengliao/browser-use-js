import type { DOMBaseNode } from '@/dom/views'
import * as fs from 'node:fs'
import { createInterface } from 'node:readline'
import { Browser, BrowserConfig } from '@/browser/browser'
import { DOMElementNode, DOMTextNode } from '@/dom/views'

import { it } from 'vitest'

class ElementTreeSerializer {
  static domElementNodeToJson(elementTree: DOMElementNode): Record<string, any> {
    function nodeToDict(node: DOMBaseNode): Record<string, any> {
      if (node instanceof DOMTextNode) {
        return { type: 'text', text: node.text }
      }
      else if (node instanceof DOMElementNode) {
        return {
          type: 'element',
          tagName: node.tagName,
          attributes: node.attributes,
          highlightIndex: node.highlightIndex,
          children: node.children.map(child => nodeToDict(child)),
        }
      }
      return {}
    }

    return nodeToDict(elementTree)
  }
}

function createReadlineInterface() {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  })
}

// Note: This is more of an interactive test and may need to be manually run
it('highlight elements', { timeout: 0 }, async () => {
  const browser = new Browser(
    new BrowserConfig({ headless: false, disableSecurity: true }),
  )

  const context = await browser.newContext()

  try {
    const page = await context.getCurrentPage()
    await page.goto('https://huggingface.co/')

    await new Promise(resolve => setTimeout(resolve, 1000))

    // while (true) {
    try {
      const state = await context.getState(true)

      // 检查目录是否存在，不存在则递归创建
      if (!fs.existsSync('./tmp')) {
        await fs.mkdirSync('./tmp', { recursive: true }) // recursive: true 是关键！
      }

      await fs.writeFileSync(
        './tmp/page.json',
        JSON.stringify(
          ElementTreeSerializer.domElementNodeToJson(state.elementTree),
          null,
          1,
        ),
        {
          // mode: 'w',
          flag: 'w',
        },
      )

      // Find and print duplicate XPaths
      const xpathCounts: Record<string, number> = {}

      if (!state.selectorMap) {
        return
      }

      for (const selector of Object.values(state.selectorMap)) {
        const xpath = selector.xpath
        xpathCounts[xpath] = (xpathCounts[xpath] || 0) + 1
      }

      console.log('\nDuplicate XPaths found:')
      for (const [xpath, count] of Object.entries(xpathCounts)) {
        if (count > 1) {
          console.log(`XPath: ${xpath}`)
          console.log(`Count: ${count}\n`)
        }
      }

      console.log(Object.keys(state.selectorMap), 'Selector map keys')
      console.log(state.elementTree.clickableElementsToString())

      const action = '12'
      await context.removeHighlights()

      const nodeElement = state.selectorMap.get(Number.parseInt(action))
      await context.clickElementNode(nodeElement!)
    }
    catch (e) {
      console.log(e)
    }
    // }
  }
  finally {
    // This part won't typically be reached in an interactive loop,
    // but keeping it for proper cleanup if the loop is broken
    await browser.close()
  }
}) // Disable timeout for interactive test
