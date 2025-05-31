import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Page } from 'playwright'
import type { ZodType } from 'zod'
import type { ActionDependencies, ActionPayload, RegisteredActionParams } from './registry/view'
import type { Position } from './view'

import { PromptTemplate } from '@langchain/core/prompts'
import TurndownService from 'turndown'
import { z } from 'zod'
import { ActionResult } from '@/agent/views'
import { BrowserSession } from '@/browser/session'
import { Logger } from '@/logger'
import { sleep } from '@/utils'
import { Registry } from './registry/service'

const logger = Logger.getLogger(import.meta.url)

export class Controller<Context = any> {
  registry: Registry<Context>
  constructor(params: { excludeActions?: string[] } = {}) {
    const { excludeActions = [] } = params
    this.registry = new Registry<Context>(excludeActions)

    this.registry.registerAction({
      name: 'done',
      description: 'Complete task - with return text and if the task is finished (success=True) or not yet  completely finished (success=False), because last step is reached',
      paramSchema: z.object({
        success: z.boolean(),
        data: z.any().optional(),
        text: z.string().optional(),
      }),
      execute: (params) => {
        return {
          isDone: true,
          success: params.success,
          extractedContent: params.data ? JSON.stringify(params.data) : params.text,
        }
      },
    })

    this.registry.registerAction({
      name: 'search_google',
      description: 'Search the query in Google in the current tab, the query should be a search query like humans search in Google, concrete and not vague or super long. More the single most important items. ',
      paramSchema: z.object({
        query: z.string(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const searchUrl = `https://www.google.com/search?q=${params.query}&udm=14`
        let page = await browser.getCurrentPage()
        if (['about:blank', 'https://www.google.com'].includes(page.url())) {
          await page.goto(searchUrl)
          await page.waitForLoadState()
        } else {
          page = await browser.createNewTab(searchUrl)
        }

        const msg = `🔍  Searched for "${params.query}" in Google`
        logger.info(msg)
        return {
          includeInMemory: true,
          extractedContent: msg,
        }
      },
    })

    this.registry.registerAction({
      name: 'go_to_url',
      description: 'Navigate to URL in the current tab',
      paramSchema: z.object({
        url: z.string(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        let page = await browser.getCurrentPage()
        if (page) {
          await page.goto(params.url)
          await page.waitForLoadState()
        } else {
          page = await browser.createNewTab(params.url)
        }
        const msg = `🔗  Navigated to ${params.url}`
        logger.info(msg)
        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'go_back',
      description: 'Go back',
      paramSchema: z.object({}),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        await browser.goBack()
        const msg = '🔙  Navigated back'
        logger.info(msg)
        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'wait',
      description: 'Wait for x seconds default 3',
      paramSchema: z.object({
        seconds: z.number().default(3),
      }),
      execute: async ({ seconds }) => {
        const msg = `🕒  Waiting for ${seconds} seconds`
        logger.info(msg)
        await sleep(seconds)
        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'click_element_by_index',
      description: 'Click element by index',
      paramSchema: z.object({
        index: z.number(),
        xpath: z.string().optional(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const selectorMap = await browser.getSelectorMap()

        if (!selectorMap[params.index]) {
          throw new Error(`Element with index ${params.index} does not exist - retry or use alternative actions`)
        }

        const elementNode = await browser.getDomElementByIndex(params.index)
        const initialPages = browser.tabs.length

        // Check if element is a file uploader
        if (await browser.findFileUploadElementByIndex(elementNode)) {
          const msg = `Index ${params.index} - has an element which opens file upload dialog. To upload files please use a specific function to upload files`
          logger.info(msg)
          return {
            extractedContent: msg,
            includeInMemory: true,
          }
        }
        let msg = null

        try {
          const downloadPath = await browser.clickElementNode(elementNode)
          if (downloadPath) {
            msg = `💾  Downloaded file to ${downloadPath}`
          } else {
            msg = `🖱️  Clicked button with index ${params.index}: ${elementNode.getAllTextTillNextClickableElement(2)}`
          }

          logger.info(msg)
          logger.debug(`Element xpath: ${elementNode.xpath}`)

          if (browser.tabs.length > initialPages) {
            const newTabMsg = 'New tab opened - switching to it'
            msg += ` - ${newTabMsg}`
            logger.info(newTabMsg)
            await browser.switchToTab(-1)
          }

          return {
            extractedContent: msg,
            includeInMemory: true,
          }
        } catch (e) {
          logger.warn(`Element not clickable with index ${params.index} - most likely the page changed`)
          return {
            error: e instanceof Error ? e.message : String(e),
          }
        }
      },
    })

    this.registry.registerAction({
      name: 'input_text',
      description: 'Input text into a input interactive element',
      paramSchema: z.object({
        index: z.number(),
        text: z.string(),
        xpath: z.string().optional(),
      }),
      actionDependencies: {
        browser: true,
        hasSensitiveData: true,

      },
      execute: async (params, { browser, hasSensitiveData }) => {
        const selectorMap = await browser.getSelectorMap()

        if (!selectorMap[params.index]) {
          throw new Error(`Element index ${params.index} does not exist - retry or use alternative actions`)
        }

        const elementNode = await browser.getDomElementByIndex(params.index)
        await browser.inputTextElementNode(elementNode, params.text)

        let msg
        if (!hasSensitiveData) {
          msg = `⌨️  Input ${params.text} into index ${params.index}`
        } else {
          msg = `⌨️  Input sensitive data into index ${params.index}`
        }

        logger.info(msg)
        logger.debug(`Element xpath: ${elementNode.xpath}`)

        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'save_pdf',
      description: 'Save the current page as a PDF file',
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const page = await browser.getCurrentPage()
        const shortUrl = page.url().replace(/^https?:\/\/(?:www\.)?|\/$/g, '')
        const slug = shortUrl.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
        const sanitizedFilename = `${slug}.pdf`

        await page.emulateMedia({ media: 'screen' })
        await page.pdf({ path: sanitizedFilename, format: 'A4', printBackground: false })

        const msg = `Saving page with URL ${page.url()} as PDF to ./${sanitizedFilename}`
        logger.info(msg)

        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'switch_tab',
      description: 'Switch tab',
      paramSchema: z.object({
        pageId: z.number(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        await browser.switchToTab(params.pageId)
        // Wait for tab to be ready and ensure references are synchronized
        const page = await browser.getCurrentPage()
        await page.waitForLoadState()

        const msg = `🔄  Switched to tab ${params.pageId}`
        logger.info(msg)

        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'open_tab',
      description: 'Open url in new tab',
      paramSchema: z.object({
        url: z.string(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        await browser.createNewTab(params.url)
        // Ensure tab references are properly synchronized

        const msg = `🔗  Opened new tab with ${params.url}`
        logger.info(msg)

        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'close_tab',
      description: 'Close an existing tab',
      paramSchema: z.object({
        pageId: z.number(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        await browser.switchToTab(params.pageId)
        const page = await browser.getCurrentPage()
        const url = page.url()
        await page.close()

        const msg = `❌  Closed tab #${params.pageId} with url ${url}`
        logger.info(msg)

        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'extract_content',
      description: 'Extract page content to retrieve specific information from the page, e.g. all company names, a specific description, all information about, links with companies in structured format or simply links',
      paramSchema: z.object({
        goal: z.string(),
        shouldStripLinkUrls: z.boolean().optional(),
      }),
      actionDependencies: {
        browser: true,
        pageExtractionLlm: true,

      },
      execute: async (params, { browser, pageExtractionLlm }) => {
        const { goal, shouldStripLinkUrls = false } = params
        const page = await browser.getCurrentPage()

        const turndown = new TurndownService()

        const strip = shouldStripLinkUrls ? ['a', 'img'] : []

        // turndown.remove(strip)
        let content = turndown.turndown(await page.content())

        // Manually append iframe text into the content so it's readable by the LLM (includes cross-origin iframes)
        for (const iframe of page.frames()) {
          if (iframe.url() !== page.url() && !iframe.url().startsWith('data:')) {
            content += `\n\nIFRAME ${iframe.url()}:\n`
            content += turndown.turndown(await iframe.content())
          }
        }

        const prompt = 'Your task is to extract the content of the page. You will be given a page and a goal and you should extract all relevant information around this goal from the page. If the goal is vague, summarize the page. Respond in json format. Extraction goal: {goal}, Page: {page}'
        const template = await PromptTemplate.fromTemplate(prompt)

        try {
          const output = await pageExtractionLlm.invoke(await template.format({ goal, page: content }))
          const msg = `📄  Extracted from page\n: ${output.content}\n`
          logger.info(msg)
          return {
            extractedContent: msg,
            includeInMemory: true,
          }
        } catch (e) {
          logger.debug(`Error extracting content: ${e}`)
          const msg = `📄  Extracted from page\n: ${content}\n`
          logger.info(msg)
          return { extractedContent: msg }
        }
      },
    })

    this.registry.registerAction({
      name: 'scroll_down',
      description: 'Scroll down the page by pixel amount - if no amount is specified, scroll down one page',
      paramSchema: z.object({
        amount: z.number().optional(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        /**
         * Use browser._scroll_container for container-aware scrolling.
         * (b) If that JavaScript throws, fall back to window.scrollBy().
         */
        const page = await browser.getCurrentPage()

        const dy = params.amount ?? await page.evaluate(() => window.innerHeight)

        try {
          await browser.scrollContainer(dy)
        } catch (error) {
          await page.evaluate(y => window.scrollBy(0, y), dy)
          logger.debug('Smart scroll failed; used window.scrollBy fallback')
        }

        const amount = params.amount !== undefined ? `${params.amount} pixels` : 'one page'
        const msg = `🔍 Scrolled down the page by ${amount}`
        logger.info(msg)

        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'scroll_up',
      description: 'Scroll up the page by pixel amount - if no amount is specified, scroll up one page',
      paramSchema: z.object({
        amount: z.number().optional(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const page = await browser.getCurrentPage()

        const dy = -(params.amount ?? await page.evaluate(() => window.innerHeight))

        try {
          await browser.scrollContainer(dy)
        } catch (error) {
          await page.evaluate(y => window.scrollBy(0, y), dy)
          logger.debug('Smart scroll failed; used window.scrollBy fallback')
        }

        const amount = params.amount !== undefined ? `${params.amount} pixels` : 'one page'
        const msg = `🔍 Scrolled up the page by ${amount}`
        logger.info(msg)

        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'send_keys',
      description: 'Send strings of special keys like Escape,Backspace, Insert, PageDown, Delete, Enter, Shortcuts such as `Control+o`, `Control+Shift+T` are supported as well. This gets used in keyboard.press. ',
      paramSchema: z.object({
        keys: z.string(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const page = await browser.getCurrentPage()

        try {
          await page.keyboard.press(params.keys)
        } catch (e: any) {
          if (e.toString().includes('Unknown key')) {
            // loop over the keys and try to send each one
            for (const key of params.keys) {
              try {
                await page.keyboard.press(key)
              } catch (keyError: any) {
                logger.debug(`Error sending key ${key}: ${keyError.toString()}`)
                throw keyError
              }
            }
          } else {
            throw e
          }
        }

        const msg = `⌨️ Sent keys: ${params.keys}`
        logger.info(msg)

        return {
          extractedContent: msg,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'scroll_to_text',
      description: 'If you dont find something which you want to interact with, scroll to it',
      paramSchema: z.object({
        text: z.string(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async ({ text }, { browser }) => {
        const page = await browser.getCurrentPage()

        try {
          // Try different locator strategies
          const locators = [
            page.getByText(text, { exact: false }),
            page.locator(`text=${text}`),
            page.locator(`\/\/*[contains(text(), '${text}')]`),
          ]

          for (const locator of locators) {
            try {
              if (await locator.count() === 0) {
                continue
              }

              const element = locator.first()

              const isVisible = await element.isVisible()
              const box = await element.boundingBox()

              if (isVisible && box && box.width > 0 && box.height > 0) {
                await locator.first().scrollIntoViewIfNeeded()
                await new Promise(resolve => setTimeout(resolve, 500)) // Wait for scroll to complete
                const msg = `🔍 Scrolled to text: ${text}`
                logger.info(msg)
                return {
                  extractedContent: msg,
                  includeInMemory: true,
                }
              }
            } catch (e: any) {
              logger.debug(`Locator attempt failed: ${e.toString()}`)
              continue
            }
          }

          const msg = `Text '${text}' not found or not visible on page`
          logger.info(msg)
          return {
            extractedContent: msg,
            includeInMemory: true,
          }
        } catch (e: any) {
          const msg = `Failed to scroll to text '${text}': ${e.toString()}`
          logger.error(msg)
          return {
            error: msg,
            includeInMemory: true,
          }
        }
      },
    })

    this.registry.registerAction({
      name: 'get_dropdown_options',
      description: 'Get all options from a native dropdown',
      paramSchema: z.object({
        index: z.number(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async ({ index }, { browser }) => {
        const page = await browser.getCurrentPage()
        const selectorMap = await browser.getSelectorMap()
        const domElement = selectorMap[index]

        try {
          // Frame-aware approach since we know it works
          const allOptions = []
          let frameIndex = 0

          for (const frame of page.frames()) {
            try {
              const options = await frame.evaluate((xpath) => {
                const select = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLSelectElement
                if (!select)
                  return null

                return {
                  options: Array.from(select.options).map(opt => ({
                    text: opt.text,
                    value: opt.value,
                    index: opt.index,
                  })),
                  id: select.id,
                  name: select.name,
                }
              }, domElement.xpath)

              if (options) {
                logger.debug(`Found dropdown in frame ${frameIndex}`)
                logger.debug(`Dropdown ID: ${options.id}, Name: ${options.name}`)

                const formattedOptions = []
                for (const opt of options.options) {
                  // encoding ensures AI uses the exact string in select_dropdown_option
                  const encodedText = JSON.stringify(opt.text)
                  formattedOptions.push(`${opt.index}: text=${encodedText}`)
                }

                allOptions.push(...formattedOptions)
              }
            } catch (frameE: any) {
              logger.debug(`Frame ${frameIndex} evaluation failed: ${frameE.toString()}`)
            }

            frameIndex++
          }

          if (allOptions.length > 0) {
            const msg = `${allOptions.join('\n')}\nUse the exact text string in select_dropdown_option`
            logger.info(msg)
            return {
              extractedContent: msg,
              includeInMemory: true,
            }
          } else {
            const msg = 'No options found in any frame for dropdown'
            logger.info(msg)
            return {
              extractedContent: msg,
              includeInMemory: true,
            }
          }
        } catch (e: any) {
          logger.error(`Failed to get dropdown options: ${e.toString()}`)
          const msg = `Error getting options: ${e.toString()}`
          logger.info(msg)
          return {
            extractedContent: msg,
            includeInMemory: true,
          }
        }
      },
    })

    this.registry.registerAction({
      name: 'select_dropdown_option',
      description: 'Select dropdown option for interactive element index by the text of the option you want to select',
      paramSchema: z.object({
        index: z.number(),
        text: z.string(),
      }),
      actionDependencies: {
        browser: true,

      },
      execute: async (params, { browser }) => {
        const { index, text } = params
        const page = await browser.getCurrentPage()
        const selectorMap = await browser.getSelectorMap()
        const domElement = selectorMap[index]

        // Validate that we're working with a select element
        if (domElement.tagName !== 'select') {
          logger.error(`Element is not a select! Tag: ${domElement.tagName}, Attributes: ${JSON.stringify(domElement.attributes)}`)
          const msg = `Cannot select option: Element with index ${index} is a ${domElement.tagName}, not a select`
          return {
            extractedContent: msg,
            includeInMemory: true,
          }
        }

        logger.debug(`Attempting to select '${text}' using xpath: ${domElement.xpath}`)
        logger.debug(`Element attributes: ${JSON.stringify(domElement.attributes)}`)
        logger.debug(`Element tag: ${domElement.tagName}`)
        try {
          let frameIndex = 0
          for (const frame of page.frames()) {
            try {
              logger.debug(`Trying frame ${frameIndex} URL: ${frame.url}`)

              // First verify we can find the dropdown in this frame
              const dropdownInfo = await frame.evaluate((xpath) => {
                try {
                  const select = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLSelectElement
                  if (!select)
                    return null
                  if (select.tagName.toLowerCase() !== 'select') {
                    return {
                      error: `Found element but it's a ${select.tagName}, not a SELECT`,
                      found: false,
                    }
                  }
                  return {
                    id: select.id,
                    name: select.name,
                    found: true,
                    tagName: select.tagName,
                    optionCount: select.options.length,
                    currentValue: select.value,
                    availableOptions: Array.from(select.options).map(o => o.text.trim()),
                  }
                } catch (e: any) {
                  return { error: e.toString(), found: false }
                }
              }, domElement.xpath)

              if (dropdownInfo) {
                if (!dropdownInfo.found) {
                  logger.error(`Frame ${frameIndex} error: ${dropdownInfo.error}`)
                  continue
                }

                logger.debug(`Found dropdown in frame ${frameIndex}: ${JSON.stringify(dropdownInfo)}`)

                const selectedOptionValues = await frame
                  .locator(`//${domElement.xpath}`)
                  .nth(0)
                  .selectOption({ label: text }, { timeout: 1000 })

                const msg = `selected option ${text} with value ${selectedOptionValues}`
                logger.info(`${msg} in frame ${frameIndex}`)

                return {
                  extractedContent: msg,
                  includeInMemory: true,
                }
              }
            } catch (frameE: any) {
              logger.error(`Frame ${frameIndex} attempt failed: ${frameE.toString()}`)
              logger.error(`Frame type: ${typeof frame}`)
              logger.error(`Frame URL: ${frame.url()}`)
            }

            frameIndex++
          }

          const msg = `Could not select option '${text}' in any frame`
          logger.info(msg)
          return {
            extractedContent: msg,
            includeInMemory: true,
          }
        } catch (e: any) {
          const msg = `Selection failed: ${e.toString()}`
          logger.error(msg)
          return {
            error: msg,
            includeInMemory: true,
          }
        }
      },
    })

    this.registry.registerAction({
      name: 'drag_drop',
      description: 'Drag and drop elements or between coordinates on the page - useful for canvas drawing, sortable lists, sliders, file uploads, and UI rearrangement',
      paramSchema: z.object({
        elementSource: z.string().optional().describe('CSS selector or XPath of the element to drag from'),
        elementTarget: z.string().optional().describe('CSS selector or XPath of the element to drop onto'),
        elementSourceOffset: z.object({
          x: z.number(),
          y: z.number(),
        }).optional().describe('Precise position within the source element to start drag (in pixels from top-left corner)'),
        elementTargetOffset: z.object({
          x: z.number(),
          y: z.number(),
        }).optional().describe('Precise position within the target element to drop (in pixels from top-left corner)'),
        coordSourceX: z.number().optional().describe('Absolute X coordinate on page to start drag from (in pixels)'),
        coordSourceY: z.number().optional().describe('Absolute Y coordinate on page to start drag from (in pixels)'),
        coordTargetX: z.number().optional().describe('Absolute X coordinate on page to drop at (in pixels)'),
        coordTargetY: z.number().optional().describe('Absolute Y coordinate on page to drop at (in pixels)'),
        steps: z.number().optional().describe('Number of intermediate points for smoother movement (5-20 recommended)'),
        delayMs: z.number().optional().describe('Delay in milliseconds between steps (0 for fastest, 10-20 for more natural)'),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const page = await browser.getCurrentPage()

        // Get source and target elements with appropriate error handling.
        async function getDragElements(
          page: Page,
          sourceSelector: string,
          targetSelector: string,
        ): Promise<[any | null, any | null]> {
          let sourceElement = null
          let targetElement = null

          try {
            const sourceLocator = page.locator(sourceSelector)
            const targetLocator = page.locator(targetSelector)

            const sourceCount = await sourceLocator.count()
            const targetCount = await targetLocator.count()

            if (sourceCount > 0) {
              sourceElement = await sourceLocator.first().elementHandle()
              logger.debug(`Found source element with selector: ${sourceSelector}`)
            } else {
              logger.warn(`Source element not found: ${sourceSelector}`)
            }

            if (targetCount > 0) {
              targetElement = await targetLocator.first().elementHandle()
              logger.debug(`Found target element with selector: ${targetSelector}`)
            } else {
              logger.warn(`Target element not found: ${targetSelector}`)
            }
          } catch (e: any) {
            logger.error(`Error finding elements: ${e.toString()}`)
          }

          return [sourceElement, targetElement]
        }

        // Get coordinates from elements with appropriate error handling.
        async function getElementCoordinates(
          sourceElement: any,
          targetElement: any,
          sourcePosition?: Position,
          targetPosition?: Position,
        ): Promise<[[number, number] | null, [number, number] | null]> {
          let sourceCoords = null
          let targetCoords = null

          try {
            // Get source coordinates
            if (sourcePosition) {
              sourceCoords = [sourcePosition.x, sourcePosition.y]
            } else {
              const sourceBox = await sourceElement.boundingBox()
              if (sourceBox) {
                sourceCoords = [
                  Math.floor(sourceBox.x + sourceBox.width / 2),
                  Math.floor(sourceBox.y + sourceBox.height / 2),
                ]
              }
            }

            // Get target coordinates
            if (targetPosition) {
              targetCoords = [targetPosition.x, targetPosition.y]
            } else {
              const targetBox = await targetElement.boundingBox()
              if (targetBox) {
                targetCoords = [
                  Math.floor(targetBox.x + targetBox.width / 2),
                  Math.floor(targetBox.y + targetBox.height / 2),
                ]
              }
            }
          } catch (e: any) {
            logger.error(`Error getting element coordinates: ${e.toString()}`)
          }

          return [sourceCoords, targetCoords] as any
        }

        async function executeDragOperation(
          page: Page,
          sourceX: number,
          sourceY: number,
          targetX: number,
          targetY: number,
          steps: number,
          delayMs: number,
        ): Promise<[boolean, string]> {
          try {
            // Try to move to source position
            try {
              await page.mouse.move(sourceX, sourceY)
              logger.debug(`Moved to source position (${sourceX}, ${sourceY})`)
            } catch (e: any) {
              logger.error(`Failed to move to source position: ${e.toString()}`)
              return [false, `Failed to move to source position: ${e.toString()}`]
            }

            // Press mouse button down
            await page.mouse.down()

            // Move to target position with intermediate steps
            for (let i = 1; i <= steps; i++) {
              const ratio = i / steps
              const intermediateX = Math.floor(sourceX + (targetX - sourceX) * ratio)
              const intermediateY = Math.floor(sourceY + (targetY - sourceY) * ratio)

              await page.mouse.move(intermediateX, intermediateY)

              if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs))
              }
            }

            // Move to final target position
            await page.mouse.move(targetX, targetY)

            // Move again to ensure dragover events are properly triggered
            await page.mouse.move(targetX, targetY)

            // Release mouse button
            await page.mouse.up()

            return [true, 'Drag operation completed successfully']
          } catch (e: any) {
            return [false, `Error during drag operation: ${e.toString()}`]
          }
        }

        try {
          // Initialize variables
          let sourceX: number | null = null
          let sourceY: number | null = null
          let targetX: number | null = null
          let targetY: number | null = null

          // Normalize parameters
          const steps = Math.max(1, params.steps || 10)
          const delayMs = Math.max(0, params.delayMs || 5)

          //  Case 1: Element selectors provided
          if (params.elementSource && params.elementTarget) {
            logger.debug('Using element-based approach with selectors')

            const [sourceElement, targetElement] = await getDragElements(
              page,
              params.elementSource,
              params.elementTarget,
            )

            if (!sourceElement || !targetElement) {
              const errorMsg = `Failed to find ${!sourceElement ? 'source' : 'target'} element`
              return {
                error: errorMsg,
                includeInMemory: true,
              }
            }

            const [sourceCoords, targetCoords] = await getElementCoordinates(
              sourceElement,
              targetElement,
              params.elementSourceOffset as Position,
              params.elementTargetOffset as Position,
            )

            if (!sourceCoords || !targetCoords) {
              const errorMsg = `Failed to determine ${!sourceCoords ? 'source' : 'target'} coordinates`
              return {
                error: errorMsg,
                includeInMemory: true,
              }
            }

            [sourceX, sourceY] = sourceCoords;
            [targetX, targetY] = targetCoords
          } else if (
            params.coordSourceX !== undefined
            && params.coordSourceY !== undefined
            && params.coordTargetX !== undefined
            && params.coordTargetY !== undefined
          ) {
            // Coordinates provided directly
            logger.debug('Using coordinate-based approach')
            sourceX = params.coordSourceX
            sourceY = params.coordSourceY
            targetX = params.coordTargetX
            targetY = params.coordTargetY
          } else {
            const errorMsg = 'Must provide either source/target selectors or source/target coordinates'
            return {
              error: errorMsg,
              includeInMemory: true,
            }
          }

          // 验证坐标
          if (sourceX === null || sourceY === null || targetX === null || targetY === null) {
            const errorMsg = 'Failed to determine source or target coordinates'
            return {
              error: errorMsg,
              includeInMemory: true,
            }
          }

          //  Perform the drag operation
          const [success, message] = await executeDragOperation(
            page,
            sourceX,
            sourceY,
            targetX,
            targetY,
            steps,
            delayMs,
          )

          if (!success) {
            logger.error(`Drag operation failed: ${message}`)
            return {
              error: message,
              includeInMemory: true,
            }
          }

          // Create descriptive message
          let msg: string
          if (params.elementSource && params.elementTarget) {
            msg = `🖱️ Dragged element '${params.elementSource}' to '${params.elementTarget}'`
          } else {
            msg = `🖱️ Dragged from (${sourceX}, ${sourceY}) to (${targetX}, ${targetY})`
          }

          logger.info(msg)
          return {
            extractedContent: msg,
            includeInMemory: true,
          }
        } catch (e: any) {
          const errorMsg = `Failed to perform drag and drop: ${e.toString()}`
          logger.error(errorMsg)
          return {
            error: errorMsg,
            includeInMemory: true,

          }
        }
      },
    })

    this.registry.registerAction({
      name: 'get_sheet_contents',
      description: 'Google Sheets: Get the contents of the entire sheet',
      domains: ['sheets.google.com'],
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const page = await browser.getCurrentPage()

        // select all cells
        await page.keyboard.press('Enter')
        await page.keyboard.press('Escape')
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.press('ControlOrMeta+C')

        const extractedTsv = await page.evaluate(() => navigator.clipboard.readText())
        return {
          extractedContent: extractedTsv,
          includeInMemory: true,
        }
      },
    })

    const selectCellOrRange = async (browser: BrowserSession, cellOrRange: string) => {
      const page = await browser.getCurrentPage()

      await page.keyboard.press('Enter') // make sure we dont delete current cell contents if we were last editing
      await page.keyboard.press('Escape') //  to clear current focus (otherwise select range popup is additive)
      await new Promise(resolve => setTimeout(resolve, 100))
      await page.keyboard.press('Home') // move cursor to the top left of the sheet first
      await page.keyboard.press('ArrowUp')
      await new Promise(resolve => setTimeout(resolve, 100))
      await page.keyboard.press('Control+G') //  open the goto range popup
      await new Promise(resolve => setTimeout(resolve, 200))
      await page.keyboard.type(cellOrRange, { delay: 50 })
      await new Promise(resolve => setTimeout(resolve, 200))
      await page.keyboard.press('Enter')
      await new Promise(resolve => setTimeout(resolve, 200))
      await page.keyboard.press('Escape') // to make sure the popup still closes in the case where the jump failed

      return {
        extractedContent: `Selected cell ${cellOrRange}`,
        includeInMemory: false,
      }
    }

    this.registry.registerAction({
      name: 'select_cell_or_range',
      description: 'Google Sheets: Select a specific cell or range of cells',
      domains: ['sheets.google.com'],
      paramSchema: z.object({
        cellOrRange: z.string(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async ({ cellOrRange }, { browser }) => {
        return selectCellOrRange(browser, cellOrRange)
      },
    })

    this.registry.registerAction({
      name: 'get_range_contents',
      description: 'Google Sheets: Get the contents of a specific cell or range of cells',
      domains: ['sheets.google.com'],
      paramSchema: z.object({
        cellOrRange: z.string(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async ({ cellOrRange }, { browser }) => {
        const page = await browser.getCurrentPage()

        await selectCellOrRange(browser, cellOrRange)

        await page.keyboard.press('ControlOrMeta+C')
        await new Promise(resolve => setTimeout(resolve, 100))
        const extractedTsv = await page.evaluate(() => {
          return navigator.clipboard.readText()
        })

        return {
          extractedContent: extractedTsv,
          includeInMemory: true,
        }
      },
    })

    this.registry.registerAction({
      name: 'clear_selected_range',
      description: 'Google Sheets: Clear the currently selected cells',
      domains: ['sheets.google.com'],
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const page = await browser.getCurrentPage()

        await page.keyboard.press('Backspace')

        return {
          extractedContent: 'Cleared selected range',
          includeInMemory: false,
        }
      },
    })

    this.registry.registerAction({
      name: 'input_selected_cell_text',
      description: 'Google Sheets: Input text into the currently selected cell',
      domains: ['sheets.google.com'],
      actionDependencies: {
        browser: true,
      },
      paramSchema: z.object({
        text: z.string(),
      }),
      execute: async ({ text }, { browser }) => {
        const page = await browser.getCurrentPage()

        await page.keyboard.type(text, { delay: 100 })
        await page.keyboard.press('Enter') // make sure to commit the input so it doesn't get overwritten by the next action
        await page.keyboard.press('ArrowUp')

        return {
          extractedContent: `Inputted text ${text}`,
          includeInMemory: false,
        }
      },
    })

    this.registry.registerAction({
      name: 'update_range_contents',
      description: 'Google Sheets: Batch update a range of cells',
      domains: ['sheets.google.com'],
      paramSchema: z.object({
        range: z.string(),
        newContentsTsv: z.string(),
      }),
      actionDependencies: {
        browser: true,
      },
      execute: async (params, { browser }) => {
        const { range, newContentsTsv } = params
        const page = await browser.getCurrentPage()

        await selectCellOrRange(browser, range)

        // simulate paste event from clipboard with TSV content
        await page.evaluate((newContentsTsv) => {
          const clipboardData = new DataTransfer()
          clipboardData.setData('text/plain', `${newContentsTsv}`)
          document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData }))
        }, newContentsTsv)

        return {
          extractedContent: `Updated cell ${range} with ${newContentsTsv}`,
          includeInMemory: false,
        }
      },
    })
  }

  /**
   * registering custom actions
   * @param params
   */
  registerAction<T extends ZodType, C extends ActionDependencies>(
    params: RegisteredActionParams<T, C>,
  ) {
    this.registry.registerAction(params)
  }

  async act(
    {
      action,
      browserContext,
      pageExtractionLlm,
      sensitiveData,
      availableFilePaths,
      context,
    }: {
      action: ActionPayload
      browserContext: BrowserSession
      pageExtractionLlm?: BaseChatModel
      sensitiveData?: Record<string, string>
      availableFilePaths?: string[]
      context?: Context
    },
  ): Promise<ActionResult> {
    for (const [actionName, params] of Object.entries(action)) {
      if (params != null && params !== undefined) {
        const result = await this.registry.executeAction(
          {
            actionName,
            params,
            browser: browserContext,
            pageExtractionLlm,
            sensitiveData,
            availableFilePaths,
            context,
          },
        )

        if (typeof result === 'string') {
          return new ActionResult({
            extractedContent: result,
          })
        } else if (result && typeof result === 'object') {
          return new ActionResult(result)
        } else if (result === undefined || result === null) {
          return new ActionResult()
        } else {
          throw new Error(`Invalid action result type: ${typeof result} of ${result}`)
        }
      }
    }

    return new ActionResult()
  }
}
