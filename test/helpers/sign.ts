import { TEST_CHANNEL_SECRET } from '../fixtures/line'

let signingKey: CryptoKey | undefined

async function getSigningKey(): Promise<CryptoKey> {
  if (!signingKey) {
    signingKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(TEST_CHANNEL_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  }
  return signingKey
}

// LINE と同じ方式（channelSecret での HMAC-SHA256 を base64 化）でリクエストを組み立てる。
export async function signedRequest(payload: unknown): Promise<RequestInit> {
  const body = JSON.stringify(payload)
  const mac = await crypto.subtle.sign(
    'HMAC',
    await getSigningKey(),
    new TextEncoder().encode(body),
  )
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)))

  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': signature },
    body,
  }
}
