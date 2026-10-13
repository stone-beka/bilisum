import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePcmWav, buildPcmWav } from '../src/audio/window.js'

/** 造一个带额外 LIST chunk 的 WAV，模拟 ffmpeg 的真实输出。 */
function wavWithListChunk(samples, sampleRate = 16000) {
  const dataLen = samples.length * 2
  const listBody = Buffer.from('INFOISFT\x08\x00\x00\x00Lavf58.29\x00')
  const listLen = 8 + listBody.length
  const total = 12 + 24 + listLen + 8 + dataLen
  const buf = Buffer.alloc(total)
  let o = 0
  buf.write('RIFF', o); o += 4
  buf.writeUInt32LE(total - 8, o); o += 4
  buf.write('WAVE', o); o += 4
  buf.write('fmt ', o); o += 4
  buf.writeUInt32LE(16, o); o += 4
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt32LE(sampleRate, o); o += 4
  buf.writeUInt32LE(sampleRate * 2, o); o += 4
  buf.writeUInt16LE(2, o); o += 2
  buf.writeUInt16LE(16, o); o += 2
  buf.write('LIST', o); o += 4
  buf.writeUInt32LE(listBody.length, o); o += 4
  listBody.copy(buf, o); o += listBody.length
  buf.write('data', o); o += 4
  buf.writeUInt32LE(dataLen, o); o += 4
  for (const s of samples) { buf.writeInt16LE(s, o); o += 2 }
  return buf
}

test('parsePcmWav 能解析带 LIST chunk 的 WAV（chunk 顺序不固定）', () => {
  const samples = Int16Array.from([1, -2, 3, -4])
  const parsed = parsePcmWav(wavWithListChunk(samples))
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.bits, 16)
  assert.deepEqual([...parsed.samples], [1, -2, 3, -4])
})

test('parsePcmWav 拒绝非 WAV', () => {
  assert.throws(() => parsePcmWav(Buffer.from('not a wav at all...............')), (e) => e.code === 'WAV_MALFORMED')
})

test('buildPcmWav 产出逐字节规范的头', () => {
  const samples = Int16Array.from([100, -100])
  const out = buildPcmWav(samples, 16000)
  const b = Buffer.from(out)
  assert.equal(b.length, 48)
  assert.equal(b.toString('ascii', 0, 4), 'RIFF')
  assert.equal(b.readUInt32LE(4), 48 - 8)
  assert.equal(b.toString('ascii', 8, 12), 'WAVE')
  assert.equal(b.toString('ascii', 12, 16), 'fmt ')
  assert.equal(b.readUInt32LE(16), 16)
  assert.equal(b.readUInt16LE(20), 1)
  assert.equal(b.readUInt16LE(22), 1)
  assert.equal(b.readUInt32LE(24), 16000)
  assert.equal(b.readUInt32LE(28), 32000)
  assert.equal(b.readUInt16LE(32), 2)
  assert.equal(b.readUInt16LE(34), 16)
  assert.equal(b.toString('ascii', 36, 40), 'data')
  assert.equal(b.readUInt32LE(40), 4)
  assert.equal(b.readInt16LE(44), 100)
  assert.equal(b.readInt16LE(46), -100)
})

test('buildPcmWav 对奇数样本数丢弃最后一个（validateWave 要求 (len-44)%2===0）', () => {
  const out = buildPcmWav(Int16Array.from([1, 2, 3]), 16000)
  assert.equal(Buffer.from(out).length, 44 + 4)
})

test('buildPcmWav 接受 Int16Array 的 subarray 视图', () => {
  const backing = Int16Array.from([9, 9, 5, 6, 9])
  const out = buildPcmWav(backing.subarray(2, 4), 16000)
  assert.equal(Buffer.from(out).readInt16LE(44), 5)
  assert.equal(Buffer.from(out).readInt16LE(46), 6)
})

test('parsePcmWav 与 buildPcmWav 往返一致', () => {
  const samples = Int16Array.from([7, -7, 1234, -1234])
  const parsed = parsePcmWav(buildPcmWav(samples, 16000))
  assert.deepEqual([...parsed.samples], [...samples])
})

