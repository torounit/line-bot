import type { messagingApi } from '@line/bot-sdk'

// client.ts の LineReplier と同じく、使うメソッドだけに絞った差し替え可能な型。
export type LineLoadingShower = Pick<messagingApi.MessagingApiClient, 'showLoadingAnimation'>

// loadingSeconds は 5 の倍数・最大 60。生成が終われば LINE 側で自動的に消えるので上限側に寄せる。
const DEFAULT_LOADING_SECONDS = 20

export async function showLoading(
  client: LineLoadingShower,
  chatId: string,
  loadingSeconds: number = DEFAULT_LOADING_SECONDS,
): Promise<boolean> {
  // ローディング表示は演出でしかないので、失敗しても返信は続行する。
  return client
    .showLoadingAnimation({ chatId, loadingSeconds })
    .then(() => true)
    .catch((e: unknown) => {
      console.error('loading animation failed', e)
      return false
    })
}
