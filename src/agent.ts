import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat'
import { convertToModelMessages, type LanguageModel, pruneMessages, streamText } from 'ai'
import { abortAfter } from './abort'
import { systemPrompt } from './ai/prompt'
import { createMessagingClient, replyText } from './line/client'
import { trace } from './trace'

const MODEL_ID = 'claude-sonnet-5-5'
/** 1 回の応答で web 検索できる回数。 */
// 検索は 1 回ごとに課金され待ち時間も延びるが、言い換えて検索し直す程度の余地は残す。
const MAX_WEB_SEARCHES = 3
/** この文言だけを送ると会話履歴を捨てる。 */
const RESET_COMMAND = 'リセット'
const RESET_TEXT = '会話履歴をリセットしました。'
/** 最後の発言からこれだけ空いたら、次の発言の前に会話履歴を捨てる。 */
const IDLE_RESET_MS = 6 * 60 * 60 * 1000
/** Anthropic の資格情報（BYOK）を Provider Keys に登録してある AI Gateway の ID。 */
const AI_GATEWAY_ID = 'claude'
/** 1 回の応答で使える出力トークン。thinking のトークンも含む。 */
// 返答はプロンプトで 300 文字程度に絞っているので、thinking の分を見込んで余裕を持たせる。
const MAX_OUTPUT_TOKENS = 4096
/** 生成を打ち切るまでの時間。 */
// reply token の有効期限が 1 分で、それを過ぎた返答はもう届けられない。
const GENERATION_TIMEOUT_MS = 45_000
/** 生成に失敗したときの返答。 */
const FALLBACK_TEXT = 'ごめんなさい、いまうまく返事ができませんでした。もう一度話しかけてください。'
/** 処理済みの webhookEventId を覚えておく期間。この期間内に届いた再送だけを捨てる。 */
// 記録は会話ごとの DO に閉じているので、この期間ぶん貯めても表は大きくならない。
const PROCESSED_EVENT_TTL_MS = 24 * 60 * 60 * 1000

/** 1 ターン分の依頼。schedule の payload として JSON で保存される。 */
export type TurnRequest = {
  text: string
  replyToken: string
  /** LINE の webhookEventId。再送されても同じ値で届くので、重複の判定に使う。 */
  eventId: string
  /** webhook を受けた時点の時刻（epoch ms）。DO の中では Date.now() ではなくこれを使う。 */
  now: number
}

