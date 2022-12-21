import path from 'path'
import fs from 'fs/promises'
import { NextConfig } from '../../server/config-shared'
import { Route } from '../../compiled/@vercel/routing-utils'
import { normalizePagePath } from '../../shared/lib/page-path/normalize-page-path'
import {
  collectTracedFiles,
  createPseudoLayer,
  DEFAULT_MAX_FUNCTION_SIZE,
  FunctionGroup,
  generateRoutes,
  getFunctionGroups,
  getPrerenderTypes,
  getPrivateOutputs,
  OUTPUT_VERSION,
  PseudoFile,
} from './output-utils'
import {
  BuildResultBuildOutput,
  BuildResultV2Typical,
  FileFsRef,
  getNodeVersion,
} from '../../compiled/@vercel/build-utils/dist'
import { Header, Redirect, Rewrite } from '../../lib/load-custom-routes'
import { escapeStringRegexp } from '../../shared/lib/escape-regexp'
import { Sema } from 'next/dist/compiled/async-sema'
import { LoadedEnvFiles } from '@next/env'
import { PrerenderManifest } from '..'
import { MiddlewareManifest } from '../webpack/plugins/middleware-plugin'
import findUp from 'next/dist/compiled/find-up'

export async function createOutput({
  dir,
  distDir,
  nextConfig,
  hasNextSupport,
  headers,
  rewrites,
  redirects,
  buildId,
  imagesConfig,
  dynamicRoutes,
  dataRoutes,
  nextServerTrace,
  requiredServerFiles,
  loadedEnvFiles,
  prerenderManifest: originalPrerenderManifest,
  staticPages,
  middlewareManifest,
  originalAppPathRoutes,
  appPathRoutes,
  pageKeys,
  hasPages404,
  hasPages500,
  static404,
  static500,
}: {
  static404: boolean
  static500: boolean
  hasPages404: boolean
  hasPages500: boolean
  pageKeys: {
    pages?: string[]
    app?: string[]
  }
  nextServerTrace: { files: string[] }
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
  buildId: string
  headers: Header[]
  rewrites: {
    fallback: Rewrite[]
    afterFiles: Rewrite[]
    beforeFiles: Rewrite[]
  }
  redirects: Redirect[]
  dir: string
  distDir: string
  nextConfig: NextConfig
  hasNextSupport: boolean
  imagesConfig: NextConfig['images'] & { sizes: number[] }
  requiredServerFiles: {
    files: string[]
    config: any
  }
  loadedEnvFiles: LoadedEnvFiles
  prerenderManifest: PrerenderManifest
  staticPages: Set<string>
  middlewareManifest: MiddlewareManifest
  originalAppPathRoutes: Record<string, string>
  appPathRoutes: Record<string, string>
}) {
  const baseDir = nextConfig.experimental?.outputFileTracingRoot || dir
  const entryDirectory = path.relative(baseDir, dir)
  const outputDir = path.join(distDir, 'output')
  const basePath = nextConfig.basePath || '/'

  await fs.mkdir(outputDir, { recursive: true })

  let functionsConfig = nextConfig.experimental?.functionsConfig

  if (!functionsConfig) {
    const vercelJson = await findUp('vercel.json', { cwd: dir })
    if (vercelJson) {
      functionsConfig = JSON.parse(
        await fs.readFile(vercelJson, 'utf8')
      ).functions
    }
  }
  if (!functionsConfig) {
    functionsConfig = {}
  }
  const internalPages = ['/_app', '/_error', '/_document']
  let hasApiRoutes = false

  const pages404Path = hasPages404 ? '/404' : '/_error'
  const pages500Path = hasPages500 ? '/500' : '/_error'

  const serverlessPages: string[] = []
  const streamingPages: string[] = []

  const addPage = (page: string, pages: string[]) => {
    if (staticPages.has(page) || middlewareManifest.functions[page]) return
    pages.push(page)
  }

  for (const page of pageKeys.pages || []) {
    addPage(page, serverlessPages)
  }
  for (const page of pageKeys.app || []) {
    const denormalizedPage = originalAppPathRoutes[page] || page
    addPage(denormalizedPage, streamingPages)
  }

  const mergedPageKeys = [...new Set([...serverlessPages, ...streamingPages])]
  // currently canUsePreviewMode is determined via API routes
  // as they are the only ones that can enable preview mode
  // or trigger on-demand ISR
  const canUsePreviewMode = hasApiRoutes
  const fallbackFalseRoutes = new Set<string>()
  const previewBypassToken = originalPrerenderManifest.preview.previewModeId
  const prerenderManifest = getPrerenderTypes(originalPrerenderManifest)
  const prerenderRoutes = new Set([
    ...Object.keys(prerenderManifest.staticRoutes),
    ...Object.keys(prerenderManifest.fallbackRoutes),
    ...Object.keys(prerenderManifest.omittedRoutes),
  ])
  const middlewareRoutes: Route[] = []

  const wildcardConfig =
    nextConfig.i18n?.domains && nextConfig.i18n.domains.length > 0
      ? nextConfig.i18n.domains.map((item) => {
          return {
            domain: item.domain,
            value:
              item.defaultLocale === nextConfig.i18n?.defaultLocale
                ? ''
                : `/${item.defaultLocale}`,
          }
        })
      : undefined

  // move _next static files to correct location
  const nextStaticDir = path.join(outputDir, 'static', basePath, '_next')
  await fs.mkdir(nextStaticDir, { recursive: true })
  await fs.rename(path.join(distDir, 'static'), nextStaticDir)

  const pathOverrides: Record<
    string,
    {
      path: string
      contentType: string
    }
  > = {}

  // move purely static pages
  for (const page of [
    ...staticPages,
    ...(static404 ? ['/404'] : []),
    ...(static500 ? ['/500'] : []),
  ]) {
    const normalizedPage = normalizePagePath(page)

    // TODO: sort out bug where the file is downloaded without the
    // extension https://vercel.com/docs/build-output-api/v3#features/high-level-routing/clean-urls
    const subPath = path.join('.', basePath, `${normalizedPage}.html`)
    const outputPath = path.join(outputDir, 'static', subPath)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.rename(
      path.join(distDir, 'server', 'pages', `${normalizedPage}.html`),
      outputPath
    )
    pathOverrides[subPath] = {
      path: subPath.replace(/\.html$/, ''),
      contentType: 'text/html; charset=utf-8',
    }
  }

  const lstatSema = new Sema(100)
  const lstatResults: { [key: string]: ReturnType<typeof fs.lstat> } = {}

  const initialTracedFiles: {
    [filePath: string]: FileFsRef
  } = {}
  const pageTraces: {
    [page: string]: { [key: string]: FileFsRef }
  } = {}
  const compressedPages: {
    [page: string]: PseudoFile
  } = {}

  const nextServerFiles = nextServerTrace.files.map((file: string) => {
    return path.relative(baseDir, path.join(distDir, file))
  })
  await Promise.all(
    nextServerFiles.map(
      collectTracedFiles(
        baseDir,
        lstatResults,
        lstatSema,
        new Map(),
        initialTracedFiles
      )
    )
  )

  await Promise.all(
    requiredServerFiles.files.map(async (file) => {
      await lstatSema.acquire()
      let fsPath = path.join(
        // remove last part of outputDirectory `.next` since this is already
        // included in the file path
        path.join(distDir, '..'),
        file
      )

      const relativePath = path.relative(baseDir, fsPath)
      const { mode } = await fs.lstat(fsPath)
      lstatSema.release()

      initialTracedFiles[relativePath] = new FileFsRef({
        mode,
        fsPath,
      })
    })
  )

  // include any loaded env files
  for (const envFile of loadedEnvFiles) {
    initialTracedFiles[
      path.join(entryDirectory, path.relative(dir, envFile.path))
    ] = new FileFsRef({
      fsPath: envFile.path,
    })
  }

  const initialPseudoLayer = await createPseudoLayer(initialTracedFiles)
  const initialPseudoLayerUncompressedBytes = Object.keys(
    initialPseudoLayer.pseudoLayer
  ).reduce((prev, cur) => {
    const file = initialPseudoLayer.pseudoLayer[cur] as PseudoFile
    return prev + file.uncompressedSize || 0
  }, 0)

  const pagePaths: Record<string, string> = {}

  for (const page of mergedPageKeys) {
    const isAppPath = !!appPathRoutes[page]
    const pagePath = path.join(
      distDir,
      'server',
      isAppPath ? 'app' : 'pages',
      `${isAppPath ? page : normalizePagePath(page)}.js`
    )
    pagePaths[page] = pagePath

    const tracePath = pagePath.replace(/\.js$/, '.js.nft.json')
    let pageTrace: { files: string[] }
    try {
      pageTrace = JSON.parse(await fs.readFile(tracePath, 'utf8'))
    } catch (err) {
      console.error(`Failed to find page trace ${tracePath} for ${page}`, err)
      continue
    }
    const fileList: string[] = []
    const tracedFiles: { [key: string]: FileFsRef } = {}
    const normalizedBaseDir = `${baseDir}${
      baseDir.endsWith(path.sep) ? '' : path.sep
    }`

    for (const file of pageTrace.files) {
      const absolutePath = path.join(path.dirname(tracePath), file)

      // ensure we don't attempt including files outside
      // of the base dir e.g. `/bin/sh`
      if (absolutePath.startsWith(normalizedBaseDir)) {
        fileList.push(path.relative(normalizedBaseDir, absolutePath))
      }
    }

    await Promise.all(
      fileList.map(
        collectTracedFiles(
          baseDir,
          lstatResults,
          lstatSema,
          new Map(),
          tracedFiles
        )
      )
    )
    pageTraces[page] = tracedFiles
    const pageStat = await fs.lstat(pagePath)

    compressedPages[page] = (
      await createPseudoLayer({
        [page]: new FileFsRef({
          fsPath: pagePath,
          mode: pageStat.mode,
        }),
      })
    ).pseudoLayer[page] as PseudoFile
  }

  const tracedPseudoLayer = await createPseudoLayer(
    mergedPageKeys.reduce((prev, page) => {
      Object.assign(prev, pageTraces[page])
      return prev
    }, {})
  )

  let groups: FunctionGroup[] = []

  // TODO: separate groups when hasNextSupport is true
  groups.push(
    ...(await getFunctionGroups({
      entryPath: entryDirectory,
      config: functionsConfig,
      pages: mergedPageKeys,
      prerenderRoutes: new Set(),
      pageTraces,
      compressedPages,
      tracedPseudoLayer: tracedPseudoLayer.pseudoLayer,
      initialPseudoLayer,
      initialPseudoLayerUncompressed: initialPseudoLayerUncompressedBytes,
      functionCompressedByteLimit:
        nextConfig.experimental?.maxFunctionSize || DEFAULT_MAX_FUNCTION_SIZE,
      internalPages,
      pageExtensions: nextConfig.pageExtensions || [],
      sourcePaths: {},
    }))
  )

  let launcherData = await fs.readFile(require.resolve('./server'), 'utf8')

  console.log({ baseDir, entryDirectory })

  const getFunctionDir = (page: string): string => {
    const pagePath = appPathRoutes[page] || normalizePagePath(page)
    return path.join(outputDir, 'functions', basePath, `${pagePath}.func`)
  }
  const nodeVersion = await getNodeVersion(dir, undefined, {}, {})

  for (const group of groups) {
    const initialFunction = group.pages.findIndex(
      (page) => !internalPages.includes(page)
    )

    const functionDir = getFunctionDir(group.pages[initialFunction])
    await fs.mkdir(functionDir, { recursive: true })

    await Promise.all(
      Object.keys(group.pseudoLayer).map(async (file) => {
        const pseudoItem = group.pseudoLayer[file]
        const outputPath = path.join(functionDir, file)
        await fs.mkdir(path.dirname(outputPath), { recursive: true })

        if ('compBuffer' in pseudoItem) {
          await fs.copyFile(pseudoItem.file.fsPath, outputPath)
        } else {
          await fs.symlink(pseudoItem.symlinkTarget, outputPath)
        }
      })
    )

    for (let i = 0; i < group.pages.length; i++) {
      const page = group.pages[i]
      const relativePath = path.relative(baseDir, pagePaths[page])
      const outputPath = path.join(functionDir, relativePath)
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.rename(pagePaths[page], outputPath)
    }

    launcherData = launcherData
      .replace(/__MINIMAL_MODE__/, JSON.stringify(true))
      .replace(
        /__NEXT_CONFIG__/,
        JSON.stringify(hasNextSupport ? requiredServerFiles.config : undefined)
      )
      .replace('__NEXT_SERVER_PATH__', `next/dist/server/next-server.js`)

    await fs.writeFile(
      path.join(functionDir, entryDirectory, '__launcher.js'),
      launcherData
    )
    await fs.writeFile(
      path.join(functionDir, '.vc-config.json'),
      JSON.stringify({
        launcherType: 'Nodejs',
        runtime: nodeVersion.runtime,
        shouldAddHelpers: false,
        handler: path.join(entryDirectory, '__launcher.js'),
      })
    )

    for (let i = 0; i < group.pages.length; i++) {
      const page = group.pages[i]

      if (i === initialFunction || internalPages.includes(page)) {
        continue
      }
      const curFunctionDir = getFunctionDir(page)
      await fs.mkdir(path.dirname(curFunctionDir), { recursive: true })
      await fs.symlink(functionDir, curFunctionDir)
    }
  }

  const createEdgeFunction = async (
    outputName: string,
    edgeInfo: typeof middlewareManifest['functions'][string]
  ) => {
    const functionDir = getFunctionDir(outputName)
    await fs.mkdir(functionDir, { recursive: true })
    const imports: string[] = []

    for (const file of edgeInfo.files) {
      const outputFile = path.join(functionDir, file)

      await fs.mkdir(path.dirname(outputFile), { recursive: true })
      await fs.copyFile(path.join(distDir, file), outputFile)
      imports.push(`import "./${file}"`)
    }
    await fs.writeFile(path.join(functionDir, '__entry.js'), imports.join('\n'))
    await fs.writeFile(
      path.join(functionDir, '.vc-config.json'),
      JSON.stringify({
        runtime: 'edge',
        entrypoint: '__entry.js',
        envVarsInUse: edgeInfo.env,
        regions: edgeInfo.regions,
      })
    )
  }

  for (const page of Object.keys(middlewareManifest.functions || {})) {
    const normalizedPage = appPathRoutes[page] || normalizePagePath(page)
    const edgeInfo = middlewareManifest.functions[page]
    await createEdgeFunction(normalizedPage, edgeInfo)
  }

  for (const middleware of middlewareManifest.sortedMiddleware) {
    const edgeInfo = middlewareManifest.middleware[middleware]
    const name = `_${edgeInfo.name}`

    for (const matcher of edgeInfo.matchers) {
      middlewareRoutes.push({
        src: matcher.regexp,
        has: matcher.has,
        missing: matcher.missing,
        middlewarePath: path.join('.', basePath, name),
      })
    }
    await createEdgeFunction(name, edgeInfo)
  }

  const routes: Route[] = generateRoutes({
    dataRoutes,
    dynamicRoutes,
    nextConfig,
    headers,
    rewrites,
    redirects,
    entryDirectory,
    middlewareRoutes,
    buildId,
    escapedBuildId: escapeStringRegexp(buildId),
    privateOutputs: await getPrivateOutputs(outputDir),
    previewBypassToken,
    canUsePreviewMode,
    fallbackFalseRoutes,
    pages404Path,
    pages500Path,
  })

  await fs.writeFile(
    path.join(outputDir, 'config.json'),
    JSON.stringify(
      {
        version: OUTPUT_VERSION,
        routes,
        overrides: pathOverrides,
        images:
          imagesConfig?.loader === 'default'
            ? {
                domains: imagesConfig.domains,
                sizes: imagesConfig.sizes,
                remotePatterns: imagesConfig.remotePatterns,
                minimumCacheTTL: imagesConfig.minimumCacheTTL,
                formats: imagesConfig.formats,
                dangerouslyAllowSVG: imagesConfig.dangerouslyAllowSVG,
                contentSecurityPolicy: imagesConfig.contentSecurityPolicy,
              }
            : undefined,
        wildcard: wildcardConfig,
      } as {
        version: BuildResultBuildOutput['buildOutputVersion']
        routes: Route[]
        images: BuildResultV2Typical['images']
        wildcard: BuildResultV2Typical['wildcard']
      },
      // TODO: remove formatting after debugging
      null,
      2
    )
  )
}
