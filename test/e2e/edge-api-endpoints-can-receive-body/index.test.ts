import { join } from 'path'
import { fetchViaHTTP } from 'next-test-utils'
import { createNext, FileRef } from 'e2e-utils'
import { NextInstance } from 'test/lib/next-modes/base'

describe('Edge API endpoints can receive body', () => {
  let next: NextInstance

  beforeAll(async () => {
    next = await createNext({
      files: new FileRef(join(__dirname, 'app')),
      dependencies: {},
    })
  })
  afterAll(() => next.destroy())

  it('reads the body as text', async () => {
    const res = await fetchViaHTTP(
      next.url,
      '/api/edge',
      {},
      {
        body: 'hello, world.',
        method: 'POST',
      }
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('got: hello, world.')
  })

  it('reads the body from index', async () => {
    const res = await fetchViaHTTP(
      next.url,
      '/api',
      {},
      {
        body: 'hello, world.',
        method: 'POST',
      }
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('got: hello, world.')
  })

  it('should work with fetch response correctly', async () => {
    const res = await fetchViaHTTP(next.url, '/api/fetch-response')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Example Domain')
  })
})
