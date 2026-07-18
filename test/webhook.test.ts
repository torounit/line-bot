import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import {
  callbackRequest,
  followEvent,
  stickerMessageEvent,
  TEST_CHANNEL_ACCESS_TOKEN,
  textMessageEvent,
} from './fixtures/line'
import { stubLineApi } from './helpers/fetch-stub'
import { signedRequest } from './helpers/sign'

const ENDPOINT = 'https://example.com/webhook'

// waitUntil に載せた返信の完了を待ってから返す。
const post = async (init: RequestInit): Promise<Response> => {
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(ENDPOINT, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

afterEach(() => {
  vi.unstubAllGlobals()
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

describe('POST /webhook オウム返し', () => {
  it('テキストメッセージに同じ本文で返信する', async () => {
    const { calls } = stubLineApi()
    const res = await post(await signedRequest(callbackRequest([textMessageEvent('こんにちは')])))

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/message/reply')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${TEST_CHANNEL_ACCESS_TOKEN}`)
    expect(calls[0].body).toEqual({
      replyToken: 'reply-token-1',
      messages: [{ type: 'text', text: 'こんにちは' }],
    })
  })

  it('複数イベントはそれぞれ返信する', async () => {
    const { calls } = stubLineApi()
    const res = await post(
      await signedRequest(
        callbackRequest([
          textMessageEvent('ひとつめ', 'reply-token-1'),
          textMessageEvent('ふたつめ', 'reply-token-2'),
        ]),
      ),
    )

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.body)).toEqual(
      expect.arrayContaining([
        { replyToken: 'reply-token-1', messages: [{ type: 'text', text: 'ひとつめ' }] },
        { replyToken: 'reply-token-2', messages: [{ type: 'text', text: 'ふたつめ' }] },
      ]),
    )
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

  it('LINE API が 500 を返しても webhook は 200', async () => {
    const { calls } = stubLineApi({ status: 500 })
    const res = await post(await signedRequest(callbackRequest([textMessageEvent('こんにちは')])))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('LINE API への通信が失敗しても webhook は 200', async () => {
    stubLineApi({ reject: true })
    const res = await post(await signedRequest(callbackRequest([textMessageEvent('こんにちは')])))
    expect(res.status).toBe(200)
  })
})
