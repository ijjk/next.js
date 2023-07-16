import type { TLSSocket } from 'tls'
import type { FsOutput } from './filesystem'
import type { IncomingMessage } from 'http'
import type { NextConfigComplete } from '../../config-shared'

import url from 'url'
import { Redirect } from '../../../../types'
import { RenderWorker } from '../router-server'
import setupDebug from 'next/dist/compiled/debug'
import { getCloneableBody } from '../../body-streams'
import { filterReqHeaders } from '../server-ipc/utils'
import { Header } from '../../../lib/load-custom-routes'
import { stringifyQuery } from '../../server-route-utils'
import { invokeRequest } from '../server-ipc/invoke-request'
import { getCookieParser, setLazyProp } from '../../api-utils'
import { getHostname } from '../../../shared/lib/get-hostname'
import { UnwrapPromise } from '../../../lib/coalesced-function'
import { getRedirectStatus } from '../../../lib/redirect-status'
import { normalizeRepeatedSlashes } from '../../../shared/lib/utils'
import { getPathMatch } from '../../../shared/lib/router/utils/path-match'
import { relativizeURL } from '../../../shared/lib/router/utils/relativize-url'
import { addPathPrefix } from '../../../shared/lib/router/utils/add-path-prefix'
import { pathHasPrefix } from '../../../shared/lib/router/utils/path-has-prefix'
import { detectDomainLocale } from '../../../shared/lib/i18n/detect-domain-locale'
import { normalizeLocalePath } from '../../../shared/lib/i18n/normalize-locale-path'
import { removePathPrefix } from '../../../shared/lib/router/utils/remove-path-prefix'

import {
  NextUrlWithParsedQuery,
  addRequestMeta,
  getRequestMeta,
} from '../../request-meta'
import {
  compileNonPath,
  matchHas,
  prepareDestination,
} from '../../../shared/lib/router/utils/prepare-destination'

const debug = setupDebug('next:router-server:resolve-routes')

