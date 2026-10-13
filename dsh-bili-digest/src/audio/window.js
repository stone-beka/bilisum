import { BiliDigestError } from '../errors.js'

/** 规范 WAV 头长度：RIFF(12) + fmt(24) + data 头(8)。`ctx.speechToText` 逐字节校验。 */
export const CANONICAL_HEADER_BYTES = 44

/** 规范采样率。SenseVoice 只收 16 kHz；`speechToText` 会校验这个字段。 */
const CANONICAL_RATE = 16000

/** fmt chunk 至少要能放下 16 字节的 PCM 描述，否则读字段会越界。 */
const FMT_MIN_BYTES = 16

/** 非 WAV 或结构损坏。hint 必须能让用户判断是解码环节出了问题。 */
function malformed(message, hint) {
  return new BiliDigestError('WAV_MALFORMED', message, hint)
}

/**
 * 解析 PCM WAV。**容忍任意 chunk 顺序**——ffmpeg 会在 fmt 和 data 之间插 LIST/fact，
 * 把 data 推到偏移 78 而不是 44，所以必须走 chunk 表，不能假设固定偏移。
 *
 * RIFF 规定每个 chunk 按偶数字节对齐（奇数长度尾部有 1 个 pad 字节），这个 pad
 * 不算进 size 里；漏掉它会把后面的 chunk 少读 1 字节。
 *
 * 字节序显式按 little-endian 读写（WAV 规定 LE），不依赖 x64 上 TypedArray 的本地序。
 *
 * @param buffer 完整文件字节（Buffer / Uint8Array）
 * @returns {{ sampleRate:number, channels:number, bits:number, samples:Int16Array }}
 * @throws BiliDigestError WAV_MALFORMED（非 WAV / 缺 chunk / 非 PCM16 / 声明长度越界）
 */
export function parsePcmWav(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (b.length < CANONICAL_HEADER_BYTES || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw malformed('不是合法的 WAV 文件', '解码步骤可能产出了空文件或非 WAV 内容。')
  }

  let fmt = null
  let data = null
  let o = 12
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4)
    const size = b.readUInt32LE(o + 4)
    const body = o + 8
    if (id === 'fmt ') {
      if (size < FMT_MIN_BYTES) {
        throw malformed(`fmt chunk 太短（${size} 字节）`, '解码步骤可能提前中断，文件不完整。')
      }
      if (body + FMT_MIN_BYTES > b.length) {
        throw malformed('fmt chunk 超出文件末尾', 'WAV 文件被截断了，重新解码即可。')
      }
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (body + size > b.length) {
        throw malformed('data chunk 声明长度超出文件末尾', 'WAV 文件被截断了，重新解码即可。')
      }
      data = { start: body, size }
    }
    // chunk 按偶数字节对齐：size 为奇数时尾部有 1 个 pad 字节（不计入 size）
    o = body + size + (size % 2)
  }

  if (!fmt || !data) {
    throw malformed('WAV 缺少 fmt 或 data chunk', '解码步骤可能提前中断。')
  }
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw malformed(
      `只支持 PCM16，实得 format=${fmt.format} bits=${fmt.bits}`,
      '这是内部错误，说明 ffmpeg 参数被改动了。',
    )
  }

  const count = Math.floor(data.size / 2)
  const samples = new Int16Array(count)
  for (let i = 0; i < count; i++) samples[i] = b.readInt16LE(data.start + i * 2)
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, samples }
}

/**
 * 构造规范 44 字节头 WAV。
 *
 * DSH 的 speechToText 逐字节校验头部（规格 F7）：RIFF/WAVE/fmt(16)/PCM/mono/16000/
 * byteRate 32000/blockAlign 2/16bit/data，且 (len-44)%2===0。任何偏差都会被直接拒绝。
 *
 * 奇数样本数丢弃最后一个：宁可少 1 个样本（1/16000 秒），也不能产出畸形文件。
 * 数据区手工逐样本写 little-endian，不整块拷贝 samples 的底层内存——这样才能正确处理
 * `Int16Array` 的 subarray 视图（`samples.buffer` 会带上视图之外的部分）。
 *
 * @param samples PCM16 样本（可以是 subarray 视图；只读它的前 length 个元素）
 * @param sampleRate 采样率，默认 16000
 * @returns Uint8Array 逐字节规范的 WAV
 */
export function buildPcmWav(samples, sampleRate = CANONICAL_RATE) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw malformed(`非法采样率：${sampleRate}`, '这是内部错误，说明调用方传错了参数。')
  }
  const usable = samples.length - (samples.length % 2)
  const dataLen = usable * 2
  const total = CANONICAL_HEADER_BYTES + dataLen
  const b = Buffer.allocUnsafe(total)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(total - 8, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * 2, 28) // byteRate = sampleRate × blockAlign
  b.writeUInt16LE(2, 32) // blockAlign = channels × bytesPerSample
  b.writeUInt16LE(16, 34) // bitsPerSample
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(dataLen, 40)
  for (let i = 0; i < usable; i++) b.writeInt16LE(samples[i], CANONICAL_HEADER_BYTES + i * 2)
  return new Uint8Array(b.buffer, b.byteOffset, b.length)
}
