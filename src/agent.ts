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
import { createMessagingClient, replyText } from './line/client'
import { trace } from './trace'

const MODEL_ID = '@cf/moonshotai/kimi-k2.6'
// LINE のテキストメッセージ上限。
const MAX_TEXT_LENGTH = 5000
// "default" は最初の認証済みリクエストで自動的に作られる。
const AI_GATEWAY_ID = 'default'
// 生成に失敗したときの返答。無言だとユーザーには不具合と区別がつかない。
const FALLBACK_TEXT = 'ごめんなさい、いまうまく返事ができませんでした。もう一度話しかけてください。'

/** 1 ターン分の依頼。schedule の payload として JSON で保存される。 */
export type TurnRequest = { text: string; replyToken: string }

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
    // AI Gateway を通す目的は観測。1 回ごとのレイテンシ・トークン数・finish reason が
    // ログに残り、Worker 側のログでは見えないモデル呼び出しの中身を追える。
    // キャッシュは有効にしない。キーがリクエストボディ全体の完全一致で、会話履歴を
    // 含む以上ほぼ当たらないため。
    return createWorkersAI({
      binding: this.env.AI,
      gateway: { id: AI_GATEWAY_ID },
    })(MODEL_ID, {
      sessionAffinity: this.sessionAffinity,
      // thinking を止める。有効なままだと maxOutputTokens を思考だけで使い切り、
      // 本文が 1 文字も出ないまま打ち切られる（AI Gateway のログで、応答が
      // reasoning_content のみで tokens_out が上限 1024 に張り付くのを確認）。
      // K2.6 の指定キーは thinking で、provider の型はまだ enable_thinking のまま
      // 追随していない。chat_template_kwargs は binding.run() の inputs へそのまま
      // 転送されるため、型だけ広げて実際のキーを渡す。
      chat_template_kwargs: { thinking: false } as { enable_thinking?: boolean },
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

  /**
   * webhook からの入口。生成を待たずにスケジュールして即座に返る。
   * Worker の waitUntil はレスポンス送信後 30 秒で打ち切られるが、生成には
   * 実測で 20 秒前後かかり余裕が無い。alarm ハンドラなら上限が 15 分になる。
   */
  async startTurn(request: TurnRequest): Promise<void> {
    // schedule のリトライ既定は 3 回。返信が成功した後に再実行されると LINE へ
    // 重複送信されるため 1 回に固定し、失敗時の扱いは runTurn 内で完結させる。
    await this.schedule(0, 'runTurn', request, { retry: { maxAttempts: 1 } })
  }

  /**
   * schedule のコールバック。DO の alarm() の中で実行されるので、
   * 呼び出し元 Worker の waitUntil の制限を受けない。
   * 失敗しても再配送されないため、返信までをここで完結させる。
   */
  async runTurn(request: TurnRequest): Promise<void> {
    const startedAt = Date.now()
    const reply = await this.#generate(request.text).catch((e: unknown) => {
      console.error('generate failed', e)
      return ''
    })
    const askMs = Date.now() - startedAt
    trace('ask.done', { askMs, replyLength: reply.length })

    // 空文字は LINE が受け付けないので、生成失敗と同じくフォールバック文言に倒す。
    const text = reply.length > 0 ? reply : FALLBACK_TEXT
    await replyText(createMessagingClient(this.env), request.replyToken, text)
    trace('reply.sent', { askMs, totalMs: Date.now() - startedAt })
  }

  async #generate(text: string): Promise<string> {
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
