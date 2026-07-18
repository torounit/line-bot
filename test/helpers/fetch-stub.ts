import { vi } from 'vitest'

export type CapturedRequest = {
  url: string
  method: string
  headers: Headers
  body: unknown
}

/**
 * vitest-pool-workers 0.18 には fetchMock が無いため、グローバル fetch を差し替えて
 * 外向きの LINE API 呼び出しを記録する。worker はテストと同じ isolate で動くので効く。
 */
export function stubLineApi(options: { status?: number; reject?: boolean } = {}) {
  const calls: CapturedRequest[] = []

  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body ? await req.clone().json() : null,
    })
    if (options.reject) throw new Error('network down')
    return Response.json({}, { status: options.status ?? 200 })
  })

  vi.stubGlobal('fetch', stub)
  return { calls }
}
