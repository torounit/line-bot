/**
 * タイムアウトと、呼び出し元から渡された中断シグナルを束ねる。
 * どちらか早い方で中断される。
 */
export const abortAfter = (ms: number, signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