/**
 * 追加用例（不替换上面的规格测试）。ffmpeg 的 LIST 体长度实测常为奇数，
 * 而 RIFF 规定 chunk 必须按偶数字节对齐——漏掉这个 pad 就会把 data 定位错 1 字节。
 */
function wavWithOddListChunk(samples, sampleRate = 16000) {
  const dataLen = samples.length * 2
  const listBody = Buffer.from('INFOISFT\x05\x00\x00\x00Lavf5') // 17 字节，奇数
  const padded = listBody.length + (listBody.length % 2)
  const total = 12 + 24 + 8 + padded + 8 + dataLen
  const buf = Buffer.alloc(total)
  let o = 0
  buf.write('RIFF', o); o += 4
  buf.writeUInt32LE(total - 8, o); o += 4
  buf.write('WAVE', o); o += 4
  buf.write('fmt ', o); o += 4
  buf.writeUInt32LE(16, o); o += 4
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt32LE(sampleRate, o); o += 4
  buf.writeUInt32LE(sampleRate * 2, o); o += 4
  buf.writeUInt16LE(2, o); o += 2
  buf.writeUInt16LE(16, o); o += 2
  buf.write('LIST', o); o += 4
  buf.writeUInt32LE(listBody.length, o); o += 4
  listBody.copy(buf, o); o += listBody.length
  o += listBody.length % 2 // pad 字节保持为 0
  buf.write('data', o); o += 4
  buf.writeUInt32LE(dataLen, o); o += 4
  for (const s of samples) { buf.writeInt16LE(s, o); o += 2 }
  return buf
}

test('parsePcmWav 处理奇数长度 chunk 的偶数字节对齐', () => {
  const parsed = parsePcmWav(wavWithOddListChunk(Int16Array.from([11, -12, 13])))
  assert.deepEqual([...parsed.samples], [11, -12, 13])
})

test('parsePcmWav 不依赖 fmt 在 data 之前（data 先出现也认）', () => {
  const samples = Int16Array.from([21, -22])
  const dataLen = samples.length * 2
  const total = 12 + 8 + dataLen + 24
  const buf = Buffer.alloc(total)
  let o = 0
  buf.write('RIFF', o); o += 4
  buf.writeUInt32LE(total - 8, o); o += 4
  buf.write('WAVE', o); o += 4
  buf.write('data', o); o += 4
  buf.writeUInt32LE(dataLen, o); o += 4
  for (const s of samples) { buf.writeInt16LE(s, o); o += 2 }
  buf.write('fmt ', o); o += 4
  buf.writeUInt32LE(16, o); o += 4
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt32LE(16000, o); o += 4
  buf.writeUInt32LE(32000, o); o += 4
  buf.writeUInt16LE(2, o); o += 2
  buf.writeUInt16LE(16, o); o += 2
  const parsed = parsePcmWav(buf)
  assert.equal(parsed.sampleRate, 16000)
  assert.deepEqual([...parsed.samples], [21, -22])
})

test('parsePcmWav 对非 PCM16（8bit / float）抛 WAV_MALFORMED', () => {
  const bad = wavWithListChunk(Int16Array.from([1, 2]))
  bad.writeUInt16LE(8, 34) // bitsPerSample = 8
  assert.throws(() => parsePcmWav(bad), (e) => e.code === 'WAV_MALFORMED')
})

test('buildPcmWav 默认采样率就是 ASR 要求的 16000（省略第二参也规范）', () => {
  const b = Buffer.from(buildPcmWav(Int16Array.from([5, 6])))
  assert.equal(b.readUInt32LE(24), 16000)
  assert.equal(b.readUInt32LE(28), 32000)
  assert.equal(b.readUInt16LE(22), 1)
  assert.equal(b.readUInt16LE(34), 16)
  assert.equal(b.length, 44 + 4)
})

test('buildPcmWav 的 data 声明长度与补齐后的尾部字节数一致（逐字节自洽）', () => {
  const out = buildPcmWav(Int16Array.from([1, 2, 3]), 16000)
  const b = Buffer.from(out)
  assert.equal(b.readUInt32LE(40), b.length - 44)
  assert.equal(b.readUInt32LE(4), b.length - 8)
})
