import zlib from 'zlib'
import path from 'path'
import fs from 'fs/promises'
import crc32 from 'next/dist/compiled/buffer-crc32'
import {
  BuildResultBuildOutput,
  Config,
  FileFsRef,
  Files,
  getLambdaOptionsFromFunction,
  isSymbolicLink,
  Prerender,
  streamToBuffer,
} from '../../compiled/@vercel/build-utils/dist'
import { normalizePagePath } from '../../shared/lib/page-path/normalize-page-path'
import type {
  Route,
  RouteWithHandle,
  RouteWithSrc,
} from '../../compiled/@vercel/routing-utils'
import { NextConfig } from '../../server/config-shared'
import { escapeStringRegexp } from '../../shared/lib/escape-regexp'
import { Header, Redirect, Rewrite } from '../../lib/load-custom-routes'
import {
  convertHeaders,
  convertRedirects,
  convertRewrites,
} from '../../compiled/@vercel/routing-utils/superstatic'
import { RSC } from '../../client/components/app-router-headers'
import { isDynamicRoute } from '../../shared/lib/router/utils'
import { NodeFileTraceReasons } from 'next/dist/compiled/@vercel/nft'
import { Sema } from 'next/dist/compiled/async-sema'
import { PrerenderManifest } from '..'
import { normalizeLocalePath } from '../../shared/lib/i18n/normalize-locale-path'

// TODO: leverage debug here?
const debug = (..._args: any[]) => {}

export const KIB = 1024
export const MIB = 1024 * KIB

export const MAX_AGE_ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
export const MAX_UNCOMPRESSED_FUNCTION_SIZE = 250 * MIB
export const FUNCTION_RESERVED_UNCOMPRESSED_SIZE = 2.5 * MIB
export const FUNCTION_RESERVED_COMPRESSED_SIZE = 250 * KIB
export const DEFAULT_MAX_FUNCTION_SIZE = 50 * MIB
export const OUTPUT_VERSION: BuildResultBuildOutput['buildOutputVersion'] = 3

export const PRIVATE_OUTPUTS = {
  'next-stats.json': '_next/__private/stats.json',
  trace: '_next/__private/trace',
}

export type PseudoFile = {
  file: FileFsRef
  isSymlink: false
  crc32: number
  compBuffer: Buffer
  uncompressedSize: number
}

export type PseudoSymbolicLink = {
  file: FileFsRef
  isSymlink: true
  symlinkTarget: string
}

export type PseudoLayer = {
  [fileName: string]: PseudoFile | PseudoSymbolicLink
}

export type PseudoLayerResult = {
  pseudoLayer: PseudoLayer
  pseudoLayerBytes: number
}

export type FunctionGroup = {
  pages: string[]
  memory?: number
  maxDuration?: number
  isStreaming?: boolean
  isPrerenders?: boolean
  pseudoLayer: PseudoLayer
  pseudoLayerBytes: number
  pseudoLayerUncompressedBytes: number
}

const compressBuffer = (buf: Buffer): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(
      buf,
      { level: zlib.constants.Z_BEST_COMPRESSION },
      (err, compBuf) => {
        if (err) return reject(err)
        resolve(compBuf)
      }
    )
  })
}

export async function createPseudoLayer(files: {
  [fileName: string]: FileFsRef
}): Promise<PseudoLayerResult> {
  const pseudoLayer: PseudoLayer = {}
  let pseudoLayerBytes = 0

  for (const fileName of Object.keys(files)) {
    const file = files[fileName]

    if (isSymbolicLink(file.mode)) {
      const symlinkTarget = await fs.readlink(file.fsPath)
      pseudoLayer[fileName] = {
        file,
        isSymlink: true,
        symlinkTarget,
      }
    } else {
      const origBuffer = await streamToBuffer(file.toStream())
      const compBuffer = await compressBuffer(origBuffer)
      pseudoLayerBytes += compBuffer.byteLength
      pseudoLayer[fileName] = {
        file,
        compBuffer,
        isSymlink: false,
        crc32: crc32.unsigned(origBuffer),
        uncompressedSize: origBuffer.byteLength,
      }
    }
  }

  return { pseudoLayer, pseudoLayerBytes }
}

