import type { messagingApi } from '@line/bot-sdk'
import { getAgentByName } from 'agents'
import { Hono } from 'hono'
import { createMessagingClient } from './line/client'
import { showLoading } from './line/loading'
import {
  conversationKey,
  isReplyableTextMessage,
  loadingChatId,
  type ReplyableTextMessageEvent,
} from './line/types'
import { verifyLineRequest } from './line/verify'
import { trace } from './trace'

// Durable Object クラスは Worker のエントリからも named export する必要がある。
export { LineChatAgent } from './agent'

/** ローディングを出し、Agent にターンを依頼する。生成と返信は Agent 側で行う。 */
async function handleEvent(
  env: CloudflareBindings,
  client: messagingApi.MessagingApiClient,
  event: ReplyableTextMessageEvent,
): Promise<void> {
  const key = conversationKey(event.source)
  if (key === null) return

  const startedAt = Date.now()
  trace('handle.start', {
    key,
    webhookEventId: event.webhookEventId,
    // LINE が返信を受け取れずに再送している場合ここが true になる。
    isRedelivery: event.deliveryContext?.isRedelivery,
    textLength: event.message.text.length,
  })

  // 1 対 1 チャットでのみローディングを出せる。実測 54ms で速いので待つ。
  const chatId = loadingChatId(event.source)
  if (chatId !== null) await showLoading(client, chatId)

  const chatAgent = await getAgentByName(env.LineChatAgent, key)
  const scheduled = await chatAgent.startTurn({
    text: event.message.text,
    replyToken: event.replyToken,
    eventId: event.webhookEventId,
    // Workers のランタイムは Spectre 対策で I/O が起きるまで時刻を更新しない。
    // alarm で起きた直後の DO には外向きの I/O がまだ無く、new Date() が
    // 前回のターンで最後に I/O した時刻を返し続ける。リクエストを受けた直後の
    // ここは時計が新しいので、この時刻を渡す。
    now: Date.now(),
  })
  trace(scheduled ? 'turn.scheduled' : 'turn.duplicate', {
    key,
    webhookEventId: event.webhookEventId,
    elapsedMs: Date.now() - startedAt,
  })
}

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.get('/health', (c) => c.text('ok'))

app.post('/webhook', async (c) => {
  const body = await verifyLineRequest(c)
  if (!body) {
    return c.text('Bad request signature', 401)
  }

  const targets = body.events.filter(isReplyableTextMessage)
  trace('webhook.received', {
    events: body.events.length,
    targets: targets.length,
    // 全イベントの再送フラグ。LINE のリトライで水増しされていないかを見る。
    redeliveries: body.events.filter((e) => e.deliveryContext?.isRedelivery).length,
  })

  const client = createMessagingClient(c.env)
  // 返信を待たずに 200 を返す。LINE は webhook の応答が遅いとタイムアウト扱いにするため。
  c.executionCtx.waitUntil(Promise.all(targets.map((event) => handleEvent(c.env, client, event))))

  return c.text('ok')
})

export default app