export function getResolveRoutes(
  fsChecker: UnwrapPromise<
    ReturnType<typeof import('./filesystem').setupFsCheck>
  >,
  config: NextConfigComplete,
  opts: Parameters<typeof import('../router-server').initialize>[0],
  renderWorkers: {
    app?: RenderWorker
    pages?: RenderWorker
  },
  renderWorkerOpts: Parameters<RenderWorker['initialize']>[0],
  ensureMiddleware?: () => Promise<void>
) {
  const routes: ({
    match: ReturnType<typeof getPathMatch>
    check?: boolean
    name?: string
    internal?: boolean
  } & Partial<Header> &
    Partial<Redirect>)[] = [
    // _next/data with middleware handling
    { match: () => ({} as any), name: 'middleware_next_data' },

    ...(opts.minimalMode ? [] : fsChecker.headers),
    ...(opts.minimalMode ? [] : fsChecker.redirects),

    // check middleware (using matchers)
    { match: () => ({} as any), name: 'middleware' },

    ...(opts.minimalMode ? [] : fsChecker.rewrites.beforeFiles),

    // check middleware (using matchers)
    { match: () => ({} as any), name: 'before_files_end' },

    // we check exact matches on fs before continuing to
    // after files rewrites
    { match: () => ({} as any), name: 'check_fs' },

    ...(opts.minimalMode ? [] : fsChecker.rewrites.afterFiles),

    // we always do the check: true handling before continuing to
    // fallback rewrites
    {
      check: true,
      match: () => ({} as any),
      name: 'after files check: true',
    },

    ...(opts.minimalMode ? [] : fsChecker.rewrites.fallback),
  ]

  async function resolveRoutes(
    req: IncomingMessage,
    matchedDynamicRoutes: Set<string>,
    isUpgradeReq?: boolean
  ): Promise<{
    finished: boolean
    statusCode?: number
    bodyStream?: IncomingMessage
    resHeaders: Record<string, string | string[]>
    parsedUrl: NextUrlWithParsedQuery
    matchedOutput?: FsOutput | null
  }> {
    let finished = false
    let resHeaders: Record<string, string | string[]> = {}
    let matchedOutput: FsOutput | null = null
    let parsedUrl = url.parse(req.url || '', true) as NextUrlWithParsedQuery
    let didRewrite = false

    const urlParts = (req.url || '').split('?')
    const urlNoQuery = urlParts[0]

    // this normalizes repeated slashes in the path e.g. hello//world ->
    // hello/world or backslashes to forward slashes, this does not
    // handle trailing slash as that is handled the same as a next.config.js
    // redirect
    if (urlNoQuery?.match(/(\\|\/\/)/)) {
      parsedUrl = url.parse(normalizeRepeatedSlashes(req.url!), true)
      return {
        parsedUrl,
        resHeaders,
        finished: true,
        statusCode: 308,
      }
    }
    // TODO: inherit this from higher up
    const protocol = (req?.socket as TLSSocket)?.encrypted ? 'https' : 'http'

    // When there are hostname and port we build an absolute URL
    const initUrl = (config.experimental as any).trustHostHeader
      ? `https://${req.headers.host || 'localhost'}${req.url}`
      : opts.port
      ? `${protocol}://${opts.hostname || 'localhost'}:${opts.port}${req.url}`
      : req.url || ''

    addRequestMeta(req, '__NEXT_INIT_URL', initUrl)
    addRequestMeta(req, '__NEXT_INIT_QUERY', { ...parsedUrl.query })
    addRequestMeta(req, '_protocol', protocol)
    setLazyProp({ req }, 'cookies', () => getCookieParser(req.headers)())

    if (!isUpgradeReq) {
      addRequestMeta(req, '__NEXT_CLONABLE_BODY', getCloneableBody(req))
    }

    let domainLocale: ReturnType<typeof detectDomainLocale> | undefined
    let defaultLocale: string | undefined
    let initialLocaleResult:
      | ReturnType<typeof normalizeLocalePath>
      | undefined = undefined

    if (config.i18n) {
      const hadBasePath = pathHasPrefix(
        parsedUrl.pathname || '',
        config.basePath
      )
      initialLocaleResult = normalizeLocalePath(
        removePathPrefix(parsedUrl.pathname || '/', config.basePath),
        config.i18n.locales
      )

      domainLocale = detectDomainLocale(
        config.i18n.domains,
        getHostname(parsedUrl, req.headers)
      )
      defaultLocale = domainLocale?.defaultLocale || config.i18n.defaultLocale

      parsedUrl.query.__nextDefaultLocale = defaultLocale
      parsedUrl.query.__nextLocale =
        initialLocaleResult.detectedLocale || defaultLocale

      // ensure locale is present for resolving routes
      if (
        !initialLocaleResult.detectedLocale &&
        !initialLocaleResult.pathname.startsWith('/_next/')
      ) {
        parsedUrl.pathname = addPathPrefix(
          initialLocaleResult.pathname === '/'
            ? `/${defaultLocale}`
            : addPathPrefix(
                initialLocaleResult.pathname || '',
                `/${defaultLocale}`
              ),
          hadBasePath ? config.basePath : ''
        )
      }
    }

    const checkLocaleApi = (pathname: string) => {
      if (
        config.i18n &&
        pathname === urlNoQuery &&
        initialLocaleResult?.detectedLocale &&
        pathHasPrefix(initialLocaleResult.pathname, '/api')
      ) {
        return true
      }
    }

    async function checkTrue() {
      if (checkLocaleApi(parsedUrl.pathname || '')) {
        return
      }
      const output = await fsChecker.getItem(parsedUrl.pathname || '')

      if (output) {
        if (
          config.useFileSystemPublicRoutes ||
          didRewrite ||
          (output.type !== 'appFile' && output.type !== 'pageFile')
        ) {
          return output
        }
      }
      const dynamicRoutes = fsChecker.getDynamicRoutes()
      let curPathname = parsedUrl.pathname

      if (config.basePath) {
        if (!pathHasPrefix(curPathname || '', config.basePath)) {
          return
        }
        curPathname = curPathname?.substring(config.basePath.length) || '/'
      }
      const localeResult = fsChecker.handleLocale(curPathname || '')

      for (const route of dynamicRoutes) {
        // when resolving fallback: false we attempt to
        // render worker may return a no-fallback response
        // which signals we need to continue resolving.
        // TODO: optimize this to collect static paths
        // to use at the routing layer
        if (matchedDynamicRoutes.has(route.page)) {
          continue
        }
        const params = route.match(localeResult.pathname)

        if (params) {
          const pageOutput = await fsChecker.getItem(
            addPathPrefix(route.page, config.basePath || '')
          )

          // i18n locales aren't matched for app dir
          if (
            pageOutput?.type === 'appFile' &&
            initialLocaleResult?.detectedLocale
          ) {
            continue
          }

          if (pageOutput && curPathname?.startsWith('/_next/data')) {
            parsedUrl.query.__nextDataReq = '1'
          }
          matchedDynamicRoutes.add(route.page)

          if (config.useFileSystemPublicRoutes || didRewrite) {
            return pageOutput
          }
        }
      }
    }

    async function handleRoute(
      route: (typeof routes)[0]
    ): Promise<UnwrapPromise<ReturnType<typeof resolveRoutes>> | void> {
      let curPathname = parsedUrl.pathname || '/'

      if (config.i18n && route.internal) {
        if (config.basePath) {
          curPathname = removePathPrefix(curPathname, config.basePath)
        }
        const hadBasePath = curPathname !== parsedUrl.pathname

        const localeResult = normalizeLocalePath(
          curPathname,
          config.i18n.locales
        )

        if (localeResult.detectedLocale === defaultLocale) {
          curPathname =
            localeResult.pathname === '/' && hadBasePath
              ? config.basePath
              : addPathPrefix(
                  localeResult.pathname,
                  hadBasePath ? config.basePath : ''
                )
        } else if (hadBasePath) {
          curPathname =
            curPathname === '/'
              ? config.basePath
              : addPathPrefix(curPathname, config.basePath)
        }
      }
      let params = route.match(curPathname)

      if ((route.has || route.missing) && params) {
        const hasParams = matchHas(
          req,
          parsedUrl.query,
          route.has,
          route.missing
        )
        if (hasParams) {
          Object.assign(params, hasParams)
        } else {
          params = false
        }
      }

      if (params) {
        if (fsChecker.interceptionRoutes && route.name === 'before_files_end') {
          for (const interceptionRoute of fsChecker.interceptionRoutes) {
            const result = await handleRoute(interceptionRoute)

            if (result) {
              return result
            }
          }
        }

        if (route.name === 'middleware_next_data') {
          if (fsChecker.getMiddlewareMatchers()?.length) {
            const nextDataPrefix = addPathPrefix(
              `/_next/data/${fsChecker.buildId}/`,
              config.basePath
            )

            if (
              parsedUrl.pathname?.startsWith(nextDataPrefix) &&
              parsedUrl.pathname.endsWith('.json')
            ) {
              parsedUrl.query.__nextDataReq = '1'
              parsedUrl.pathname = parsedUrl.pathname.substring(
                nextDataPrefix.length - 1
              )
              parsedUrl.pathname = parsedUrl.pathname.substring(
                0,
                parsedUrl.pathname.length - '.json'.length
              )
              parsedUrl.pathname = addPathPrefix(
                parsedUrl.pathname || '',
                config.basePath
              )
              parsedUrl.pathname =
                parsedUrl.pathname === '/index' ? '/' : parsedUrl.pathname
            }
          }
        }

        if (route.name === 'check_fs') {
          if (checkLocaleApi(parsedUrl.pathname || '')) {
            return
          }
          const output = await fsChecker.getItem(parsedUrl.pathname || '')

          if (
            output &&
            !(
              config.i18n &&
              initialLocaleResult?.detectedLocale &&
              pathHasPrefix(parsedUrl.pathname || '', '/api')
            )
          ) {
            if (
              config.useFileSystemPublicRoutes ||
              didRewrite ||
              (output.type !== 'appFile' && output.type !== 'pageFile')
            ) {
              matchedOutput = output

              if (output.locale) {
                parsedUrl.query.__nextLocale = output.locale
              }
              return {
                parsedUrl,
                resHeaders,
                finished: true,
                matchedOutput,
              }
            }
          }
        }

        if (!opts.minimalMode && route.name === 'middleware') {
          const match = fsChecker.getMiddlewareMatchers()
          // @ts-expect-error BaseNextRequest stuff
          if (match?.(parsedUrl.pathname, req, parsedUrl.query)) {
            await ensureMiddleware?.()

            const workerResult = await (
              renderWorkers.app || renderWorkers.pages
            )?.initialize(renderWorkerOpts)

            if (!workerResult) {
              throw new Error(`Failed to initialize render worker "middleware"`)
            }
            const stringifiedQuery = stringifyQuery(
              req as any,
              getRequestMeta(req, '__NEXT_INIT_QUERY') || {}
            )
            const parsedInitUrl = new URL(
              getRequestMeta(req, '__NEXT_INIT_URL') || '/',
              'http://n'
            )

            const curUrl = config.skipMiddlewareUrlNormalize
              ? `${parsedInitUrl.pathname}${parsedInitUrl.search}`
              : `${parsedUrl.pathname}${stringifiedQuery ? '?' : ''}${
                  stringifiedQuery || ''
                }`

            const renderUrl = `http://${workerResult.hostname}:${workerResult.port}${curUrl}`

            const invokeHeaders: typeof req.headers = {
              ...req.headers,
              'x-invoke-path': '',
              'x-invoke-query': '',
              'x-invoke-output': '',
              'x-middleware-invoke': '1',
            }

            debug('invoking middleware', renderUrl, invokeHeaders)

            const middlewareRes = await invokeRequest(
              renderUrl,
              {
                headers: invokeHeaders,
                method: req.method,
              },
              getRequestMeta(req, '__NEXT_CLONABLE_BODY')?.cloneBodyStream()
            )

            debug(
              'middleware res',
              middlewareRes.statusCode,
              middlewareRes.headers
            )

            if (middlewareRes.headers['x-middleware-override-headers']) {
              const overriddenHeaders: Set<string> = new Set()
              let overrideHeaders =
                middlewareRes.headers['x-middleware-override-headers']

              if (typeof overrideHeaders === 'string') {
                overrideHeaders = overrideHeaders.split(',')
              }

              for (const key of overrideHeaders) {
                overriddenHeaders.add(key.trim())
              }
              delete middlewareRes.headers['x-middleware-override-headers']

              // Delete headers.
              for (const key of Object.keys(req.headers)) {
                if (!overriddenHeaders.has(key)) {
                  delete req.headers[key]
                }
              }

              // Update or add headers.
              for (const key of overriddenHeaders.keys()) {
                const valueKey = 'x-middleware-request-' + key
                const newValue = middlewareRes.headers[valueKey]
                const oldValue = req.headers[key]

                if (oldValue !== newValue) {
                  req.headers[key] = newValue === null ? undefined : newValue
                }
                delete middlewareRes.headers[valueKey]
              }
            }

            if (
              !middlewareRes.headers['x-middleware-rewrite'] &&
              !middlewareRes.headers['x-middleware-next'] &&
              !middlewareRes.headers['location']
            ) {
              middlewareRes.headers['x-middleware-refresh'] = '1'
            }
            delete middlewareRes.headers['x-middleware-next']

            for (const [key, value] of Object.entries({
              ...filterReqHeaders(middlewareRes.headers),
            })) {
              if (
                [
                  'content-length',
                  'x-middleware-rewrite',
                  'x-middleware-redirect',
                  'x-middleware-refresh',
                  'x-middleware-invoke',
                  'x-invoke-path',
                  'x-invoke-query',
                ].includes(key)
              ) {
                continue
              }
              if (value) {
                resHeaders[key] = value
                req.headers[key] = value
              }
            }

            if (middlewareRes.headers['x-middleware-rewrite']) {
              const value = middlewareRes.headers[
                'x-middleware-rewrite'
              ] as string
              const rel = relativizeURL(value, initUrl)
              resHeaders['x-middleware-rewrite'] = rel

              const query = parsedUrl.query
              parsedUrl = url.parse(rel, true)

              if (parsedUrl.protocol) {
                return {
                  parsedUrl,
                  resHeaders,
                  finished: true,
                }
              }

              // keep internal query state
              for (const key of Object.keys(query)) {
                if (key.startsWith('_next') || key.startsWith('__next')) {
                  parsedUrl.query[key] = query[key]
                }
              }

              if (config.i18n) {
                const curLocaleResult = normalizeLocalePath(
                  parsedUrl.pathname || '',
                  config.i18n.locales
                )

                if (curLocaleResult.detectedLocale) {
                  parsedUrl.query.__nextLocale = curLocaleResult.detectedLocale
                }
              }
            }

            if (middlewareRes.headers['location']) {
              const value = middlewareRes.headers['location'] as string
              const rel = relativizeURL(value, initUrl)
              resHeaders['location'] = rel
              parsedUrl = url.parse(rel, true)

              return {
                parsedUrl,
                resHeaders,
                finished: true,
                statusCode: middlewareRes.statusCode,
              }
            }

            if (middlewareRes.headers['x-middleware-refresh']) {
              return {
                parsedUrl,
                resHeaders,
                finished: true,
                bodyStream: middlewareRes,
                statusCode: middlewareRes.statusCode,
              }
            }
          }
        }

        // handle redirect
        if (
          ('statusCode' in route || 'permanent' in route) &&
          route.destination
        ) {
          const { parsedDestination } = prepareDestination({
            appendParamsToQuery: false,
            destination: route.destination,
            params: params,
            query: parsedUrl.query,
          })

          const { query } = parsedDestination
          delete (parsedDestination as any).query

          parsedDestination.search = stringifyQuery(req as any, query)

          parsedDestination.pathname = normalizeRepeatedSlashes(
            parsedDestination.pathname
          )

          return {
            finished: true,
            // @ts-expect-error custom ParsedUrl
            parsedUrl: parsedDestination,
            statusCode: getRedirectStatus(route),
          }
        }

        // handle headers
        if (route.headers) {
          const hasParams = Object.keys(params).length > 0
          for (const header of route.headers) {
            let { key, value } = header
            if (hasParams) {
              key = compileNonPath(key, params)
              value = compileNonPath(value, params)
            }

            if (key.toLowerCase() === 'set-cookie') {
              if (!Array.isArray(resHeaders[key])) {
                const val = resHeaders[key]
                resHeaders[key] = typeof val === 'string' ? [val] : []
              }
              ;(resHeaders[key] as string[]).push(value)
            } else {
              resHeaders[key] = value
            }
          }
        }

        // handle rewrite
        if (route.destination) {
          const { parsedDestination } = prepareDestination({
            appendParamsToQuery: true,
            destination: route.destination,
            params: params,
            query: parsedUrl.query,
          })

          if (parsedDestination.protocol) {
            return {
              // @ts-expect-error custom ParsedUrl
              parsedUrl: parsedDestination,
              finished: true,
            }
          }

          if (config.i18n) {
            const curLocaleResult = normalizeLocalePath(
              removePathPrefix(parsedDestination.pathname, config.basePath),
              config.i18n.locales
            )

            if (curLocaleResult.detectedLocale) {
              parsedUrl.query.__nextLocale = curLocaleResult.detectedLocale
            }
          }
          didRewrite = true
          parsedUrl.pathname = parsedDestination.pathname
          Object.assign(parsedUrl.query, parsedDestination.query)
        }

        // handle check: true
        if (route.check) {
          const output = await checkTrue()

          if (output) {
            return {
              parsedUrl,
              resHeaders,
              finished: true,
              matchedOutput: output,
            }
          }
        }
      }
    }

    for (const route of routes) {
      const result = await handleRoute(route)
      if (result) {
        return result
      }
    }

    return {
      finished,
      parsedUrl,
      resHeaders,
      matchedOutput,
    }
  }

  return resolveRoutes
}
