/* eslint-env jest */
import { join } from 'path'
import webdriver from 'next-webdriver'
import {
  nextBuild,
  findPort,
  nextStart,
  killApp,
  waitFor,
  nextExport,
  stopApp,
  startStaticServer,
} from 'next-test-utils'

jest.setTimeout(60 * 1000)

const appDir = join(__dirname, '../')
const outdir = join(appDir, 'out')
let appPort
let app

const didNotReload = async (browser) => {
  for (let i = 0; i < 5; i++) {
    const result = await browser.eval('window.errorLoad')

    if (result !== true) {
      throw new Error(
        `did not find window.errorLoad, current url: ${await browser.url()}`
      )
    }
    await waitFor(750)
  }
}

function runTests() {
  it('should handle double slashes correctly', async () => {
    const browser = await webdriver(appPort, '//google.com')
    await didNotReload(browser)
  })

  it('should handle double slashes correctly with query', async () => {
    const browser = await webdriver(appPort, '//google.com?h=1')
    await didNotReload(browser)
  })

  it('should handle double slashes correctly with hash', async () => {
    const browser = await webdriver(appPort, '//google.com#hello')
    await didNotReload(browser)
  })

  it('should handle double slashes correctly with encoded', async () => {
    const browser = await webdriver(appPort, '/%2Fgoogle.com')
    await didNotReload(browser)
  })

  it('should handle double slashes correctly with encoded and query', async () => {
    const browser = await webdriver(appPort, '/%2Fgoogle.com?hello=1')
    await didNotReload(browser)
  })

  it('should handle double slashes correctly with encoded and hash', async () => {
    const browser = await webdriver(appPort, '/%2Fgoogle.com#hello')
    await didNotReload(browser)
  })

  // it('should handle slashes on router push with valid page', async () => {
  //   const browser = await webdriver(appPort, '/')

  //   await browser.eval(`(function() {
  //     window.beforeNav = true
  //     window.next.router.push('/', '//google.com')
  //   })()`)

  //   await browser.waitForElementByCss('#another')
  //   expect(await browser.eval('window.beforeNav')).toBe(true)
  //   expect(await browser.eval('window.location.pathname')).toBe('/google.com')
  // })
}

describe('404 handling', () => {
  beforeAll(async () => {
    await nextBuild(appDir)
  })

  describe('next start', () => {
    beforeAll(async () => {
      appPort = await findPort()
      app = await nextStart(appDir, appPort)
    })
    afterAll(() => killApp(app))

    runTests()
  })

  describe('next export', () => {
    beforeAll(async () => {
      await nextExport(appDir, { outdir })
      app = await startStaticServer(outdir, join(outdir, '404.html'))
      appPort = app.address().port
    })
    afterAll(() => stopApp(app))

    runTests()
  })
})
