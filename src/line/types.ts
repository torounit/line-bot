import type { webhook } from '@line/bot-sdk'

export type ReplyableTextMessageEvent = webhook.MessageEvent & {
  replyToken: string
  message: webhook.TextMessageContent
}

/** replyToken を持つテキストメッセージのイベントか。 */
// MessageEvent.replyToken は optional なので、返信できることを型で保証してからハンドラに渡す。
export const isReplyableTextMessage = (event: webhook.Event): event is ReplyableTextMessageEvent =>
  event.type === 'message' && event.message.type === 'text' && typeof event.replyToken === 'string'

/**
 * 会話履歴を分けるキー。グループ・ルームは参加者全員で 1 つの会話として扱う。
 * @returns source から導出できなければ null（source も userId も optional なので）
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

/**
 * ローディングアニメーションを出す先の chatId。
 * @returns 1 対 1 チャットでなければ null（ローディングは 1 対 1 でしか動かない）
 */
export const loadingChatId = (source: webhook.Source | undefined): string | null =>
  source?.type === 'user' && source.userId != null ? source.userId : null
