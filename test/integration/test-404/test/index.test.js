/* eslint-env jest */
import { join } from 'path'
import fs from 'fs-extra'
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

const appDir = join(__dirname, '../app')
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
    await waitFor(500)
  }
}

function runTests(isExport = false) {
  it('should handle double slashes correctly', async () => {
    const browser = await webdriver(appPort, '//google.com')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe(
      // the static server doesn't handle normalizing the repeated
      // slashes like next start and doesn't get updated on client
      // init since there is no query present
      isExport ? '//google.com' : '/google.com'
    )
  })

  it('should handle double slashes correctly with query', async () => {
    const browser = await webdriver(appPort, '//google.com?h=1')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe('/google.com')
    expect(await browser.eval('window.location.search')).toBe('?h=1')
  })

  it('should handle double slashes correctly with hash', async () => {
    const browser = await webdriver(appPort, '//google.com#hello')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe(
      // the static server doesn't handle normalizing the repeated
      // slashes like next start and doesn't get updated on client
      // init since there is no query present
      isExport ? '//google.com' : '/google.com'
    )
    expect(await browser.eval('window.location.hash')).toBe('#hello')
  })

  it('should handle double slashes correctly with encoded', async () => {
    const browser = await webdriver(appPort, '/%2Fgoogle.com')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe(
      '/%2Fgoogle.com'
    )
  })

  it('should handle double slashes correctly with encoded and query', async () => {
    const browser = await webdriver(appPort, '/%2Fgoogle.com?hello=1')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe(
      '/%2Fgoogle.com'
    )
    expect(await browser.eval('window.location.search')).toBe('?hello=1')
  })

  it('should handle double slashes correctly with encoded and hash', async () => {
    const browser = await webdriver(appPort, '/%2Fgoogle.com#hello')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe(
      '/%2Fgoogle.com'
    )
    expect(await browser.eval('window.location.hash')).toBe('#hello')
  })

  it('should handle slashes in next/link correctly', async () => {
    const browser = await webdriver(appPort, '/')

    for (const item of [
      {
        id: 'page-with-as-slashes',
        page: 'another',
        asPathname: '/google.com',
        asQuery: {},
        asHash: '',
      },
      {
        id: 'href-with-slashes',
        page: 'error',
        asPathname: '/google.com',
        asQuery: {},
        asHash: '',
      },
      {
        id: 'href-with-slashes-query',
        page: 'error',
        asPathname: '/google.com',
        asQuery: { hello: '1' },
        asHash: '',
      },
      {
        id: 'href-with-slashes-hash',
        page: 'error',
        asPathname: '/google.com',
        asQuery: {},
        asHash: '#hello',
      },
    ]) {
      const href = await browser
        .elementByCss(`#${item.id}`)
        .getAttribute('href')

      const parsed = new URL(href)
      expect(parsed.pathname).toBe(item.asPathname)
      expect(parsed.hash).toBe(item.asHash)
      expect(Object.fromEntries(parsed.searchParams)).toEqual(item.asQuery)

      await browser.elementByCss(`#${item.id}`).click()
      await browser.waitForElementByCss(`#${item.page}`)
      await browser.back()
      await browser.waitForElementByCss('#index')
    }
  })

  it('should handle slashes in router push correctly', async () => {
    const browser = await webdriver(appPort, '/')

    for (const item of [
      {
        page: 'another',
        href: '/another',
        as: '//google.com',
        asPathname: '/google.com',
        asQuery: '',
        asHash: '',
      },
      {
        page: 'error',
        href: '//google.com',
        asPathname: '/google.com',
        asQuery: '',
        asHash: '',
      },
      {
        page: 'error',
        href: '//google.com?hello=1',
        asPathname: '/google.com',
        asQuery: '?hello=1',
        asHash: '',
      },
      {
        page: 'error',
        href: '//google.com#hello',
        asPathname: '/google.com',
        asQuery: '',
        asHash: '#hello',
      },
    ]) {
      await browser.eval(`(function() {
        window.next.router.push("${item.href}"${
        item.as ? `, "${item.as}"` : ''
      })
      })()`)

      await browser.waitForElementByCss(`#${item.page}`)
      expect(await browser.eval('window.location.pathname')).toBe(
        item.asPathname
      )
      expect(await browser.eval('window.location.search')).toBe(item.asQuery)
      expect(await browser.eval('window.location.hash')).toBe(item.asHash)

      await browser.back()
      await browser.waitForElementByCss('#index')
    }
  })
}

describe('404 handling', () => {
  let nextOpts = {}
  beforeAll(async () => {
    const hasLocalNext = await fs.exists(join(appDir, 'node_modules/next'))

    if (hasLocalNext) {
      nextOpts = {
        nextBin: join(appDir, 'node_modules/next/dist/bin/next'),
        cwd: appDir,
      }
      console.log('Using next options', nextOpts)
    }
    await nextBuild(appDir, [], nextOpts)
  })

  describe('next start', () => {
    beforeAll(async () => {
      appPort = await findPort()
      app = await nextStart(appDir, appPort, nextOpts)
    })
    afterAll(() => killApp(app))

    runTests()
  })

  describe('next export', () => {
    beforeAll(async () => {
      await nextExport(appDir, { outdir }, nextOpts)
      app = await startStaticServer(outdir, join(outdir, '404.html'))
      appPort = app.address().port
    })
    afterAll(() => {
      stopApp(app)
    })

    runTests(true)
  })
})
