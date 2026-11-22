import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat'
import { convertToModelMessages, type LanguageModel, pruneMessages, streamText } from 'ai'
import { abortAfter } from './abort'
import { systemPrompt } from './ai/prompt'
import { createMessagingClient, replyText } from './line/client'
import { trace } from './trace'

const MODEL_ID = 'claude-sonnet-5-5'
/** 1 回の応答で web 検索できる回数。 */
// 検索は 1 回ごとに課金され待ち時間も延びる。検索し直す余地だけ残す。
const MAX_WEB_SEARCHES = 3
/** この文言だけを送ると会話履歴を捨てる。 */
const RESET_COMMAND = 'リセット'
const RESET_TEXT = '会話履歴をリセットしました。'
/** 最後の発言からこれだけ空いたら、次の発言の前に会話履歴を捨てる。 */
const IDLE_RESET_MS = 6 * 60 * 60 * 1000
/** Anthropic の資格情報（BYOK）を登録してある AI Gateway の ID。 */
const AI_GATEWAY_ID = 'claude'
/** 1 回の応答で使える出力トークン。thinking のトークンも含む。 */
// 返答は 300 文字程度なので、残りは thinking の分。
const MAX_OUTPUT_TOKENS = 4096
/** 生成を打ち切るまでの時間。 */
// reply token の有効期限（1 分）に収める。
const GENERATION_TIMEOUT_MS = 45_000
/** 生成に失敗したときの返答。 */
const FALLBACK_TEXT = 'ごめんなさい、いまうまく返事ができませんでした。もう一度話しかけてください。'
/** 処理済みの webhookEventId を覚えておく期間。この期間内に届いた再送だけを捨てる。 */
const PROCESSED_EVENT_TTL_MS = 24 * 60 * 60 * 1000

/** 1 ターン分の依頼。schedule の payload として JSON で保存される。 */
export type TurnRequest = {
  text: string
  replyToken: string
  /** LINE の webhookEventId。再送されても同じ値で届くので、重複の判定に使う。 */
  eventId: string
  /** webhook を受けた時点の時刻（epoch ms）。DO の中では Date.now() の代わりに使う。 */
  now: number
}

/** 最後の assistant メッセージの text パートを連結する。 */
const assistantText = (messages: { role: string; parts: { type: string }[] }[]): string => {
  // SDK の同等の処理は private なので再実装する。
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
  // 再開しても reply token が失効していて届かない。
  chatRecovery = false

  /** 進行中のターンの TurnRequest.now。 */
  #now: number | undefined

  /** 生成に使うモデルを返す。テストは runInDurableObject でこのメソッドを差し替える。 */
  protected async createModel(): Promise<LanguageModel> {
    // テスト用の環境が AI バインディングを持たないので型上は optional。
    const { AI } = this.env
    if (!AI) throw new Error('AI binding is not configured')

    // AI Gateway を通すのはモデル呼び出しのログを残すため。キャッシュは会話履歴を
    // 含むリクエストではほぼ当たらないので使わない。
    // バインディングは URL を得るためだけに使い、認証は cf-aig-authorization で行う。
    const baseURL = `${await AI.gateway(AI_GATEWAY_ID).getUrl('anthropic')}/v1`
    return createAnthropic({
      baseURL,
      // API キーは AI Gateway 側が持つ。provider は apiKey が必須なのでダミーを渡し、
      // Gateway がそれを資格情報に使わないよう x-api-key ヘッダは消す。
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
      // サーバツールなので検索は API の中で完結し、こちらで execute しない。
      web_search: anthropic.tools.webSearch_20260209({
        maxUses: MAX_WEB_SEARCHES,
        // 地域に関わる検索結果を日本に寄せる。
        userLocation: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' },
      }),
    }
  }

  /**
   * 1 ターンぶんのモデルの応答をストリームで返す。
   * @param _onFinish 使わない（SDK は常に no-op を渡す）。
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
        // thinking の署名は system プロンプトとそれまでの履歴に紐づく。現在時刻入りの
        // system プロンプトや履歴の刈り込みで前提が変わると 400 になるので、すべて落とす。
        reasoning: 'all',
        toolCalls: 'before-last-2-messages',
      }),
      tools: this.#tools(),
      abortSignal: abortAfter(GENERATION_TIMEOUT_MS, options?.abortSignal),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 1,
      providerOptions: {
        anthropic: {
          // Sonnet 5.5 は thinking を無効にできないので、effort で浅くする（既定は high）。
          effort: 'low',
          // 安全分類器に断られたら別のモデルで答えさせる。断られたままだと本文が空になる。
          fallbacks: 'default',
        },
      },
    })

    // 平文 Response だと基底クラスがチャンク単位でデコードし、マルチバイト文字が化ける。
    return result.toUIMessageStreamResponse()
  }

  /**
   * webhook からの入口。生成を待たずに runTurn をスケジュールして即座に返る。
   * @returns 受け付けたら true、処理済みのイベントの再送なら false
   */
  async startTurn(request: TurnRequest): Promise<boolean> {
    // 失敗したターンも runTurn が返信して完結させるので、受け付けた時点で記録してよい。
    if (!this.#markProcessed(request.eventId, request.now)) return false

    // Worker の waitUntil（30 秒）では生成に余裕が無いので、alarm（15 分）で走らせる。
    // 再実行されると LINE へ重複送信されるので、リトライはしない。
    await this.schedule(0, 'runTurn', request, { retry: { maxAttempts: 1 } })
    return true
  }

  /**
   * イベントを処理済みとして記録する。
   * @returns 初めて受け付けたイベントなら true。並行して届いても true は 1 回だけ。
   */
  #markProcessed(eventId: string, now: number): boolean {
    // this.sql は同期 API なので、判定と記録の間に他のリクエストは割り込まない。
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
    // ターンは直列に進むので、インスタンスに置いても他のターンと混ざらない。
    this.#now = request.now
    const { lastTurnAt } = this.state
    this.setState({ lastTurnAt: request.now })

    // 壊れた応答が履歴に残るとモデルがそれを踏襲するので、手動で断ち切れるようにする。
    if (request.text.trim() === RESET_COMMAND) {
      await this.#reset()
      trace('reset.done', {})
      await replyText(createMessagingClient(this.env), request.replyToken, RESET_TEXT)
      return
    }

    // 時間が空いた後はたいてい新しい話題で、古い履歴は文脈として効かない。
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

    // 空文字は LINE が受け付けないので、失敗と同じくフォールバック文言にする。
    const text = reply.length > 0 ? reply : FALLBACK_TEXT
    await replyText(createMessagingClient(this.env), request.replyToken, text)
    trace('reply.sent', { askMs, totalMs: Date.now() - startedAt })
  }

  /** 会話履歴を捨てる。 */
  async #reset(): Promise<void> {
    // saveMessages は生成まで走らせるので persistMessages を使う。
    // 空配列だけでは既存の行が残るので _deleteStaleRows で消す。
    await this.persistMessages([], [], { _deleteStaleRows: true })
  }

  /** 発言を履歴に足して生成し、返答の本文を返す。 */
  async #generate(text: string): Promise<string> {
    // 関数形はターンロックの内側で走るので、並行して届いても最新の履歴に足せる。
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