/** 最後の assistant メッセージの text パートを連結する。 */
const assistantText = (messages: { role: string; parts: { type: string }[] }[]): string => {
  // SDK にも同等の処理があるが private なので再実装する。
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
  // LINE の reply token は失効していて誰にも届かない。
  chatRecovery = false

  /** 進行中のターンの TurnRequest.now。 */
  #now: number | undefined

  /** 生成に使うモデルを返す。テストは runInDurableObject でこのメソッドを差し替える。 */
  protected async createModel(): Promise<LanguageModel> {
    // env.test は AI バインディングを持たない（テストは createModel をスタブするので
    // 到達しない）ため型上は optional。本番では常に存在する。
    const { AI } = this.env
    if (!AI) throw new Error('AI binding is not configured')

    // AI Gateway を通す目的は観測。1 回ごとのレイテンシ・トークン数・finish reason が
    // ログに残り、Worker 側のログでは見えないモデル呼び出しの中身を追える。
    // キャッシュは有効にしない。キーがリクエストボディ全体の完全一致で、会話履歴を
    // 含む以上ほぼ当たらないため。
    // バインディングは URL（アカウント ID 入り）を得るためだけに使う。ここからの
    // fetch はバインディング経由ではないので、cf-aig-authorization で認証する。
    const baseURL = `${await AI.gateway(AI_GATEWAY_ID).getUrl('anthropic')}/v1`
    return createAnthropic({
      baseURL,
      // Anthropic の API キーは AI Gateway 側（BYOK か Unified Billing）が持つ。
      // provider は apiKey が無いと例外を投げるのでダミーを渡し、x-api-key ヘッダは
      // 消す。リクエストに x-api-key があると Gateway はそちらを資格情報として使う。
      apiKey: 'unused',
      headers: {
        'x-api-key': undefined as unknown as string,
        'cf-aig-authorization': `Bearer ${this.env.CF_AIG_TOKEN}`,
      },
    })(MODEL_ID)
  }

  /** モデルに渡すツール。最新情報を要する質問で web 検索させる。 */
  #tools() {
    return {
      // Anthropic のサーバツールなので、検索は API の中で行われ、検索 → 最終応答まで
      // 1 回のモデル呼び出しで完結する（こちらで execute する必要は無い）。
      web_search: anthropic.tools.webSearch_20260209({
        maxUses: MAX_WEB_SEARCHES,
        // 日本の利用者向けに、地域に関わる検索結果を寄せる。
        userLocation: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' },
      }),
    }
  }

  /**
   * 1 ターンぶんのモデルの応答をストリームで返す。AIChatAgent から呼ばれる。
   * @param _onFinish 使わない。SDK 内部の呼び出し元はすべて no-op を渡す。
   */
  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const result = streamText({
      model: await this.createModel(),
      system: systemPrompt(new Date(this.#now ?? Date.now())),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        // 過去のターンの thinking は送り返さない。Claude の thinking ブロックの署名は
        // system プロンプトとそれより前の履歴に紐づいており、毎ターン変わる現在時刻入りの
        // system プロンプトや下の toolCalls の刈り込み、maxPersistedMessages による
        // 先頭の切り捨てで履歴が変わると、送り返した時点で 400 になりうる。
        // すべての thinking を落とすのは許されている。
        reasoning: 'all',
        toolCalls: 'before-last-2-messages',
      }),
      tools: this.#tools(),
      // 期限を過ぎた返答は届けられないので、打ち切ってフォールバック文言を返す。
      abortSignal: abortAfter(GENERATION_TIMEOUT_MS, options?.abortSignal),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 1,
      providerOptions: {
        anthropic: {
          // thinking の深さは effort で抑える（Sonnet 5.5 は thinking: disabled が 400）。
          // 既定は high。雑談と検索の要約が主で、返信の期限（1 分）もあるので low にする。
          effort: 'low',
          // 安全分類器に断られたとき、API 側で別のモデルに回して答えさせる。
          // 断られたままだと本文が空になり、フォールバック文言しか返せない。
          fallbacks: 'default',
        },
      },
    })

    // 平文 Response を返すと基底クラスの _sendPlaintextReply がボディをチャンク単位で
    // デコードし、マルチバイト文字がチャンク境界で分断されて文字化けする（日本語で再現）。
    // SSE の UI メッセージストリームなら SDK 側が正しく組み立てるので、こちらを使う。
    return result.toUIMessageStreamResponse()
  }

  /**
   * webhook からの入口。生成を待たずに runTurn をスケジュールして即座に返る。
   * @returns 受け付けたら true、処理済みのイベントの再送なら false
   */
  async startTurn(request: TurnRequest): Promise<boolean> {
    // 再送を処理すると同じ発言が履歴に二重に入り、生成も二回走る。
    // 記録は受け付けた時点で行う。失敗したターンも runTurn がフォールバック文言で
    // 返信して完結させるので、後から届いた再送でやり直す必要は無い。
    if (!this.#markProcessed(request.eventId, request.now)) return false

    // Worker の waitUntil はレスポンス送信後 30 秒で打ち切られるが、生成には
    // 実測で 20 秒前後かかり余裕が無い。alarm ハンドラなら上限が 15 分になる。
    // schedule のリトライ既定は 3 回。返信が成功した後に再実行されると LINE へ
    // 重複送信されるため 1 回に固定し、失敗時の扱いは runTurn 内で完結させる。
    await this.schedule(0, 'runTurn', request, { retry: { maxAttempts: 1 } })
    return true
  }

  /**
   * イベントを処理済みとして記録する。同じイベントが並行して届いても true になるのは 1 回だけ。
   * @returns 初めて受け付けたイベントなら true
   */
  #markProcessed(eventId: string, now: number): boolean {
    // this.sql は同期 API で、判定と記録の間に await を挟まないので DO の中で競合しない。
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
   * schedule のコールバック。1 ターンを生成して返信する。
   * 生成に失敗してもフォールバック文言で返信する。
   */
  async runTurn(request: TurnRequest): Promise<void> {
    const startedAt = Date.now()
    // saveMessages から onChatMessage までは 1 ターンずつ進む（_runExclusiveChatTurn が
    // 直列化する）ので、インスタンスに置いて受け渡しても他のターンと混ざらない。
    this.#now = request.now
    const { lastTurnAt } = this.state
    this.setState({ lastTurnAt: request.now })

    // 壊れた応答が履歴に残るとモデルがそれを踏襲して回復しなくなるので、
    // 手動で断ち切れるようにする。
    if (request.text.trim() === RESET_COMMAND) {
      await this.#reset()
      trace('reset.done', {})
      await replyText(createMessagingClient(this.env), request.replyToken, RESET_TEXT)
      return
    }

    // 時間が空いた後の発言はたいてい新しい話題で、古い履歴は文脈として効かない。
    // 壊れた応答が残っていればモデルがそれを踏襲するし、毎ターン送るトークンも減る。
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

    // 無言だとユーザーには不具合と区別がつかないので、失敗しても返信する。
    // 空文字は LINE が受け付けないので、生成失敗と同じくフォールバック文言に倒す。
    const text = reply.length > 0 ? reply : FALLBACK_TEXT
    await replyText(createMessagingClient(this.env), request.replyToken, text)
    trace('reply.sent', { askMs, totalMs: Date.now() - startedAt })
  }

  /** 会話履歴を捨てる。 */
  async #reset(): Promise<void> {
    // saveMessages は書き込みが onChatMessage を起動して生成まで走らせてしまうので、
    // 書き込みだけを行う persistMessages を使う。
    // 空配列を渡すだけでは既存の行が残るため _deleteStaleRows で消す。
    await this.persistMessages([], [], { _deleteStaleRows: true })
  }

  /** 発言を履歴に足して生成し、返答の本文を返す。 */
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

    return assistantText(this.messages).trim()
  }
}
