import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('GET /', () => {
  it('200 とあいさつを返す', async () => {
    const res = await app.request('/', {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Hello Hono!')
  })
})

describe('未定義のパス', () => {
  it('404 を返す', async () => {
    const res = await app.request('/not-found', {}, env)
    expect(res.status).toBe(404)
  })
})
