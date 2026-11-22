import type { messagingApi } from '@line/bot-sdk'

/** showLoading が使うメソッドだけに絞ったクライアント。テストでは偽物を渡す。 */
export type LineLoadingShower = Pick<messagingApi.MessagingApiClient, 'showLoadingAnimation'>

/** ローディングを出す秒数の既定値。LINE の制約で 5 の倍数・最大 60。 */
const DEFAULT_LOADING_SECONDS = 20

/**
 * ローディングアニメーションを出す。失敗しても例外は投げない。
 * @returns 表示できたら true
 */
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
