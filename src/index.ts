import type { messagingApi } from '@line/bot-sdk'
import { getAgentByName } from 'agents'
import { Hono } from 'hono'
import { createMessagingClient, replyText } from './line/client'
import { showLoading } from './line/loading'
import {
  conversationKey,
  isReplyableTextMessage,
  loadingChatId,
  type ReplyableTextMessageEvent,
} from './line/types'
import { verifyLineRequest } from './line/verify'

// Durable Object クラスは Worker のエントリからも named export する必要がある。
export { LineChatAgent } from './agent'

// 生成に失敗したときの返答。無言だとユーザーには不具合と区別がつかない。
const FALLBACK_TEXT = 'ごめんなさい、いまうまく返事ができませんでした。もう一度話しかけてください。'

/**
 * 各段階の所要時間を記録する。返信が waitUntil の打ち切りで届かない事象を
 * 追うための計測で、どこまで進んだかが分かるよう段階ごとに出す。
 * 発言内容そのものは記録しない（長さだけ）。
 */
const trace = (stage: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ stage, ...fields }))
}

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

  // 1 対 1 チャットでのみローディングを出せる。生成の数秒に対して十分速いので待つ。
  const chatId = loadingChatId(event.source)
  if (chatId !== null) await showLoading(client, chatId)
  const loadingMs = Date.now() - startedAt

  const askStartedAt = Date.now()
  const chatAgent = await getAgentByName(env.LineChatAgent, key)
  const reply = await chatAgent.ask(event.message.text).catch((e: unknown) => {
    console.error('generate failed', e)
    return FALLBACK_TEXT
  })
  const askMs = Date.now() - askStartedAt
  trace('ask.done', { key, loadingMs, askMs, replyLength: reply.length })

  // 空文字は LINE が受け付けないので、フォールバック文言に倒す。
  await replyText(client, event.replyToken, reply.length > 0 ? reply : FALLBACK_TEXT)
  trace('reply.sent', { key, askMs, totalMs: Date.now() - startedAt })
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
