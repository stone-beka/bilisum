/** dsh-bili-digest 的分类错误。hint 是给用户看的中文补救建议。 */
export class BiliDigestError extends Error {
  /**
   * @param code 见 spec §9 的错误码
   * @param message 给开发者看的描述
   * @param hint 给用户看的补救建议
   * @param cause 原始错误
   */
  constructor(code, message, hint, cause) {
    super(message)
    this.name = 'BiliDigestError'
    this.code = code
    this.hint = hint
    this.cause = cause
  }

  /** String(err) 为 message（见 brief Interfaces）。 */
  toString() {
    return this.message
  }
}

/**
 * 把任意抛出物转成命令的 error 结果。命令 handler 绝不抛异常到宿主。
 * @param err 任意抛出物
 * @returns {{ kind:'error', text:string }}
 */
export function toCommandError(err) {
  if (err instanceof BiliDigestError) {
    const text = err.hint ? `❌ ${err.message}\n${err.hint}` : `❌ ${err.message}`
    return { kind: 'error', text }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { kind: 'error', text: `❌ ${message}` }
}
