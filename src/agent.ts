import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat'
import {
  convertToModelMessages,
  type LanguageModel,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
} from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'
import { abortAfter } from './abort'
import { systemPrompt } from './ai/prompt'
import { createMessagingClient, replyText } from './line/client'
import { searxngSearch } from './tools/web-search'
import { trace } from './trace'

// MoE で総 26B・活性 4B。thinking を止めた状態なら kimi より速い想定。
const MODEL_ID = '@cf/google/gemma-4-26b-a4b-it'
// 自前ホストの SearXNG。Cloudflare Access で保護されており Service Token で通す。
const SEARXNG_URL = 'https://searxng.torounit.foo'
// LINE のテキストメッセージ上限。
const MAX_TEXT_LENGTH = 5000
// "default" は最初の認証済みリクエストで自動的に作られる。
const AI_GATEWAY_ID = 'default'
/**
 * 生成を打ち切るまでの時間。reply token の有効期限が 1 分なので、
 * これを超えた返答はもう届けられない。打ち切ってフォールバック文言を返す方がよい。
 * 実測では thinking を止めた状態で 2〜4 秒なので、通常は掛からない。
 * 過去に thinking が暴走して 300 秒走り続けた記録がある（DO の alarm は 15 分動ける）。
 */
const GENERATION_TIMEOUT_MS = 45_000
// 生成に失敗したときの返答。無言だとユーザーには不具合と区別がつかない。
const FALLBACK_TEXT = 'ごめんなさい、いまうまく返事ができませんでした。もう一度話しかけてください。'

/** 1 ターン分の依頼。schedule の payload として JSON で保存される。 */
export type TurnRequest = {
  text: string
  replyToken: string
  /**
   * webhook を受けた時点の時刻（epoch ms）。
   * Workers のランタイムは Spectre 対策で I/O が起きるまで時刻を更新しない。
   * alarm で起きた直後の DO には外向きの I/O がまだ無く、new Date() が
   * 前回のターンで最後に I/O した時刻——最後に成功した生成の時刻——を返し続ける。
   * リクエストを受け取った直後で時計が新しい Worker 側から渡す。
   */
  now: number
}

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
   * 進行中のターンで使う「現在時刻」。webhook を受けた Worker から渡される。
   * saveMessages から onChatMessage までは同期的に 1 ターンずつ進む
   * （_runExclusiveChatTurn が直列化する）ので、インスタンスに置いて受け渡す。
   */
  #now: number | undefined

  /**
   * 使うモデルを 1 メソッドに閉じ込めた差し替え可能な継ぎ目。
   * env.AI はバインディング RPC（fetch を経由しない）のでグローバル fetch では
   * スタブできない。テストは runInDurableObject でこのメソッドを差し替える。
   */
  protected createModel(): LanguageModel {
    // env.test は AI バインディングを持たない（テストは createModel をスタブするので
    // 到達しない）ため型上は optional。本番では常に存在する。
    const { AI } = this.env
    if (!AI) throw new Error('AI binding is not configured')

    // AI Gateway を通す目的は観測。1 回ごとのレイテンシ・トークン数・finish reason が
    // ログに残り、Worker 側のログでは見えないモデル呼び出しの中身を追える。
    // キャッシュは有効にしない。キーがリクエストボディ全体の完全一致で、会話履歴を
    // 含む以上ほぼ当たらないため。
    return createWorkersAI({ binding: AI, gateway: { id: AI_GATEWAY_ID } })(MODEL_ID, {
      sessionAffinity: this.sessionAffinity,
      // thinking を止める。有効なままだと maxOutputTokens を思考だけで使い切り、
      // 本文が 1 文字も出ないまま打ち切られる（AI Gateway のログで、応答が
      // reasoning_content のみで tokens_out が上限 1024 に張り付くのを確認）。
      // キー名はモデルごとに違う。gemma-4 は enable_thinking、kimi-k2.6 は thinking。
      // モデルを変えるときは
      // https://developers.cloudflare.com/workers-ai/models/<model>/sync-input.json
      // で入力スキーマを確認すること（モデルページの表には展開されていない）。
      chat_template_kwargs: { enable_thinking: false },
    })
  }

  /**
   * モデルが呼べるツール。最新情報を要する質問のときに web 検索させる。
   * execute を持つサーバ実行ツールなので、tool 呼び出し → 検索 → 最終応答まで
   * onChatMessage の 1 ストリーム内で完結する（クライアントの往復は不要）。
   */
  #tools() {
    return {
      webSearch: tool({
        description:
          '最新のニュースや出来事、学習データに含まれない可能性のある情報を web で検索する。',
        inputSchema: z.object({ query: z.string().describe('検索クエリ。日本語でよい。') }),
        execute: async ({ query }, { abortSignal }) =>
          searxngSearch(
            {
              baseUrl: SEARXNG_URL,
              accessClientId: this.env.CF_ACCESS_CLIENT_ID,
              accessClientSecret: this.env.CF_ACCESS_CLIENT_SECRET,
            },
            query,
            abortSignal,
          ),
      }),
    }
  }

  // _onFinish は SDK 内部の全呼び出し元が no-op を渡す死んだ引数なので使わない。
  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const result = streamText({
      model: this.createModel(),
      // ここで new Date() を呼ぶと、alarm 起動直後は前回のターンの時刻が返る。
      system: systemPrompt(new Date(this.#now ?? Date.now())),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: 'before-last-2-messages',
      }),
      tools: this.#tools(),
      // ツール呼び出し → 検索 → 最終応答で複数ステップ回るので上限を持たせる。
      stopWhen: stepCountIs(5),
      abortSignal: abortAfter(GENERATION_TIMEOUT_MS, options?.abortSignal),
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
    this.#now = request.now
    const reply = await this.#generate(request.text).catch((e: unknown) => {
      console.error('generate failed', e)
      return ''
    })
    const askMs = Date.now() - startedAt
    trace('ask.done', { askMs, replyLength: reply.length, promptTime: request.now })

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
