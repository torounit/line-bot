import { vi } from 'vitest'

export type CapturedRequest = {
  url: string
  method: string
  headers: Headers
  body: unknown
}

/**
 * グローバル fetch を差し替え、外向きの呼び出しを記録して決まった応答を返す。
 * @param options.status 返すステータス（既定 200）
 * @param options.reject true なら通信エラーにする
 */
export function stubLineApi(options: { status?: number; reject?: boolean } = {}) {
  // vitest-pool-workers 0.18 には fetchMock が無い。worker はテストと同じ isolate で
  // 動くので、グローバルの差し替えが worker の LINE API 呼び出しにも効く。
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
