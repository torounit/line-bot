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

// gemma-4-26b-a4b は日本語で数字を落とし（2026→206）、ツールも呼べなかった。
// glm-4.7-flash は検索まではできたが、返答に Markdown を混ぜる指示違反と脱字が
// あった。llama-4-scout は応答がおかしかった。deepseek-v4-flash・kimi-k2.6・
// glm-5.x は有料アクセスが必要で、このアカウントでは 403 になる。qwen3.8 は
// 有料アクセス不要で、thinking を止められる。
const MODEL_ID = '@cf/qwen/qwen3.8-27b'
// 自前ホストの SearXNG。Cloudflare Access で保護されており Service Token で通す。
const SEARXNG_URL = 'https://searxng.torounit.foo'
// LINE のテキストメッセージ上限。
const MAX_TEXT_LENGTH = 5000
// この文言だけを送ると会話履歴を捨てる。壊れた応答が履歴に残るとモデルが
// それを踏襲して回復しなくなるため、手動で断ち切る手段を用意しておく。
const RESET_COMMAND = 'リセット'
const RESET_TEXT = '会話履歴をリセットしました。'
/**
 * 最後の発言からこれだけ空いたら、次の発言の前に会話履歴を捨てる。
 * 時間が空いた後の発言はたいてい新しい話題で、古い履歴は文脈として効かないうえ、
 * 壊れた応答が残っていればモデルがそれを踏襲する。毎ターン送るトークンも減る。
 */
const IDLE_RESET_MS = 6 * 60 * 60 * 1000
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
/**
 * 処理済みの webhookEventId を覚えておく期間。再送はこの期間内に届くものだけ捨てる。
 * 記録は会話ごとの DO に閉じているので、会話の数だけ表が分かれ肥大化しない。
 */
const PROCESSED_EVENT_TTL_MS = 24 * 60 * 60 * 1000

/** 1 ターン分の依頼。schedule の payload として JSON で保存される。 */
export type TurnRequest = {
  text: string
  replyToken: string
  /**
   * LINE の webhookEventId。再送されても同じ値で届くので、重複の判定に使う。
   * 再送を処理すると同じ発言が履歴に二重に入り、生成も二回走る。
   */
  eventId: string
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

/** Agent の state。DO の SQLite に永続化される。 */
export type ChatState = {
  /** 最後にターンを受けた時刻（TurnRequest.now）。まだ一度も無ければ null。 */
  lastTurnAt: number | null
}

export class LineChatAgent extends AIChatAgent<CloudflareBindings, ChatState> {
  initialState: ChatState = { lastTurnAt: null }
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
      // thinking は必ず止めること。有効なままだと maxOutputTokens を思考だけで
      // 使い切り、本文が 1 文字も出ないまま打ち切られる（AI Gateway のログで、
      // 応答が reasoning_content のみで tokens_out が上限に張り付くのを確認）。
      // clear_thinking も既定が false で思考をターン間に持ち越し、持ち越すと
      // 本文に独白が混ざる（glm-4.7 で確認）ので併せて落とす。
      // キー名はモデルごとに違いうるので、モデルを変えるときは
      // https://developers.cloudflare.com/workers-ai/models/<model>/sync-input.json
      // で入力スキーマを確認すること（モデルページの表には展開されていない）。
      chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
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
        // 過去のターンの thinking は送り返さない。Claude の thinking ブロックの署名は
        // system プロンプトとそれより前の履歴に紐づいており、毎ターン変わる現在時刻入りの
        // system プロンプトや下の toolCalls の刈り込み、maxPersistedMessages による
        // 先頭の切り捨てで履歴が変わると、送り返した時点で 400 になりうる。
        // すべての thinking を落とすのは許されている。同じターン内のツールループでは
        // AI SDK が直前の thinking をそのまま送るので、ここでの刈り込みは影響しない。
        reasoning: 'all',
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
  async startTurn(request: TurnRequest): Promise<boolean> {
    if (!this.#markProcessed(request.eventId, request.now)) return false

    // schedule のリトライ既定は 3 回。返信が成功した後に再実行されると LINE へ
    // 重複送信されるため 1 回に固定し、失敗時の扱いは runTurn 内で完結させる。
    await this.schedule(0, 'runTurn', request, { retry: { maxAttempts: 1 } })
    return true
  }

  /**
   * イベントを処理済みとして記録する。すでに記録があれば false を返す。
   * this.sql は同期 API で、判定と記録の間に await を挟まないので、
   * 同じイベントが並行して届いても DO の中で片方だけが通る。
   * 記録は受け付けた時点で行う。失敗したターンも runTurn がフォールバック文言で
   * 返信して完結させるので、後から届いた再送でやり直す必要は無い。
   */
  #markProcessed(eventId: string, now: number): boolean {
    this.sql`CREATE TABLE IF NOT EXISTS line_processed_events (
      event_id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL
    )`
    this.sql`DELETE FROM line_processed_events WHERE received_at < ${now - PROCESSED_EVENT_TTL_MS}`
    const inserted = this.sql`INSERT INTO line_processed_events (event_id, received_at)
      VALUES (${eventId}, ${now})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id`
    return inserted.length > 0
  }

  /**
   * schedule のコールバック。DO の alarm() の中で実行されるので、
   * 呼び出し元 Worker の waitUntil の制限を受けない。
   * 失敗しても再配送されないため、返信までをここで完結させる。
   */
  async runTurn(request: TurnRequest): Promise<void> {
    const startedAt = Date.now()
    this.#now = request.now
    // DO 内の Date.now() は alarm 起動直後だと古いので、経過時間も request.now で測る。
    const { lastTurnAt } = this.state
    this.setState({ lastTurnAt: request.now })

    if (request.text.trim() === RESET_COMMAND) {
      await this.#reset()
      trace('reset.done', {})
      await replyText(createMessagingClient(this.env), request.replyToken, RESET_TEXT)
      return
    }

    if (lastTurnAt !== null && request.now - lastTurnAt > IDLE_RESET_MS) {
      await this.#reset()
      trace('idle.reset', { idleMs: request.now - lastTurnAt })
    }

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

  /**
   * 会話履歴を捨てる。saveMessages は書き込みが onChatMessage を起動して
   * 生成まで走らせてしまうので、書き込みだけを行う persistMessages を使う。
   * 空配列を渡すだけでは既存の行が残るため _deleteStaleRows で消す。
   */
  async #reset(): Promise<void> {
    await this.persistMessages([], [], { _deleteStaleRows: true })
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
