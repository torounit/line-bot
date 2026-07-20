// 自前ホストの SearXNG。Cloudflare Access で保護されているので Service Token で通す。
export type SearxngConfig = {
  baseUrl: string
  accessClientId: string
  accessClientSecret: string
}

// LLM に渡す件数。SearXNG は各エンジンから多数返すので上位だけに絞る。
const RESULT_COUNT = 5

type SearxngResult = { title?: string; url?: string; content?: string }
type SearxngResponse = { results?: SearxngResult[] }

/**
 * SearXNG を叩き、LLM に渡しやすい 1 本のテキストに整形する。
 * 失敗しても throw せず、モデルが「検索できなかった」と扱える文字列を返す
 * （tool の execute が throw するとターン全体が失敗するため）。
 */
export async function searxngSearch(
  config: SearxngConfig,
  query: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = new URL('/search', config.baseUrl)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('language', 'ja')

  const res = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/json',
      'CF-Access-Client-Id': config.accessClientId,
      'CF-Access-Client-Secret': config.accessClientSecret,
    },
  }).catch(() => null)

  if (!res?.ok) return '検索に失敗しました。'

  const body = (await res.json().catch(() => null)) as SearxngResponse | null
  const results = body?.results ?? []
  if (results.length === 0) return '検索結果は見つかりませんでした。'

  return results
    .slice(0, RESULT_COUNT)
    .map((r, i) => `${i + 1}. ${r.title ?? ''}\n${r.content ?? ''}\n${r.url ?? ''}`)
    .join('\n\n')
}
