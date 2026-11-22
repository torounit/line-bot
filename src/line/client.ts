import { messagingApi } from '@line/bot-sdk'

/** replyText が使うメソッドだけに絞ったクライアント。テストでは偽物を渡す。 */
export type LineReplier = Pick<messagingApi.MessagingApiClient, 'replyMessage'>

/** LINE のテキストメッセージ上限。 */
const MAX_TEXT_LENGTH = 5000

export const createMessagingClient = (env: CloudflareBindings): messagingApi.MessagingApiClient =>
  new messagingApi.MessagingApiClient({ channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN })

/**
 * 上限を超えた分を切り詰めて返信する。失敗しても例外は投げない。
 * @returns 返信できたら true
 */
export async function replyText(
  client: LineReplier,
  replyToken: string,
  text: string,
): Promise<boolean> {
  const messages = [{ type: 'text' as const, text: text.slice(0, MAX_TEXT_LENGTH) }]
  try {
    await client.replyMessage({ replyToken, messages })
    return true
  } catch (e) {
    console.error('reply failed', e)
    return false
  }
}
