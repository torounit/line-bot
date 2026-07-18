import { env } from 'cloudflare:test'
import type { webhook } from '@line/bot-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createMessagingClient, type LineReplier, replyText } from '../src/line/client'
import { isReplyableTextMessage } from '../src/line/types'
import { followEvent, stickerMessageEvent, textMessageEvent } from './fixtures/line'

describe('isReplyableTextMessage', () => {
  it('replyToken を持つテキストメッセージなら true', () => {
    expect(isReplyableTextMessage(textMessageEvent('こんにちは') as webhook.Event)).toBe(true)
  })

  it('replyToken が無ければ false', () => {
    const { replyToken: _, ...event } = textMessageEvent('こんにちは')
    expect(isReplyableTextMessage(event as webhook.Event)).toBe(false)
  })

  it('テキスト以外のメッセージなら false', () => {
    expect(isReplyableTextMessage(stickerMessageEvent() as webhook.Event)).toBe(false)
  })

  it('message 以外のイベントなら false', () => {
    expect(isReplyableTextMessage(followEvent() as webhook.Event)).toBe(false)
  })
})

describe('replyText', () => {
  const fakeClient = (
    impl: () => Promise<unknown>,
  ): LineReplier & { replyMessage: ReturnType<typeof vi.fn> } => ({
    replyMessage: vi.fn(impl),
  })

  it('同じ本文で返信し true を返す', async () => {
    const client = fakeClient(async () => ({}))
    expect(await replyText(client, 'tok', 'やあ')).toBe(true)
    expect(client.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok',
      messages: [{ type: 'text', text: 'やあ' }],
    })
  })

  it('返信が失敗しても例外を投げず false を返す', async () => {
    const client = fakeClient(async () => {
      throw new Error('boom')
    })
    expect(await replyText(client, 'tok', 'やあ')).toBe(false)
  })

  it('5000 文字を超えるテキストは切り詰める', async () => {
    const client = fakeClient(async () => ({}))
    await replyText(client, 'tok', 'あ'.repeat(6000))
    expect(client.replyMessage.mock.calls[0][0].messages[0].text).toHaveLength(5000)
  })
})

describe('createMessagingClient', () => {
  it('binding のアクセストークンからクライアントを生成する', () => {
    expect(typeof createMessagingClient(env).replyMessage).toBe('function')
  })
})
