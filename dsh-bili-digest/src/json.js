/**
 * 无损 JSON 出口。
 *
 * DSH 宿主对工具/命令返回值做**运行时**无损 JSON 校验：一个值为 undefined 的键
 * 会让整次调用被判 `value is not lossless JSON` 而拒收。单测里假的 register
 * 不会校验，所以规则是「所有出口统一过 compact()」，而不是在每个构造点记得删字段。
 *
 * 数组里的 undefined 会被 JSON.stringify 转成 null，属合法 JSON，故保留不删——
 * 删元素会破坏下标语义。
 */

/**
 * 递归剥离对象中值为 undefined 的键。
 * @param value 任意值
 * @returns 剥离后的新值；标量原样返回
 */
export function compact(value) {
  if (Array.isArray(value)) return value.map((item) => compact(item))
  // Buffer / TypedArray / ArrayBuffer 是二进制，不是可递归的普通对象：
  // `Object.entries(Buffer)` 给出 {'0':..,'1':..}，会把 PCM 摊成字节下标对象
  // （既毁掉音频，也会把几百 MB 的缓冲撑成几千万个键）。原样返回。
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = compact(item)
    }
    return out
  }
  return value
}
