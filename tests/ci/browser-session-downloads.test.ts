/** Test to verify download detection timing issue */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserProfile } from '@/browser/profile'
import { BrowserSession } from '@/browser/session'

// Test HTTP server setup
class TestServer {
  private server: http.Server | null = null
  private port = 3000
  private baseUrl = `http://localhost:${this.port}`

  urlFor(path: string): string {
    return `${this.baseUrl}${path}`
  }

  async close(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null
          resolve()
        })
      })
    }
  }
}

async function setupTestServer(): Promise<TestServer> {
  /** Setup test HTTP server with a simple page. */
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Test Page</title>
    </head>
    <body>
        <h1>Test Page</h1>
        <button id="test-button" onclick="document.getElementById('result').innerText = 'Clicked!'">
            Click Me
        </button>
        <p id="result"></p>
        <a href="/download/test.pdf" download>Download PDF</a>
    </body>
    </html>
    `

  const pdfContent = Buffer.from('PDF content')

  const testServer = new TestServer()

  const server = http.createServer((req, res) => {
    const url = req.url || ''

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (url === '/' || url === '') {
      // Respond with HTML content
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(htmlContent)
    } else if (url === '/download/test.pdf') {
      // Respond with PDF content
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="test.pdf"',
        'Content-Length': pdfContent.length.toString(),
      })
      res.end(pdfContent)
    } else {
      // 404 for other requests
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  })

  // Start the server
  return new Promise((resolve, reject) => {
    server.listen(3000, 'localhost', () => {
      console.log('Test server started on http://localhost:3000')
      // testServer.server = server
      resolve(testServer)
    })

    server.on('error', (err) => {
      reject(err)
    })
  })
}

describe('download Detection Tests', () => {
  let testServer: TestServer
  let tmpPath: string

  beforeEach(async () => {
    testServer = await setupTestServer()
    tmpPath = join(tmpdir(), `test_${Date.now()}`)
    mkdirSync(tmpPath, { recursive: true })
  })

  it('download detection timing', async () => {
    /** Test that download detection adds 5 second delay to clicks when downloads_dir is set. */

    // Test 1: With downloads_dir set (default behavior)
    const browserWithDownloads = new BrowserSession({
      browserProfile: new BrowserProfile({
        headless: true,
        downloadsDir: join(tmpPath, 'downloads'),

      }),
    })

    await browserWithDownloads.start()
    let page = await browserWithDownloads.getCurrentPage()
    await page.goto(testServer.urlFor('/'))

    // Get the actual DOM state to find the button
    let state = await browserWithDownloads.getStateSummary(false)

    // Find the button element
    let buttonNode = null
    for (const elem of Object.values(state.selectorMap)) {
      if (elem.tagName === 'button' && elem.attributes.id === 'test-button') {
        buttonNode = elem
        break
      }
    }

    expect(buttonNode).not.toBeNull() // Could not find button element

    // Time the click
    const startTime = Date.now()
    const result = await browserWithDownloads.clickElementNode(buttonNode!)
    const durationWithDownloads = (Date.now() - startTime) / 1000

    // Verify click worked
    const resultText = await page.locator('#result').textContent()
    expect(resultText).toBe('Clicked!')
    expect(result).toBeUndefined() // No download happened

    await browserWithDownloads.close()

    // Test 2: With downloads_dir set to empty string (disables download detection)
    const browserNoDownloads = new BrowserSession({
      browserProfile: new BrowserProfile({
        headless: true,

      }),
    })

    await browserNoDownloads.start()
    page = await browserNoDownloads.getCurrentPage()
    await page.goto(testServer.urlFor('/'))

    // Clear previous result
    await page.evaluate('document.getElementById("result").innerText = ""')

    // Get the DOM state again for the new browser session
    state = await browserNoDownloads.getStateSummary(false)

    // Find the button element again
    buttonNode = null
    for (const elem of Object.values(state.selectorMap)) {
      if (elem.tagName === 'button' && elem.attributes.id === 'test-button') {
        buttonNode = elem
        break
      }
    }

    expect(buttonNode).not.toBeUndefined() // Could not find button element

    // Time the click
    const startTime2 = Date.now()
    const result2 = await browserNoDownloads.clickElementNode(buttonNode!)
    const durationNoDownloads = (Date.now() - startTime2) / 1000

    // Verify click worked
    const resultText2 = await page.locator('#result').textContent()
    expect(resultText2).toBe('Clicked!')

    await browserNoDownloads.close()

    // Check timing differences
    console.log(`Click with downloads_dir: ${durationWithDownloads.toFixed(2)}s`)
    console.log(`Click without downloads_dir: ${durationNoDownloads.toFixed(2)}s`)
    console.log(`Difference: ${(durationWithDownloads - durationNoDownloads).toFixed(2)}s`)

    // Both should be fast now since we're clicking a button (not a download link)
    expect(durationWithDownloads).toBeLessThan(8) // Expected <8s with downloads_dir
    expect(durationNoDownloads).toBeLessThan(3) // Expected <3s without downloads_dir
  })

  it('actual download detection', async () => {
    /** Test that actual downloads are detected correctly. */

    const downloadsDir = join(tmpPath, 'downloads')
    mkdirSync(downloadsDir, { recursive: true })

    const browserSession = new BrowserSession({
      browserProfile: new BrowserProfile({
        headless: true,
        downloadsDir,

      }),
    })

    await browserSession.start()
    const page = await browserSession.getCurrentPage()
    await page.goto(testServer.urlFor('/'))

    // Get the DOM state to find the download link
    const state = await browserSession.getStateSummary(false)

    // Find the download link element
    let downloadNode = null
    for (const elem of Object.values(state.selectorMap)) {
      if (elem.tagName === 'a' && 'download' in elem.attributes) {
        downloadNode = elem
        break
      }
    }

    expect(downloadNode).not.toBeNull() // Could not find download link element

    // Click the download link
    const startTime = Date.now()
    const downloadPath = await browserSession.clickElementNode(downloadNode!)
    const duration = (Date.now() - startTime) / 1000

    // Should return the download path
    expect(downloadPath).not.toBeUndefined()
    expect(downloadPath).toContain('test.pdf')
    expect(existsSync(downloadPath!)).toBe(true)

    // Should be relatively fast since download is detected
    expect(duration).toBeLessThan(2.0) // Download detection took too long, expected <2s

    await browserSession.close()
  })
})
