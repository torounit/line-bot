import type { webhook } from '@line/bot-sdk'

export type ReplyableTextMessageEvent = webhook.MessageEvent & {
  replyToken: string
  message: webhook.TextMessageContent
}

// MessageEvent.replyToken は optional なので、返信できることを型で保証してからハンドラに渡す。
export const isReplyableTextMessage = (event: webhook.Event): event is ReplyableTextMessageEvent =>
  event.type === 'message' && event.message.type === 'text' && typeof event.replyToken === 'string'
