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

async function handleEvent(
  env: CloudflareBindings,
  client: messagingApi.MessagingApiClient,
  event: ReplyableTextMessageEvent,
): Promise<void> {
  const key = conversationKey(event.source)
  if (key === null) return

  // 1 対 1 チャットでのみローディングを出せる。生成の数秒に対して十分速いので待つ。
  const chatId = loadingChatId(event.source)
  if (chatId !== null) await showLoading(client, chatId)

  const agent = await getAgentByName(env.LineChatAgent, key)
  const reply = await agent.ask(event.message.text).catch((e: unknown) => {
    console.error('generate failed', e)
    return FALLBACK_TEXT
  })

  // 空文字は LINE が受け付けないので、フォールバック文言に倒す。
  await replyText(client, event.replyToken, reply.length > 0 ? reply : FALLBACK_TEXT)
}

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.get('/health', (c) => c.text('ok'))

app.post('/webhook', async (c) => {
  const body = await verifyLineRequest(c)
  if (!body) {
    return c.text('Bad request signature', 401)
  }

  const client = createMessagingClient(c.env)
  // 返信を待たずに 200 を返す。LINE は webhook の応答が遅いとタイムアウト扱いにするため。
  c.executionCtx.waitUntil(
    Promise.all(
      body.events.filter(isReplyableTextMessage).map((event) => handleEvent(c.env, client, event)),
    ),
  )

  return c.text('ok')
})

export default app
