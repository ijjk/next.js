/* eslint-env jest */
import { join } from 'path'
import fs from 'fs-extra'
import webdriver from 'next-webdriver'
import escapeRegex from 'escape-string-regexp'
import {
  nextBuild,
  findPort,
  nextStart,
  killApp,
  waitFor,
  nextExport,
  stopApp,
  startStaticServer,
  launchApp,
  fetchViaHTTP,
  check,
} from 'next-test-utils'

jest.setTimeout(60 * 1000)

const appDir = join(__dirname, '../app')
const outdir = join(appDir, 'out')
let appPort
let app

function runTests({ isDev = false, isExport = false, isPages404 = false }) {
  let notFoundContent = 'custom error'
  let badRequestContent = 'custom error'

  if (isPages404) {
    badRequestContent = 'Bad Request'
    notFoundContent = 'custom 404'
  }
  if (isExport && isPages404) {
    notFoundContent = 'custom 404'
    badRequestContent = 'custom 404'
  }

  const didNotReload = async (browser) => {
    for (let i = 0; i < 4; i++) {
      await waitFor(500)

      if (isPages404) {
        // when testing with the default _error.tsx we can't
        // check for an initialized window value so we ensure
        // the URL is still correct instead
        const result = await browser.eval('window.location.href')

        if (result !== browser.initUrl) {
          throw new Error(
            `unexpected navigation occurred, current url: ${result}, expected ${browser.initUrl}`
          )
        }
      } else {
        const result = await browser.eval('window.errorLoad')

        if (result !== true) {
          throw new Error(
            `did not find window.errorLoad, current url: ${await browser.url()}`
          )
        }
      }

      if (isDev) break
    }
  }

  it('should handle double slashes correctly', async () => {
    if (!isExport) {
      const res = await fetchViaHTTP(appPort, '//google.com', undefined, {
        redirect: 'manual',
      })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain(badRequestContent)
    }

    const browser = await webdriver(appPort, '//google.com')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe('//google.com')
    expect(await browser.eval('document.documentElement.innerHTML')).toContain(
      badRequestContent
    )
  })

  it('should handle double slashes correctly with query', async () => {
    if (!isExport) {
      const res = await fetchViaHTTP(
        appPort,
        '//google.com',
        { h: '1' },
        {
          redirect: 'manual',
        }
      )
      expect(res.status).toBe(400)
      expect(await res.text()).toContain(badRequestContent)
    }

    const browser = await webdriver(appPort, '//google.com?h=1')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe('//google.com')
    expect(await browser.eval('window.location.search')).toBe('?h=1')
    expect(await browser.eval('document.documentElement.innerHTML')).toContain(
      badRequestContent
    )
  })

  it('should handle double slashes correctly with hash', async () => {
    if (!isExport) {
      const res = await fetchViaHTTP(appPort, '//google.com', undefined, {
        redirect: 'manual',
      })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain(badRequestContent)
    }

    const browser = await webdriver(appPort, '//google.com#hello')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe('//google.com')
    expect(await browser.eval('window.location.hash')).toBe('#hello')
    expect(await browser.eval('document.documentElement.innerHTML')).toContain(
      badRequestContent
    )
  })

  it('should handle double slashes correctly with encoded', async () => {
    if (!isExport) {
      const res = await fetchViaHTTP(appPort, '/%2Fgoogle.com', undefined, {
        redirect: 'manual',
      })
      expect(res.status).toBe(404)
      expect(await res.text()).toContain(notFoundContent)
    }

    const browser = await webdriver(appPort, '/%2Fgoogle.com')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe(
      '/%2Fgoogle.com'
    )
    expect(await browser.eval('document.documentElement.innerHTML')).toContain(
      notFoundContent
    )
  })

  it('should handle double slashes correctly with encoded and query', async () => {
    if (!isExport) {
      const res = await fetchViaHTTP(
        appPort,
        '/%2Fgoogle.com',
        { hello: '1' },
        {
          redirect: 'manual',
        }
      )
      expect(res.status).toBe(404)
      expect(await res.text()).toContain(notFoundContent)
    }

    const browser = await webdriver(appPort, '/%2Fgoogle.com?hello=1')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe(
      '/%2Fgoogle.com'
    )
    expect(await browser.eval('window.location.search')).toBe('?hello=1')
    expect(await browser.eval('document.documentElement.innerHTML')).toContain(
      notFoundContent
    )
  })

  it('should handle double slashes correctly with encoded and hash', async () => {
    if (!isExport) {
      const res = await fetchViaHTTP(appPort, '/%2Fgoogle.com', undefined, {
        redirect: 'manual',
      })
      expect(res.status).toBe(404)
      expect(await res.text()).toContain(notFoundContent)
    }

    const browser = await webdriver(appPort, '/%2Fgoogle.com#hello')
    await didNotReload(browser)
    expect(await browser.eval('window.location.pathname')).toBe(
      '/%2Fgoogle.com'
    )
    expect(await browser.eval('window.location.hash')).toBe('#hello')
    expect(await browser.eval('document.documentElement.innerHTML')).toContain(
      notFoundContent
    )
  })

  it('should handle slashes in next/link correctly', async () => {
    const browser = await webdriver(
      appPort,
      `/invalid${isExport ? '.html' : ''}`
    )
    const invalidHrefs = [
      '//google.com',
      '//google.com?hello=1',
      '//google.com#hello',
      '\\/\\/google.com',
      '\\/\\/google.com?hello=1',
      '\\/\\/google.com#hello',
    ]

    for (const href of invalidHrefs) {
      await check(
        () =>
          browser.eval(
            'window.caughtErrors.map(err => typeof err !== "string" ? err.message : err).join(", ")'
          ),
        new RegExp(escapeRegex(`Invalid href passed to next/router: ${href}`))
      )
    }
  })

  it('should have error from slashes in router push', async () => {
    const browser = await webdriver(appPort, '/')

    for (const item of [
      {
        page: 'another',
        href: '/another',
        as: '//google.com',
      },
      {
        page: 'error',
        href: '//google.com',
      },
      {
        page: 'error',
        href: '//google.com?hello=1',
      },
      {
        page: 'error',
        href: '//google.com#hello',
      },
    ]) {
      const result = await browser.executeAsyncScript(`
        var callback = arguments[arguments.length - 1]
        window.beforeNav = 1
        try {
          window.next.router.push("${item.href}"${
        item.as ? `, "${item.as}"` : ''
      }).then(() => callback(false)).catch(err => callback(err.message))
        } catch (err) {
          callback(err.message)
        }
      `)

      expect(result).toContain('Invalid href passed to next/router')
      expect(result).toContain(item.as || item.href)
      expect(await browser.eval('window.location.pathname')).toBe('/')
      expect(await browser.eval('window.next.router.pathname')).toBe('/')
      expect(await browser.eval('window.next.router.asPath')).toBe('/')
      expect(await browser.eval('window.beforeNav')).toBe(1)
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
  })

  const devStartAndExport = (isPages404) => {
    describe('next dev', () => {
      beforeAll(async () => {
        appPort = await findPort()
        app = await launchApp(appDir, appPort, nextOpts)
      })
      afterAll(() => killApp(app))

      runTests({
        isPages404,
        isDev: true,
      })
    })

    describe('production', () => {
      beforeAll(async () => {
        await nextBuild(appDir, [], nextOpts)
      })
      describe('next start', () => {
        beforeAll(async () => {
          appPort = await findPort()
          app = await nextStart(appDir, appPort, nextOpts)
        })
        afterAll(() => killApp(app))

        runTests({
          isPages404,
        })
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

        runTests({
          isPages404,
          isExport: true,
        })
      })
    })
  }

  describe('custom _error', () => {
    devStartAndExport(false)
  })

  describe('pages/404', () => {
    const pagesErr = join(appDir, 'pages/_error.js')
    const pages404 = join(appDir, 'pages/404.js')

    beforeAll(async () => {
      await fs.move(pagesErr, pagesErr + '.bak')
      await fs.writeFile(
        pages404,
        `
          if (typeof window !== 'undefined') {
            window.errorLoad = true
          }
          export default function Page() {
            return <p id='error'>custom 404</p>
          }
        `
      )
      await nextBuild(appDir, [], nextOpts)
    })
    afterAll(async () => {
      await fs.move(pagesErr + '.bak', pagesErr)
      await fs.remove(pages404)
    })

    devStartAndExport(true)
  })
})
