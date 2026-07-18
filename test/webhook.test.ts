import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import {
  callbackRequest,
  followEvent,
  GROUP_CONVERSATION_KEY,
  groupSource,
  stickerMessageEvent,
  TEST_CHANNEL_ACCESS_TOKEN,
  textMessageEvent,
  USER_CONVERSATION_KEY,
} from './fixtures/line'
import { cleanupAgents, failingModel, stubModel, textModel } from './helpers/agent-stub'
import { stubLineApi } from './helpers/fetch-stub'
import { signedRequest } from './helpers/sign'

const ENDPOINT = 'https://example.com/webhook'
const REPLY_URL = 'https://api.line.me/v2/bot/message/reply'
const LOADING_URL = 'https://api.line.me/v2/bot/chat/loading/start'

// waitUntil に載せた返信の完了を待ってから返す。
const post = async (init: RequestInit): Promise<Response> => {
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(ENDPOINT, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

beforeEach(async () => {
  await cleanupAgents()
})

afterEach(async () => {
  await cleanupAgents()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /health', () => {
  it('ok を返す', async () => {
    const ctx = createExecutionContext()
    const res = await app.fetch(new Request('https://example.com/health'), env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

describe('POST /webhook 署名検証', () => {
  it('署名ヘッダが無ければ 401', async () => {
    const res = await post({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(callbackRequest([])),
    })
    expect(res.status).toBe(401)
  })

  it('署名が不正なら 401', async () => {
    const init = await signedRequest(callbackRequest([]))
    const res = await post({
      ...init,
      headers: { 'content-type': 'application/json', 'x-line-signature': 'ZGVhZGJlZWY=' },
    })
    expect(res.status).toBe(401)
  })

  it('base64 として壊れた署名でも例外にならず 401', async () => {
    const init = await signedRequest(callbackRequest([]))
    const res = await post({
      ...init,
      headers: { 'content-type': 'application/json', 'x-line-signature': '!!!not-base64!!!' },
    })
    expect(res.status).toBe(401)
  })

  it('ボディが署名と一致しなければ 401', async () => {
    const init = await signedRequest(callbackRequest([textMessageEvent('こんにちは')]))
    // 署名はそのままにボディだけ差し替える
    const res = await post({ ...init, body: JSON.stringify(callbackRequest([])) })
    expect(res.status).toBe(401)
  })

  it('署名が正しければ 200（イベント空 = コンソールの検証ボタン相当）', async () => {
    const { calls } = stubLineApi()
    const res = await post(await signedRequest(callbackRequest([])))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(0)
  })

  it('401 のときは LINE API を呼ばない', async () => {
    const { calls } = stubLineApi()
    const init = await signedRequest(callbackRequest([textMessageEvent('こんにちは')]))
    await post({ ...init, headers: { 'content-type': 'application/json' } })
    expect(calls).toHaveLength(0)
  })
})

describe('POST /webhook LLM 返信', () => {
  it('ローディングを出してから生成した返答を返信する', async () => {
    await stubModel(USER_CONVERSATION_KEY, textModel('こんにちは、AI です'))
    const { calls } = stubLineApi()

    const res = await post(await signedRequest(callbackRequest([textMessageEvent('やあ')])))

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
    // ローディング → 返信 の順であること。
    expect(calls[0].url).toBe(LOADING_URL)
    expect(calls[1].url).toBe(REPLY_URL)
    expect(calls[1].headers.get('authorization')).toBe(`Bearer ${TEST_CHANNEL_ACCESS_TOKEN}`)
    expect(calls[1].body).toEqual({
      replyToken: 'reply-token-1',
      messages: [{ type: 'text', text: 'こんにちは、AI です' }],
    })
  })

  it('グループではローディングを出さず返信だけする', async () => {
    await stubModel(GROUP_CONVERSATION_KEY, textModel('グループの返事'))
    const { calls } = stubLineApi()

    const res = await post(
      await signedRequest(
        callbackRequest([textMessageEvent('やあ', 'reply-token-1', groupSource())]),
      ),
    )

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(REPLY_URL)
  })

  it('ローディング API が失敗しても返信はする', async () => {
    await stubModel(USER_CONVERSATION_KEY, textModel('返事'))
    const { calls } = stubLineApi({ status: 500 })

    const res = await post(await signedRequest(callbackRequest([textMessageEvent('やあ')])))

    expect(res.status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual([LOADING_URL, REPLY_URL])
  })

  it('生成が失敗したらフォールバック文言で返信する', async () => {
    await stubModel(USER_CONVERSATION_KEY, failingModel())
    const { calls } = stubLineApi()

    const res = await post(await signedRequest(callbackRequest([textMessageEvent('やあ')])))

    expect(res.status).toBe(200)
    const reply = calls.find((c) => c.url === REPLY_URL)
    expect(JSON.stringify(reply?.body)).toContain('うまく返事ができませんでした')
  })

  it('モデルが空文字を返してもフォールバック文言で返信する', async () => {
    await stubModel(USER_CONVERSATION_KEY, textModel(''))
    const { calls } = stubLineApi()

    await post(await signedRequest(callbackRequest([textMessageEvent('やあ')])))

    const reply = calls.find((c) => c.url === REPLY_URL)
    expect(JSON.stringify(reply?.body)).toContain('うまく返事ができませんでした')
  })

  it('テキスト以外のメッセージは無視して 200', async () => {
    const { calls } = stubLineApi()
    const res = await post(await signedRequest(callbackRequest([stickerMessageEvent()])))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(0)
  })

  it('message 以外のイベントは無視して 200', async () => {
    const { calls } = stubLineApi()
    const res = await post(await signedRequest(callbackRequest([followEvent()])))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(0)
  })

  it('replyToken の無いメッセージイベントは無視して 200', async () => {
    const { calls } = stubLineApi()
    const { replyToken: _, ...withoutReplyToken } = textMessageEvent('こんにちは')
    const res = await post(await signedRequest(callbackRequest([withoutReplyToken])))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(0)
  })

  it('source を持たないイベントは会話キーを作れないので何もせず 200', async () => {
    const { calls } = stubLineApi()
    const { source: _, ...withoutSource } = textMessageEvent('こんにちは')
    const res = await post(await signedRequest(callbackRequest([withoutSource])))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(0)
  })

  it('LINE への返信が 500 でも webhook は 200', async () => {
    await stubModel(USER_CONVERSATION_KEY, textModel('返事'))
    const { calls } = stubLineApi({ status: 500 })
    const res = await post(await signedRequest(callbackRequest([textMessageEvent('やあ')])))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  it('LINE への通信が失敗しても webhook は 200', async () => {
    await stubModel(USER_CONVERSATION_KEY, textModel('返事'))
    stubLineApi({ reject: true })
    const res = await post(await signedRequest(callbackRequest([textMessageEvent('やあ')])))
    expect(res.status).toBe(200)
  })
})
