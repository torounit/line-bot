/**
 * 処理の段階と付随する値を 1 行の構造化ログとして出す。発言内容そのものは渡さない（長さだけ）。
 * ask.done があって reply.sent が無ければ、生成後・送信前で失敗したと分かる。
 */
export const trace = (stage: string, fields: Record<string, unknown>): void => {
  // JSON で出すと Workers Observability が構造化ログとして展開し、
  // $metadata.message ではなく stage などのフィールドとして問い合わせできる。
  console.log(JSON.stringify({ stage, ...fields }))
}
