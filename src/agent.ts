import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat'
import {
  convertToModelMessages,
  type LanguageModel,
  pruneMessages,
  stepCountIs,
  streamText,
} from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { systemPrompt } from './ai/prompt'

const MODEL_ID = '@cf/moonshotai/kimi-k2.6'
// LINE のテキストメッセージ上限。
const MAX_TEXT_LENGTH = 5000

/** assistant メッセージの text パートを連結する（SDK の private な同等処理を再実装）。 */
const assistantText = (messages: { role: string; parts: { type: string }[] }[]): string => {
  const message = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!message) return ''
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

export class LineChatAgent extends AIChatAgent<CloudflareBindings> {
  maxPersistedMessages = 100
  // 復帰先のクライアントが居ない。DO が落ちた後にアラームでターンを再開しても
  // LINE の reply token は失効していて誰にも届かないため、無効にする。
  chatRecovery = false

  /**
   * 使うモデルを 1 メソッドに閉じ込めた差し替え可能な継ぎ目。
   * env.AI はバインディング RPC（fetch を経由しない）のでグローバル fetch では
   * スタブできない。テストは runInDurableObject でこのメソッドを差し替える。
   */
  protected createModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(MODEL_ID, {
      sessionAffinity: this.sessionAffinity,
    })
  }

  // _onFinish は SDK 内部の全呼び出し元が no-op を渡す死んだ引数なので使わない。
  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const result = streamText({
      model: this.createModel(),
      system: systemPrompt(new Date()),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: 'before-last-2-messages',
      }),
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
      maxOutputTokens: 1024,
      maxRetries: 1,
    })

    // 平文 Response を返すと基底クラスの _sendPlaintextReply がボディをチャンク単位で
    // デコードし、マルチバイト文字がチャンク境界で分断されて文字化けする（日本語で再現）。
    // SSE の UI メッセージストリームなら SDK 側が正しく組み立てるので、こちらを使う。
    return result.toUIMessageStreamResponse()
  }

  /** webhook からの入口。ユーザー発言を履歴に足し、1 ターン走らせて返答を返す。 */
  async ask(text: string): Promise<string> {
    // 関数形の saveMessages はターンロックの内側で走るため、同一会話に複数イベントが
    // 並行して届いても最新の履歴を見る。
    const result = await this.saveMessages((messages) => [
      ...messages,
      { id: crypto.randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text }] },
    ])

    if (result.status !== 'completed') {
      throw new Error(result.error ?? `chat turn ${result.status}`)
    }

    return assistantText(this.messages).trim().slice(0, MAX_TEXT_LENGTH)
  }
}
