import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat'
import { convertToModelMessages, type LanguageModel, pruneMessages, streamText } from 'ai'
import { abortAfter } from './abort'
import { systemPrompt } from './ai/prompt'
import { createMessagingClient, replyText } from './line/client'
import { trace } from './trace'

// Workers AI のモデル（gemma-4・glm-4.7-flash・llama-4-scout・qwen3.8）は
// 数字の脱落、ツールを呼べない、Markdown を混ぜる指示違反などで品質が足りなかった。
const MODEL_ID = 'claude-sonnet-5-5'
/**
 * 1 回の応答で web 検索できる回数。検索は 1 回ごとに課金され、待ち時間も延びる。
 * 言い換えて検索し直す程度の余地は残す。
 */
const MAX_WEB_SEARCHES = 3
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
// Anthropic の資格情報（BYOK）はこの gateway の Provider Keys に登録する。
const AI_GATEWAY_ID = 'claude'
/**
 * 1 回の応答で使える出力トークン。thinking のトークンもここに含まれる。
 * 返答の長さはプロンプトで 300 文字程度に絞っているので、上限は thinking の分を
 * 見込んで余裕を持たせる。
 */
const MAX_OUTPUT_TOKENS = 4096
/**
 * 生成を打ち切るまでの時間。reply token の有効期限が 1 分なので、
 * これを超えた返答はもう届けられない。打ち切ってフォールバック文言を返す方がよい。
 * 過去に Workers AI のモデルで thinking が暴走して 300 秒走り続けた記録がある
 * （DO の alarm は 15 分動ける）。
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
   * テストは runInDurableObject でこのメソッドを差し替え、AI Gateway には繋がない。
   */
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

  /**
   * モデルが呼べるツール。最新情報を要する質問のときに web 検索させる。
   * Anthropic のサーバツールなので、検索は API の中で行われ、検索 → 最終応答まで
   * 1 回のモデル呼び出しで完結する（こちらで execute する必要は無い）。
   */
  #tools() {
    return {
      web_search: anthropic.tools.webSearch_20260209({
        maxUses: MAX_WEB_SEARCHES,
        // 日本の利用者向けに、地域に関わる検索結果を寄せる。
        userLocation: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' },
      }),
    }
  }

  // _onFinish は SDK 内部の全呼び出し元が no-op を渡す死んだ引数なので使わない。
  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const result = streamText({
      model: await this.createModel(),
      // ここで new Date() を呼ぶと、alarm 起動直後は前回のターンの時刻が返る。
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
