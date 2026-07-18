import type { webhook } from '@line/bot-sdk'

export type ReplyableTextMessageEvent = webhook.MessageEvent & {
  replyToken: string
  message: webhook.TextMessageContent
}

// MessageEvent.replyToken は optional なので、返信できることを型で保証してからハンドラに渡す。
export const isReplyableTextMessage = (event: webhook.Event): event is ReplyableTextMessageEvent =>
  event.type === 'message' && event.message.type === 'text' && typeof event.replyToken === 'string'

/**
 * 会話履歴を分ける単位。グループ・ルームは参加者全員で 1 つの会話として扱う。
 * source も userId も optional なので、導出できなければ null を返す（キーを捏造しない）。
 */
export const conversationKey = (source: webhook.Source | undefined): string | null => {
  switch (source?.type) {
    case 'group':
      return `group:${source.groupId}`
    case 'room':
      return `room:${source.roomId}`
    case 'user':
      return source.userId != null ? `user:${source.userId}` : null
    default:
      return null
  }
}

// ローディングアニメーションは 1 対 1 チャットでのみ動作するため、user のときだけ対象になる。
export const loadingChatId = (source: webhook.Source | undefined): string | null =>
  source?.type === 'user' && source.userId != null ? source.userId : null
