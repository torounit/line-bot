import { afterEach, describe, expect, it, vi } from 'vitest'
import { searxngSearch } from '../src/tools/web-search'

const config = {
  baseUrl: 'https://searxng.example.com',
  accessClientId: 'id.access',
  accessClientSecret: 'secret',
}

const searxngResponse = (results: unknown[]) => ({
  ok: true,
  json: async () => ({ results }),
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searxngSearch', () => {
  it('検索結果を番号付きのテキストに整形する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searxngResponse([
          { title: 'タイトル1', content: '説明1', url: 'https://example.com/1' },
          { title: 'タイトル2', content: '説明2', url: 'https://example.com/2' },
        ]),
      ),
    )

    const text = await searxngSearch(config, '最新ニュース')

    expect(text).toContain('1. タイトル1')
    expect(text).toContain('説明1')
    expect(text).toContain('https://example.com/1')
    expect(text).toContain('2. タイトル2')
  })

  it('クエリ・json 形式・Access ヘッダを正しく送る', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      searxngResponse([]),
    )
    vi.stubGlobal('fetch', fetchMock)

    await searxngSearch(config, '東京の天気')

    const req = new Request(fetchMock.mock.calls[0][0], fetchMock.mock.calls[0][1])
    const url = new URL(req.url)
    expect(url.origin).toBe('https://searxng.example.com')
    expect(url.pathname).toBe('/search')
    expect(url.searchParams.get('q')).toBe('東京の天気')
    expect(url.searchParams.get('format')).toBe('json')
    expect(req.headers.get('cf-access-client-id')).toBe('id.access')
    expect(req.headers.get('cf-access-client-secret')).toBe('secret')
  })

  it('上位 5 件までに絞る', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`,
      content: `c${i}`,
      url: `https://example.com/${i}`,
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => searxngResponse(many)),
    )

    const text = await searxngSearch(config, 'query')

    expect(text).toContain('5. t4')
    expect(text).not.toContain('6. t5')
  })

  it('結果が空なら見つからなかった旨を返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => searxngResponse([])),
    )
    expect(await searxngSearch(config, 'query')).toContain('見つかりませんでした')
  })

  it('エラー応答でも throw せず失敗の文言を返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    )
    expect(await searxngSearch(config, 'query')).toContain('検索に失敗しました')
  })

  it('通信自体が失敗しても throw しない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    expect(await searxngSearch(config, 'query')).toContain('検索に失敗しました')
  })
})
