import { env } from 'cloudflare:test'
import type { webhook } from '@line/bot-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createMessagingClient, type LineReplier, replyText } from '../src/line/client'
import { type LineLoadingShower, showLoading } from '../src/line/loading'
import { conversationKey, isReplyableTextMessage, loadingChatId } from '../src/line/types'
import {
  followEvent,
  GROUP_ID,
  groupSource,
  ROOM_ID,
  roomSource,
  stickerMessageEvent,
  textMessageEvent,
  USER_ID,
  userSource,
} from './fixtures/line'

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

describe('conversationKey', () => {
  it('1 対 1 なら user: プレフィックス', () => {
    expect(conversationKey(userSource())).toBe(`user:${USER_ID}`)
  })

  it('グループなら group: プレフィックス（userId が併存しても group を優先）', () => {
    expect(conversationKey(groupSource())).toBe(`group:${GROUP_ID}`)
  })

  it('ルームなら room: プレフィックス', () => {
    expect(conversationKey(roomSource())).toBe(`room:${ROOM_ID}`)
  })

  it('source が無ければ null', () => {
    expect(conversationKey(undefined)).toBeNull()
  })

  it('userId を持たない user source なら null', () => {
    expect(conversationKey({ type: 'user' })).toBeNull()
  })
})

describe('loadingChatId', () => {
  it('1 対 1 なら userId を返す', () => {
    expect(loadingChatId(userSource())).toBe(USER_ID)
  })

  it('グループ・ルームでは動かないので null', () => {
    expect(loadingChatId(groupSource())).toBeNull()
    expect(loadingChatId(roomSource())).toBeNull()
  })

  it('source が無ければ null', () => {
    expect(loadingChatId(undefined)).toBeNull()
  })

  it('userId を持たない user source なら null', () => {
    expect(loadingChatId({ type: 'user' })).toBeNull()
  })
})

describe('replyText', () => {
  const fakeClient = (impl: LineReplier['replyMessage']) => ({ replyMessage: vi.fn(impl) })

  it('同じ本文で返信し true を返す', async () => {
    const client = fakeClient(async () => ({ sentMessages: [] }))
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
    const client = fakeClient(async () => ({ sentMessages: [] }))
    await replyText(client, 'tok', 'あ'.repeat(6000))
    expect(client.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok',
      messages: [{ type: 'text', text: 'あ'.repeat(5000) }],
    })
  })
})

describe('showLoading', () => {
  const fakeClient = (impl: LineLoadingShower['showLoadingAnimation']) => ({
    showLoadingAnimation: vi.fn(impl),
  })

  it('chatId と既定の loadingSeconds で呼び出し true を返す', async () => {
    const client = fakeClient(async () => ({}))
    expect(await showLoading(client, 'U1')).toBe(true)
    expect(client.showLoadingAnimation).toHaveBeenCalledWith({
      chatId: 'U1',
      loadingSeconds: 20,
    })
  })

  it('loadingSeconds を指定できる', async () => {
    const client = fakeClient(async () => ({}))
    await showLoading(client, 'U1', 5)
    expect(client.showLoadingAnimation).toHaveBeenCalledWith({ chatId: 'U1', loadingSeconds: 5 })
  })

  it('失敗しても例外を投げず false を返す', async () => {
    const client = fakeClient(async () => {
      throw new Error('boom')
    })
    expect(await showLoading(client, 'U1')).toBe(false)
  })
})

describe('createMessagingClient', () => {
  it('binding のアクセストークンからクライアントを生成する', () => {
    expect(typeof createMessagingClient(env).replyMessage).toBe('function')
  })
})