export async function getFunctionGroups({
  entryPath,
  config,
  pages,
  sourcePaths,
  prerenderRoutes,
  pageTraces,
  compressedPages,
  tracedPseudoLayer,
  initialPseudoLayer,
  initialPseudoLayerUncompressed,
  functionCompressedByteLimit,
  internalPages,
}: {
  entryPath: string
  config: Config
  pages: string[]
  sourcePaths: Record<string, string>
  prerenderRoutes: Set<string>
  pageTraces: {
    [page: string]: {
      [key: string]: FileFsRef
    }
  }
  compressedPages: {
    [page: string]: PseudoFile
  }
  tracedPseudoLayer: PseudoLayer
  initialPseudoLayer: PseudoLayerResult
  initialPseudoLayerUncompressed: number
  functionCompressedByteLimit: number
  internalPages: string[]
  pageExtensions?: string[]
}) {
  const groups: Array<FunctionGroup> = []

  for (const page of pages) {
    const newPages = [...internalPages, page]
    const routeName = normalizePagePath(page.replace(/\.js$/, ''))
    const isPrerenderRoute = prerenderRoutes.has(routeName)

    let opts: { memory?: number; maxDuration?: number } = {}

    if (config && config.functions) {
      const sourceFile = path.relative(entryPath, sourcePaths[page])
      opts = await getLambdaOptionsFromFunction({
        sourceFile,
        config,
      })
    }

    let matchingGroup = groups.find((group) => {
      const matches =
        group.maxDuration === opts.maxDuration &&
        group.memory === opts.memory &&
        group.isPrerenders === isPrerenderRoute

      if (matches) {
        let newTracedFilesSize = group.pseudoLayerBytes
        let newTracedFilesUncompressedSize = group.pseudoLayerUncompressedBytes

        for (const newPage of newPages) {
          // eslint-disable-next-line no-loop-func
          Object.keys(pageTraces[newPage] || {}).map((file) => {
            if (!group.pseudoLayer[file]) {
              const item = tracedPseudoLayer[file] as PseudoFile

              newTracedFilesSize += item.compBuffer?.byteLength || 0
              newTracedFilesUncompressedSize += item.uncompressedSize || 0
            }
          })
          newTracedFilesSize += compressedPages[newPage].compBuffer.byteLength
          newTracedFilesUncompressedSize +=
            compressedPages[newPage].uncompressedSize
        }

        const underUncompressedLimit =
          newTracedFilesUncompressedSize <
          MAX_UNCOMPRESSED_FUNCTION_SIZE - FUNCTION_RESERVED_UNCOMPRESSED_SIZE
        const underCompressedLimit =
          newTracedFilesSize <
          functionCompressedByteLimit - FUNCTION_RESERVED_COMPRESSED_SIZE

        return underUncompressedLimit && underCompressedLimit
      }
      return false
    })

    if (matchingGroup) {
      matchingGroup.pages.push(page)
    } else {
      const newGroup: FunctionGroup = {
        pages: [page],
        ...opts,
        isPrerenders: isPrerenderRoute,
        pseudoLayerBytes: initialPseudoLayer.pseudoLayerBytes,
        pseudoLayerUncompressedBytes: initialPseudoLayerUncompressed,
        pseudoLayer: Object.assign({}, initialPseudoLayer.pseudoLayer),
      }
      groups.push(newGroup)
      matchingGroup = newGroup
    }

    for (const newPage of newPages) {
      Object.keys(pageTraces[newPage] || {}).map((file) => {
        const pseudoItem = tracedPseudoLayer[file] as PseudoFile
        const compressedSize = pseudoItem?.compBuffer?.byteLength || 0

        if (!matchingGroup!.pseudoLayer[file]) {
          matchingGroup!.pseudoLayer[file] = pseudoItem
          matchingGroup!.pseudoLayerBytes += compressedSize
          matchingGroup!.pseudoLayerUncompressedBytes +=
            pseudoItem.uncompressedSize || 0
        }
      })

      // ensure the page file itself is accounted for when grouping as
      // large pages can be created that can push the group over the limit
      matchingGroup!.pseudoLayerBytes +=
        compressedPages[newPage].compBuffer.byteLength
      matchingGroup!.pseudoLayerUncompressedBytes +=
        compressedPages[newPage].uncompressedSize
    }
  }

  return groups
}

