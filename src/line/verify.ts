import { validateSignature, type webhook } from '@line/bot-sdk'
import type { Context } from 'hono'

export async function verifyLineRequest(
  c: Context<{ Bindings: CloudflareBindings }>,
): Promise<webhook.CallbackRequest | null> {
  const signature = c.req.header('x-line-signature')
  // 署名検証には JSON.parse 前の生ボディを渡す必要がある。
  const rawBody = await c.req.text()

  if (signature == null) return null
  if (!validateSignature(rawBody, c.env.LINE_CHANNEL_SECRET, signature)) return null

  return JSON.parse(rawBody) as webhook.CallbackRequest
}
