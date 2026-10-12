import { BiliDigestError } from './errors.js'

const AUDIO_QUALITY = ['balanced', 'smallest', 'best']
const LANGS = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** 数字类配置的公共前置检查：必须是有限 number。
 *  只做范围比较是不够的——`'30' >= 30` 在 JS 里成立，YAML 里手滑写成
 *  `windowSeconds: "30"` 就会把字符串原样交给下游。 */
const num = (v) => typeof v === 'number' && Number.isFinite(v)

/** 每个字段的校验：返回 null 表示通过，否则返回中文问题描述。 */
const VALIDATORS = {
  command: (v) => (/^[a-z][a-z0-9_-]*$/.test(v) ? null : '必须是小写字母开头的命令名'),
  outputDir: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  cacheDir: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  language: (v) => (LANGS.includes(v) ? null : `必须是 ${LANGS.join('/')} 之一`),
  preferredSubtitleLang: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  windowSeconds: (v) => (num(v) && v >= 30 && v <= 60 ? null : '必须是 30–60 之间的数字（上限 60 是实测结论，见规格 F19）'),
  snapSeconds: (v) => (num(v) && v >= 0 && v <= 5 ? null : '必须是 0–5 之间的数字'),
  minSegmentSeconds: (v) => (num(v) && v >= 1 && v <= 30 ? null : '必须是 1–30 之间的数字'),
  audioQuality: (v) => (AUDIO_QUALITY.includes(v) ? null : `必须是 ${AUDIO_QUALITY.join('/')} 之一`),
  proxy: (v) => (typeof v === 'string' ? null : '必须是字符串：空串=直连，system=跟随系统，其它=代理 URL'),
  toolDownloadProxy: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  ytDlpPath: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  ffmpegPath: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  sttProvider: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  summaryModel: (v) =>
    v && typeof v === 'object' && typeof v.provider === 'string' && typeof v.model === 'string'
      ? null
      : '必须是 { provider: string, model: string }',
  waitSeconds: (v) => (num(v) && v >= 0 && v <= 120 ? null : '必须是 0–120 之间的数字'),
  maxDurationSec: (v) => (num(v) && v >= 60 ? null : '必须是 >= 60 的数字'),
  maxKeyPoints: (v) => (num(v) && Number.isInteger(v) && v >= 3 && v <= 20 ? null : '必须是 3–20 之间的整数'),
  keepTranscript: (v) => (typeof v === 'boolean' ? null : '必须是布尔值'),
}

const DEFAULTS = {
  command: 'bilisum',
  outputDir: '',
  cacheDir: '',
  language: 'auto',
  preferredSubtitleLang: 'zh-Hans',
  windowSeconds: 30,
  snapSeconds: 1.5,
  minSegmentSeconds: 5,
  audioQuality: 'balanced',
  proxy: '',
  toolDownloadProxy: 'system',
  ytDlpPath: '',
  ffmpegPath: '',
  sttProvider: '',
  summaryModel: { provider: '', model: '' },
  waitSeconds: 45,
  maxDurationSec: 14400,
  maxKeyPoints: 8,
  keepTranscript: true,
}

/**
 * 归一化并校验配置。手写而非用 Schemastery：第三方插件不 import @deepseek-ai/*（规格 F11）。
 * @param raw profile 里的 config 对象
 * @returns 完整配置；越界抛 BAD_CONFIG
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BiliDigestError('BAD_CONFIG', '配置必须是一个对象', '检查 profile 的 cordis.patch.yml')
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      throw new BiliDigestError('BAD_CONFIG', `未知配置项：${key}`, `可用项：${Object.keys(DEFAULTS).join(', ')}`)
    }
  }
  const out = {}
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key] === undefined ? fallback : raw[key]
    const problem = VALIDATORS[key](value)
    if (problem) {
      throw new BiliDigestError('BAD_CONFIG', `配置项 ${key} 非法：${problem}`, `当前值：${JSON.stringify(value)}`)
    }
    // summaryModel 复制一份，避免调用方后续改动影响已解析配置
    out[key] = key === 'summaryModel' ? { provider: value.provider, model: value.model } : value
  }
  return out
}
