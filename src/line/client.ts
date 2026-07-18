import { messagingApi } from '@line/bot-sdk'

// テストでネットワークを介さず差し替えられるよう、使うメソッドだけに絞った型。
export type LineReplier = Pick<messagingApi.MessagingApiClient, 'replyMessage'>

export const createMessagingClient = (env: CloudflareBindings): messagingApi.MessagingApiClient =>
  new messagingApi.MessagingApiClient({ channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN })

export async function replyText(
  client: LineReplier,
  replyToken: string,
  text: string,
): Promise<boolean> {
  // LINE のテキストメッセージ上限は 5000 文字。
  const messages = [{ type: 'text' as const, text: text.slice(0, 5000) }]

  // 返信の失敗を webhook のステータスに波及させると LINE 側が webhook を無効化するため、
  // ここで握りつぶして真偽値に落とす。
  return client
    .replyMessage({ replyToken, messages })
    .then(() => true)
    .catch((e: unknown) => {
      console.error('reply failed', e)
      return false
    })
}
