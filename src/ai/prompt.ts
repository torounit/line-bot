import type { ModelMessage } from 'ai'

/**
 * 会話やリクエストによって変わらない、完全に固定のシステムプロンプト。
 * Workers AI の prefix cache は先頭からの共通部分が長いほど効くので、
 * 可変の値（現在時刻など）をここに混ぜてはいけない。
 */
export const systemPrompt = (): string => `あなたは LINE 上で日本語で会話するアシスタントです。

- 返答は日本語で書いてください。
- LINE のトーク画面はプレーンテキストしか表示できません。Markdown の見出し・表・
  コードブロック・箇条書き記号は使わないでください。
- 1 回の返答は 300 文字程度までにまとめてください。
- 日時は Asia/Tokyo（JST, UTC+9）として解釈してください。`

const formatJst = (now: Date): string =>
  now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'full', timeStyle: 'short' })

/**
 * 現在時刻を伝えるメッセージ。履歴より後ろに置くことで、
 * 「固定プロンプト + 前回までの履歴」までを prefix cache が再利用できる。
 * 永続化はせず、モデル呼び出しのたびに組み立てる。
 */
export const currentTimeMessage = (now: Date): ModelMessage => ({
  role: 'system',
  content: `現在の日時: ${formatJst(now)}（JST）`,
})
