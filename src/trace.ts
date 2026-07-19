/**
 * 各段階の所要時間を記録する。返信がどこまで進んだかを追うための計測で、
 * ask.done は出ているのに reply.sent が無ければ生成後・送信前で失敗したと判断できる。
 * 発言内容そのものは記録しない（長さだけ）。
 *
 * JSON で出すと Workers Observability が構造化ログとして展開し、
 * $metadata.message ではなく stage などのフィールドとして問い合わせできる。
 */
export const trace = (stage: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ stage, ...fields }))
}