export function generateRoutes({
  headers,
  rewrites,
  redirects,
  nextConfig,
  buildId,
  entryDirectory,
  middlewareRoutes,
  escapedBuildId,
  privateOutputs,
  pages404Path,
  pages500Path,
  dynamicRoutes: originalDynamicRoutes,
  dataRoutes: originalDataRoutes,
  canUsePreviewMode,
  fallbackFalseRoutes,
  previewBypassToken,
}: {
  previewBypassToken: string
  canUsePreviewMode: boolean
  fallbackFalseRoutes: Set<string>
  dynamicRoutes: Array<{
    page: string
    regex: string
    namedRegex?: string
    routeKeys?: { [key: string]: string }
  }>
  dataRoutes: Array<{
    page: string
    routeKeys?: { [key: string]: string }
    dataRouteRegex: string
    namedDataRouteRegex?: string
  }>
  headers: Header[]
  rewrites: {
    beforeFiles: Rewrite[]
    afterFiles: Rewrite[]
    fallback: Rewrite[]
  }
  redirects: Redirect[]
  middlewareRoutes: Route[]
  buildId: string
  nextConfig: NextConfig
  privateOutputs: { routes: Route[] }
  entryDirectory: string
  escapedBuildId: string
  pages404Path: string
  pages500Path: string
}): Route[] {
  const { i18n, trailingSlash, basePath } = nextConfig
  const isNextDataServerResolving = middlewareRoutes.length > 0

  const trailingSlashRedirects: Redirect[] = []

  redirects = redirects.filter((redirect) => {
    if ((redirect as any).internal && redirect.statusCode === 308) {
      trailingSlashRedirects.push(redirect)
      return false
    }
    return true
  })

  const convertedTrailingSlashRedirects: Route[] = convertRedirects(
    trailingSlashRedirects
  ).map((route) => {
    // we set continue here to prevent the redirect from
    // moving underneath i18n routes
    ;(route as RouteWithSrc).continue = true
    return route
  })
  const convertedRedirects: Route[] = convertRedirects(redirects)
  const convertedHeaders: Route[] = convertHeaders(headers)
  const convertedBeforeFilesRewrites: Route[] = convertRewrites(
    rewrites.beforeFiles
  )
  const convertedAfterFilesRewrites: Route[] = convertRewrites(
    rewrites.afterFiles
  )
  const convertedFallbackRewrites: Route[] = convertRewrites(rewrites.fallback)

  const dynamicRoutes: Route[] = []
  const dataRoutes: Route[] = []

  for (const origRoute of originalDynamicRoutes) {
    const { page, namedRegex, regex, routeKeys } = origRoute
    const route: Route = {
      src: namedRegex || regex,
      dest: `${page}${
        routeKeys
          ? `?${Object.keys(routeKeys)
              .map((key) => `${routeKeys[key]}=$${key}`)
              .join('&')}`
          : ''
      }`,
    }

    if (canUsePreviewMode && fallbackFalseRoutes.has(page)) {
      // only match this route when in preview mode so
      // preview works for non-prerender fallback: false pages
      route.has = [
        {
          type: 'cookie',
          key: '__prerender_bypass',
          value: previewBypassToken || undefined,
        },
        {
          type: 'cookie',
          key: '__next_preview_data',
        },
      ]
    }

    if (canUsePreviewMode || !fallbackFalseRoutes.has(page)) {
      dynamicRoutes.push(route)
      dynamicRoutes.push({
        ...route,
        src: route.src.replace(
          new RegExp(escapeStringRegexp('(?:/)?$')),
          '(?:\\.rsc)?(?:/)?$'
        ),
        dest: route.dest?.replace(/($|\?)/, '.rsc$1'),
      })
    }
  }

  for (const route of originalDataRoutes) {
  }

  const normalizeNextDataRoute = (isOverride = false): Route[] => {
    return isNextDataServerResolving
      ? [
          // strip _next/data prefix for resolving
          {
            src: `^${path.posix.join(
              '/',
              entryDirectory,
              '/_next/data/',
              escapedBuildId,
              '/(.*).json'
            )}`,
            dest: `${path.posix.join(
              '/',
              entryDirectory,
              '/$1',
              trailingSlash ? '/' : ''
            )}`,
            ...(isOverride ? { override: true } : {}),
            continue: true,
            has: [
              {
                type: 'header',
                key: 'x-nextjs-data',
              },
            ],
          },
          // normalize "/index" from "/_next/data/index.json" to -> just "/"
          // as matches a rewrite sources will expect just "/"
          {
            src: path.posix.join('^/', entryDirectory, '/index(?:/)?'),
            has: [
              {
                type: 'header',
                key: 'x-nextjs-data',
              },
            ],
            dest: path.posix.join(
              '/',
              entryDirectory,
              trailingSlash ? '/' : ''
            ),
            ...(isOverride ? { override: true } : {}),
            continue: true,
          },
        ]
      : []
  }

  const denormalizeNextDataRoute = (isOverride = false): Route[] => {
    return isNextDataServerResolving
      ? [
          {
            src: path.posix.join(
              '^/',
              entryDirectory,
              trailingSlash ? '/' : '',
              '$'
            ),
            has: [
              {
                type: 'header',
                key: 'x-nextjs-data',
              },
            ],
            dest: `${path.posix.join(
              '/',
              entryDirectory,
              '/_next/data/',
              buildId,
              '/index.json'
            )}`,
            continue: true,
            ...(isOverride ? { override: true } : {}),
          },
          {
            src: path.posix.join(
              '^/',
              entryDirectory,
              '((?!_next/)(?:.*[^/]|.*))/?$'
            ),
            has: [
              {
                type: 'header',
                key: 'x-nextjs-data',
              },
            ],
            dest: `${path.posix.join(
              '/',
              entryDirectory,
              '/_next/data/',
              buildId,
              '/$1.json'
            )}`,
            continue: true,
            ...(isOverride ? { override: true } : {}),
          },
        ]
      : []
  }

  return [
    /*
        Desired routes order
        - Runtime headers
        - User headers and redirects
        - Runtime redirects
        - Runtime routes
        - Check filesystem, if nothing found continue
        - User rewrites
        - Builder rewrites
      */
    // force trailingSlashRedirect to the very top so it doesn't
    // conflict with i18n routes that don't have or don't have the
    // trailing slash
    ...convertedTrailingSlashRedirects,

    ...privateOutputs.routes,

    // normalize _next/data URL before processing redirects
    ...normalizeNextDataRoute(true),

    ...(i18n
      ? [
          // Handle auto-adding current default locale to path based on
          // $wildcard
          {
            src: `^${path.posix.join(
              '/',
              entryDirectory,
              '/'
            )}(?!(?:_next/.*|${i18n.locales
              .map((locale) => escapeStringRegexp(locale))
              .join('|')})(?:/.*|$))(.*)$`,
            // we aren't able to ensure trailing slash mode here
            // so ensure this comes after the trailing slash redirect
            dest: `${
              entryDirectory !== '.' ? path.posix.join('/', entryDirectory) : ''
            }$wildcard/$1`,
            continue: true,
          },

          // Handle redirecting to locale specific domains
          ...(i18n.domains &&
          i18n.domains.length > 0 &&
          i18n.localeDetection !== false
            ? [
                {
                  src: `^${path.posix.join(
                    '/',
                    entryDirectory
                  )}/?(?:${i18n.locales
                    .map((locale) => escapeStringRegexp(locale))
                    .join('|')})?/?$`,
                  locale: {
                    redirect: i18n.domains.reduce(
                      (prev: Record<string, string>, item) => {
                        prev[item.defaultLocale] = `http${
                          item.http ? '' : 's'
                        }://${item.domain}/`

                        if (item.locales) {
                          item.locales.map((locale) => {
                            prev[locale] = `http${item.http ? '' : 's'}://${
                              item.domain
                            }/${locale}`
                          })
                        }
                        return prev
                      },
                      {}
                    ),
                    cookie: 'NEXT_LOCALE',
                  },
                  continue: true,
                },
              ]
            : []),

          // Handle redirecting to locale paths
          ...(i18n.localeDetection !== false
            ? [
                {
                  // TODO: if default locale is included in this src it won't
                  // be visitable by users who prefer another language since a
                  // cookie isn't set signaling the default locale is
                  // preferred on redirect currently, investigate adding this
                  src: '/',
                  locale: {
                    redirect: i18n.locales.reduce(
                      (prev: Record<string, string>, locale) => {
                        prev[locale] =
                          locale === i18n.defaultLocale ? `/` : `/${locale}`
                        return prev
                      },
                      {}
                    ),
                    cookie: 'NEXT_LOCALE',
                  },
                  continue: true,
                },
              ]
            : []),

          {
            src: `^${path.posix.join('/', entryDirectory)}$`,
            dest: `${path.posix.join('/', entryDirectory, i18n.defaultLocale)}`,
            continue: true,
          },

          // Auto-prefix non-locale path with default locale
          // note for prerendered pages this will cause
          // x-now-route-matches to contain the path minus the locale
          // e.g. for /de/posts/[slug] x-now-route-matches would have
          // 1=posts%2Fpost-1
          {
            src: `^${path.posix.join(
              '/',
              entryDirectory,
              '/'
            )}(?!(?:_next/.*|${i18n.locales
              .map((locale) => escapeStringRegexp(locale))
              .join('|')})(?:/.*|$))(.*)$`,
            dest: `${path.posix.join(
              '/',
              entryDirectory,
              i18n.defaultLocale
            )}/$1`,
            continue: true,
          },
        ]
      : []),

    ...convertedHeaders,

    ...convertedRedirects,

    // middleware comes directly after redirects but before
    // beforeFiles rewrites as middleware is not a "file" route
    ...(nextConfig.experimental?.skipMiddlewareUrlNormalize
      ? denormalizeNextDataRoute(true)
      : []),

    ...middlewareRoutes,

    ...(nextConfig.experimental?.skipMiddlewareUrlNormalize
      ? normalizeNextDataRoute(true)
      : []),

    ...convertedBeforeFilesRewrites,

    // Make sure to 404 for the /404 path itself
    ...(i18n
      ? [
          {
            src: `${path.posix.join('/', entryDirectory, '/')}(?:${i18n.locales
              .map((locale) => escapeStringRegexp(locale))
              .join('|')})?[/]?404/?`,
            status: 404,
            continue: true,
            missing: [
              {
                type: 'header',
                key: 'x-prerender-revalidate',
              },
            ],
          },
        ]
      : [
          {
            src: path.posix.join('/', entryDirectory, '404/?'),
            status: 404,
            continue: true,
            missing: [
              {
                type: 'header',
                key: 'x-prerender-revalidate',
              },
            ],
          },
        ]),

    // Make sure to 500 when visiting /500 directly for static 500
    ...(i18n
      ? [
          {
            src: `${path.posix.join('/', entryDirectory, '/')}(?:${i18n.locales
              .map((locale) => escapeStringRegexp(locale))
              .join('|')})?[/]?${path.posix.join('.', pages500Path)}`,
            status: 500,
            continue: true,
          },
        ]
      : [
          {
            src: path.posix.join('/', entryDirectory, pages500Path),
            status: 500,
            continue: true,
          },
        ]),

    // we need to undo _next/data normalize before checking filesystem
    ...denormalizeNextDataRoute(true),

    ...(nextConfig.experimental?.appDir
      ? [
          {
            src: `^${path.posix.join('/', entryDirectory, '/')}`,
            has: [
              {
                type: 'header',
                key: RSC.toLowerCase(),
              },
            ],
            dest: path.posix.join('/', entryDirectory, '/index.rsc'),
            continue: true,
          },
          {
            src: `^${path.posix.join(
              '/',
              entryDirectory,
              '/((?!.+\\.rsc).+)$'
            )}`,
            has: [
              {
                type: 'header',
                key: RSC.toLowerCase(),
              },
            ],
            dest: path.posix.join('/', entryDirectory, '/$1.rsc'),
            continue: true,
          },
        ]
      : []),

    // Next.js page lambdas, `static/` folder, reserved assets, and `public/`
    // folder
    { handle: 'filesystem' },

    // ensure the basePath prefixed _next/image is rewritten to the root
    // _next/image path
    ...(nextConfig?.basePath
      ? [
          {
            src: path.posix.join('/', entryDirectory, '_next/image/?'),
            dest: '/_next/image',
            check: true,
          },
        ]
      : []),

    // normalize _next/data URL before processing rewrites
    ...normalizeNextDataRoute(),

    ...(!isNextDataServerResolving
      ? [
          // No-op _next/data rewrite to trigger handle: 'rewrites' and then 404
          // if no match to prevent rewriting _next/data unexpectedly
          {
            src: path.posix.join('/', entryDirectory, '_next/data/(.*)'),
            dest: path.posix.join('/', entryDirectory, '_next/data/$1'),
            check: true,
          },
        ]
      : []),

    // These need to come before handle: miss or else they are grouped
    // with that routing section
    ...convertedAfterFilesRewrites,

    // make sure 404 page is used when a directory is matched without
    // an index page
    { handle: 'resource' },

    ...convertedFallbackRewrites,

    { src: path.posix.join('/', entryDirectory, '.*'), status: 404 },

    // We need to make sure to 404 for /_next after handle: miss since
    // handle: miss is called before rewrites and to prevent rewriting /_next
    { handle: 'miss' },
    {
      src: path.posix.join(
        '/',
        entryDirectory,
        '_next/static/(?:[^/]+/pages|pages|chunks|runtime|css|image|media)/.+'
      ),
      status: 404,
      check: true,
      dest: '$0',
    },

    // remove locale prefixes to check public files and
    // to allow checking non-prefixed lambda outputs
    ...(i18n
      ? [
          {
            src: `^${path.posix.join('/', entryDirectory)}/?(?:${i18n.locales
              .map((locale) => escapeStringRegexp(locale))
              .join('|')})/(.*)`,
            dest: `${path.posix.join('/', entryDirectory, '/')}$1`,
            check: true,
          },
        ]
      : []),

    // routes that are called after each rewrite or after routes
    // if there no rewrites
    { handle: 'rewrite' },

    // re-build /_next/data URL after resolving
    ...denormalizeNextDataRoute(),

    ...(isNextDataServerResolving
      ? dataRoutes.filter((route) => {
          // filter to only static data routes as dynamic routes will be handled
          // below
          const { pathname } = new URL(route.dest || '/', 'http://n')
          return !isDynamicRoute(pathname.replace(/\.json$/, ''))
        })
      : []),

    // /_next/data routes for getServerProps/getStaticProps pages
    ...(isNextDataServerResolving
      ? // when resolving data routes for middleware we need to include
        // all dynamic routes including non-SSG/SSP so that the priority
        // is correct
        dynamicRoutes
          .map((route) => {
            route = Object.assign({}, route)
            let normalizedSrc = route.src

            if (basePath) {
              normalizedSrc = normalizedSrc?.replace(
                new RegExp(`\\^${escapeStringRegexp(basePath)}`),
                '^'
              )
            }

            route.src = path.posix.join(
              '^/',
              entryDirectory,
              '_next/data/',
              escapedBuildId,
              normalizedSrc
                ?.replace(/\^\(\?:\/\(\?</, '(?:(?<')
                .replace(/(^\^|\$$)/g, '') + '.json$'
            )

            const parsedDestination = new URL(route.dest || '/', 'http://n')
            let pathname = parsedDestination.pathname
            const search = parsedDestination.search
            const prerenders: Record<string, string> = {}
            let isPrerender = !!prerenders[path.join('./', pathname)]

            if (i18n) {
              for (const locale of i18n?.locales || []) {
                const prerenderPathname = pathname.replace(
                  /^\/\$nextLocale/,
                  `/${locale}`
                )
                if (prerenders[path.join('./', prerenderPathname)]) {
                  isPrerender = true
                  break
                }
              }
            }

            if (isPrerender) {
              if (basePath) {
                pathname = pathname.replace(
                  new RegExp(`^${escapeStringRegexp(basePath)}`),
                  ''
                )
              }
              route.dest = `${
                basePath || ''
              }/_next/data/${buildId}${pathname}.json${search || ''}`
            }
            return route
          })
          .filter(Boolean)
      : dataRoutes),

    ...(!isNextDataServerResolving
      ? [
          // ensure we 404 for non-existent _next/data routes before
          // trying page dynamic routes
          {
            src: path.posix.join('/', entryDirectory, '_next/data/(.*)'),
            dest: path.posix.join('/', entryDirectory, '404'),
            status: 404,
          },
        ]
      : []),

    // Dynamic routes (must come after dataRoutes as dataRoutes are more
    // specific)
    ...dynamicRoutes,

    ...(isNextDataServerResolving
      ? [
          {
            src: `^${path.posix.join(
              '/',
              entryDirectory,
              '/_next/data/',
              escapedBuildId,
              '/(.*).json'
            )}`,
            headers: {
              'x-nextjs-matched-path': '/$1',
            },
            continue: true,
            override: true,
          },
          // add a catch-all data route so we don't 404 when getting
          // middleware effects
          {
            src: `^${path.posix.join(
              '/',
              entryDirectory,
              '/_next/data/',
              escapedBuildId,
              '/(.*).json'
            )}`,
            dest: '__next_data_catchall',
          },
        ]
      : []),

    // routes to call after a file has been matched
    { handle: 'hit' },
    // Before we handle static files we need to set proper caching headers
    {
      // This ensures we only match known emitted-by-Next.js files and not
      // user-emitted files which may be missing a hash in their filename.
      src: path.posix.join(
        '/',
        entryDirectory,
        `_next/static/(?:[^/]+/pages|pages|chunks|runtime|css|image|media|${escapedBuildId})/.+`
      ),
      // Next.js assets contain a hash or entropy in their filenames, so they
      // are guaranteed to be unique and cacheable indefinitely.
      headers: {
        'cache-control': `public,max-age=${MAX_AGE_ONE_YEAR_SECONDS},immutable`,
      },
      continue: true,
      important: true,
    },

    // TODO: remove below workaround when `/` is allowed to be output
    // different than `/index`
    {
      src: path.posix.join('/', entryDirectory, '/index'),
      headers: {
        'x-matched-path': '/',
      },
      continue: true,
      important: true,
    },
    {
      src: path.posix.join('/', entryDirectory, `/((?!index$).*)`),
      headers: {
        'x-matched-path': '/$1',
      },
      continue: true,
      important: true,
    },

    // error handling
    { handle: 'error' } as RouteWithHandle,

    // Custom Next.js 404 page
    ...(i18n
      ? [
          {
            src: `${path.posix.join(
              '/',
              entryDirectory,
              '/'
            )}(?<nextLocale>${i18n.locales
              .map((locale) => escapeStringRegexp(locale))
              .join('|')})(/.*|$)`,
            dest: path.posix.join(
              '/',
              entryDirectory,
              '/$nextLocale',
              pages404Path
            ),
            status: 404,
            caseSensitive: true,
          },
          {
            src: path.posix.join('/', entryDirectory, '.*'),
            dest: path.posix.join(
              '/',
              entryDirectory,
              `/${i18n.defaultLocale}`,
              pages404Path
            ),
            status: 404,
          },
        ]
      : [
          {
            src: path.posix.join('/', entryDirectory, '.*'),
            dest: path.posix.join('/', entryDirectory, pages404Path),
            status: 404,
          },
        ]),

    // custom 500 page if present
    ...(i18n
      ? [
          {
            src: `${path.posix.join(
              '/',
              entryDirectory,
              '/'
            )}(?<nextLocale>${i18n.locales
              .map((locale) => escapeStringRegexp(locale))
              .join('|')})(/.*|$)`,
            dest: path.posix.join(
              '/',
              entryDirectory,
              '/$nextLocale',
              pages500Path
            ),
            status: 500,
            caseSensitive: true,
          },
          {
            src: path.posix.join('/', entryDirectory, '.*'),
            dest: path.posix.join(
              '/',
              entryDirectory,
              `/${i18n.defaultLocale}`,
              pages500Path
            ),
            status: 500,
          },
        ]
      : [
          {
            src: path.posix.join('/', entryDirectory, '.*'),
            dest: path.posix.join('/', entryDirectory, pages500Path),
            status: 500,
          },
        ]),
  ] as Route[]
}

export async function getPrivateOutputs(outputDir: string) {
  const files: Files = {}
  const routes: Route[] = []

  for (const [existingFile, outputFile] of Object.entries(PRIVATE_OUTPUTS)) {
    const fsPath = path.join(outputDir, existingFile)

    try {
      const { mode, size } = await fs.stat(fsPath)
      if (size > 30 * MIB) {
        throw new Error(`Exceeds maximum file size: ${size}`)
      }
      files[outputFile] = new FileFsRef({ mode, fsPath })
      routes.push({
        src: `/${outputFile}`,
        dest: '/404',
        status: 404,
        continue: true,
      })
    } catch (error) {
      debug(
        `Private file ${existingFile} had an error and will not be uploaded: ${error}`
      )
    }
  }

  return { files, routes }
}

export const collectTracedFiles =
  (
    baseDir: string,
    lstatResults: { [key: string]: ReturnType<typeof fs.lstat> },
    lstatSema: Sema,
    reasons: NodeFileTraceReasons,
    files: { [filePath: string]: FileFsRef }
  ) =>
  async (file: string) => {
    const reason = reasons.get(file)
    if (reason && reason.type.includes('initial')) {
      // Initial files are manually added to the lambda later
      return
    }
    const filePath = path.join(baseDir, file)

    if (!lstatResults[filePath]) {
      lstatResults[filePath] = lstatSema
        .acquire()
        .then(() => fs.lstat(filePath))
        .finally(() => lstatSema.release())
    }
    const { mode } = await lstatResults[filePath]

    files[file] = new FileFsRef({
      fsPath: path.join(baseDir, file),
      mode: mode as number,
    })
  }

export type NextPrerenderedRoutes = {
  bypassToken: string | null

  staticRoutes: {
    [route: string]: {
      initialRevalidate: number | false
      dataRoute: string
      srcRoute: string | null
    }
  }

  blockingFallbackRoutes: {
    [route: string]: {
      routeRegex: string
      dataRoute: string
      dataRouteRegex: string
    }
  }

  fallbackRoutes: {
    [route: string]: {
      fallback: string
      routeRegex: string
      dataRoute: string
      dataRouteRegex: string
    }
  }

  omittedRoutes: {
    [route: string]: {
      routeRegex: string
      dataRoute: string
      dataRouteRegex: string
    }
  }

  notFoundRoutes: string[]

  isLocalePrefixed: boolean
}

export function getPrerenderTypes(manifest: PrerenderManifest) {
  const routes = Object.keys(manifest.routes)
  const lazyRoutes = Object.keys(manifest.dynamicRoutes)

  const ret: NextPrerenderedRoutes = {
    staticRoutes: {},
    blockingFallbackRoutes: {},
    fallbackRoutes: {},
    bypassToken: manifest.preview.previewModeId,
    omittedRoutes: {},
    notFoundRoutes: [],
    isLocalePrefixed: manifest.version > 2,
  }

  if (manifest.notFoundRoutes) {
    ret.notFoundRoutes.push(...manifest.notFoundRoutes)
  }

  routes.forEach((route) => {
    const { initialRevalidateSeconds, dataRoute, srcRoute } =
      manifest.routes[route]
    ret.staticRoutes[route] = {
      initialRevalidate:
        initialRevalidateSeconds === false
          ? false
          : Math.max(1, initialRevalidateSeconds),
      dataRoute,
      srcRoute,
    }
  })

  lazyRoutes.forEach((lazyRoute) => {
    const { routeRegex, fallback, dataRoute, dataRouteRegex } =
      manifest.dynamicRoutes[lazyRoute]

    if (typeof fallback === 'string') {
      ret.fallbackRoutes[lazyRoute] = {
        routeRegex,
        fallback,
        dataRoute,
        dataRouteRegex,
      }
    } else if (fallback === null) {
      ret.blockingFallbackRoutes[lazyRoute] = {
        routeRegex,
        dataRoute,
        dataRouteRegex,
      }
    } else {
      // Fallback behavior is disabled, all routes would've been provided
      // in the top-level `routes` key (`staticRoutes`).
      ret.omittedRoutes[lazyRoute] = {
        routeRegex,
        dataRoute,
        dataRouteRegex,
      }
    }
  })

  return ret
}
