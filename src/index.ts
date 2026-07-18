import { Hono } from 'hono'
import { createMessagingClient, replyText } from './line/client'
import { isReplyableTextMessage } from './line/types'
import { verifyLineRequest } from './line/verify'

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
      body.events
        .filter(isReplyableTextMessage)
        .map((event) => replyText(client, event.replyToken, event.message.text)),
    ),
  )

  return c.text('ok')
})

export default app
