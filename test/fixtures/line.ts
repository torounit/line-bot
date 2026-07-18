// テスト専用のダミー値。実在の LINE チャネルとは無関係なのでコミットして問題ない。
export const TEST_CHANNEL_SECRET = '0123456789abcdef0123456789abcdef'
export const TEST_CHANNEL_ACCESS_TOKEN = 'test-channel-access-token'

export const USER_ID = 'U0123456789abcdef0123456789abcdef'
export const GROUP_ID = 'C0123456789abcdef0123456789abcdef'
export const ROOM_ID = 'R0123456789abcdef0123456789abcdef'

export const userSource = () => ({ type: 'user' as const, userId: USER_ID })
export const groupSource = () => ({ type: 'group' as const, groupId: GROUP_ID, userId: USER_ID })
export const roomSource = () => ({ type: 'room' as const, roomId: ROOM_ID, userId: USER_ID })

// 会話キーは fixture の既定の source から決まる。テストの期待値をここに集約する。
export const USER_CONVERSATION_KEY = `user:${USER_ID}`
export const GROUP_CONVERSATION_KEY = `group:${GROUP_ID}`

// webhook.EventBase の必須項目を埋めた土台。個々のテストは差分だけ書く。
const eventBase = {
  mode: 'active' as const,
  timestamp: 1700000000000,
  webhookEventId: '01H000000000000000000000000',
  deliveryContext: { isRedelivery: false },
  source: userSource(),
}

export const textMessageEvent = (
  text: string,
  replyToken = 'reply-token-1',
  source: unknown = userSource(),
) => ({
  ...eventBase,
  source,
  type: 'message' as const,
  replyToken,
  message: { type: 'text' as const, id: '1', text, quoteToken: 'q1' },
})

export const stickerMessageEvent = (replyToken = 'reply-token-1') => ({
  ...eventBase,
  type: 'message' as const,
  replyToken,
  message: {
    type: 'sticker' as const,
    id: '2',
    packageId: '1',
    stickerId: '1',
    stickerResourceType: 'STATIC' as const,
    keywords: [],
    quoteToken: 'q2',
  },
})

export const followEvent = (replyToken = 'reply-token-1') => ({
  ...eventBase,
  type: 'follow' as const,
  replyToken,
})

export const callbackRequest = (events: unknown[]) => ({
  destination: USER_ID,
  events,
})
