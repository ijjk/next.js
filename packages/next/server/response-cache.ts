import { Revalidate } from '../types'
import { checkIsManualRevalidate } from './api-utils'
import { IncrementalCache } from './incremental-cache'
import RenderResult from './render-result'

interface CachedRedirectValue {
  kind: 'REDIRECT'
  props: Object
}

interface CachedPageValue {
  kind: 'PAGE'
  html: RenderResult
  pageData: Object
}

export type ResponseCacheValue = CachedRedirectValue | CachedPageValue

export type ResponseCacheEntry = {
  revalidate?: Revalidate
  value: ResponseCacheValue | null
}

type ResponseGenerator = (
  hasResolved: boolean,
  hadCache: boolean
) => Promise<ResponseCacheEntry | null>

export default class ResponseCache {
  incrementalCache: IncrementalCache
  pendingResponses: Map<string, Promise<ResponseCacheEntry | null>>

  constructor(incrementalCache: IncrementalCache) {
    this.incrementalCache = incrementalCache
    this.pendingResponses = new Map()
  }

  public get(
    key: string | null,
    responseGenerator: ResponseGenerator,
    options: { isManualRevalidate?: boolean } = {}
  ): Promise<ResponseCacheEntry | null> {
    const pendingResponse = key ? this.pendingResponses.get(key) : null
    if (pendingResponse) {
      return pendingResponse
    }

    let resolver: (cacheEntry: ResponseCacheEntry | null) => void = () => {}
    let rejecter: (error: Error) => void = () => {}
    const promise: Promise<ResponseCacheEntry | null> = new Promise(
      (resolve, reject) => {
        resolver = resolve
        rejecter = reject
      }
    )
    if (key) {
      this.pendingResponses.set(key, promise)
    }

    let resolved = false
    const resolve = (cacheEntry: ResponseCacheEntry | null) => {
      if (key) {
        // Ensure all reads from the cache get the latest value.
        this.pendingResponses.set(key, Promise.resolve(cacheEntry))
      }
      if (!resolved) {
        resolved = true
        resolver(cacheEntry)
      }
    }

    // We wait to do any async work until after we've added our promise to
    // `pendingResponses` to ensure that any any other calls will reuse the
    // same promise until we've fully finished our work.
    ;(async () => {
      try {
        const cachedResponse = key ? await this.incrementalCache.get(key) : null

        if (cachedResponse && !options.isManualRevalidate) {
          resolve({
            revalidate: cachedResponse.curRevalidate,
            value:
              cachedResponse.value?.kind === 'PAGE'
                ? {
                    kind: 'PAGE',
                    html: RenderResult.fromStatic(cachedResponse.value.html),
                    pageData: cachedResponse.value.pageData,
                  }
                : cachedResponse.value,
          })
          if (!cachedResponse.isStale) {
            // The cached value is still valid, so we don't need
            // to update it yet.
            return
          }
        }

        const cacheEntry = await responseGenerator(resolved, !!cachedResponse)
        resolve(cacheEntry)

        if (key && cacheEntry && typeof cacheEntry.revalidate !== 'undefined') {
          await this.incrementalCache.set(
            key,
            cacheEntry.value?.kind === 'PAGE'
              ? {
                  kind: 'PAGE',
                  html: cacheEntry.value.html.toUnchunkedString(),
                  pageData: cacheEntry.value.pageData,
                }
              : cacheEntry.value,
            cacheEntry.revalidate
          )
        }
      } catch (err) {
        rejecter(err as Error)
      } finally {
        if (key) {
          this.pendingResponses.delete(key)
        }
      }
    })()
    return promise
  }
}
