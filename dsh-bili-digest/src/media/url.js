import { BiliDigestError } from '../errors.js'
import { compact } from '../json.js'

/** 裸 BV 号：`BV` 前缀（`bv` 也接受）+ 10 位 base58 字符。body 大小写敏感。 */
const BV_RE = /^[Bb][Vv]([0-9A-Za-z]{10})$/
/** 裸 av 号。 */
const AV_RE = /^[Aa][Vv](\d+)$/
/** 链接路径里的 BV 号；后接边界，避免把超长串截断成 10 位。 */
const BV_IN_PATH_RE = /\/([Bb][Vv])([0-9A-Za-z]{10})(?![0-9A-Za-z])/

/** host 白名单：B 站主站/子域、短链、国际站。 */
const ALLOWED_HOSTS = ['bilibili.com', 'b23.tv', 'bilibili.tv']

/** host 是否属白名单（含子域，且防 `evil-bilibili.com` 这类后缀伪造）。 */
function hostAllowed(host) {
  const h = host.toLowerCase()
  return ALLOWED_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`))
}

/**
 * URL 是否在允许范围内：http(s) + 白名单 host。
 * 这是安全控制而非便利：yt-dlp 拿到 `file:` 一类 URL 能读本地文件，必须挡掉。
 * @param url 待校验 URL
 * @returns 是否放行
 */
export function isAllowed(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return hostAllowed(parsed.hostname)
}

/**
 * 把用户输入归一化成 yt-dlp 能吃的 URL。纯函数、零 I/O，不做网络请求
 * （`b23.tv` 短链原样透传，交给 yt-dlp 跟随跳转）。
 *
 * BV 号只规整 `BV` 前缀大小写，body 原样保留：body 是大小写敏感标识符，
 * 改写大小写会指向另一个视频，不做也做不到从全小写输入还原规范大小写。
 *
 * @param raw 用户输入：BV号 / av号 / 完整 URL / b23.tv 短链
 * @returns {{ url: string, bvid: string|null, page: number }}
 * @throws BiliDigestError BAD_INPUT（不可识别）/ UNSUPPORTED_URL（协议或站点不允许）
 */
export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') {
    throw new BiliDigestError('BAD_INPUT', '没有给出视频地址', '用法：/bilisum <BV号|链接>')
  }

  // 裸 BV 号
  const bv = BV_RE.exec(text)
  if (bv) {
    const bvid = `BV${bv[1]}`
    return compact({ url: `https://www.bilibili.com/video/${bvid}`, bvid, page: 1 })
  }

  // 裸 av 号
  const av = AV_RE.exec(text)
  if (av) {
    const url = `https://www.bilibili.com/video/av${av[1]}`
    return compact({ url, bvid: null, page: 1 })
  }

  // URL 形态
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new BiliDigestError('BAD_INPUT', `无法识别为视频地址：${text}`, '支持 BV号 / av号 / 完整链接')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BiliDigestError('UNSUPPORTED_URL', `不支持的协议：${parsed.protocol}`, '只支持 http(s) 的 B 站链接')
  }
  if (!hostAllowed(parsed.hostname)) {
    throw new BiliDigestError('UNSUPPORTED_URL', `不支持的站点：${parsed.hostname}`, 'P0 只支持 B 站（bilibili.com / b23.tv）')
  }

  const pageRaw = Number(parsed.searchParams.get('p'))
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
  // 只保留 p，其余（t、spm_id_from、vd_source 等）丢掉，避免把跟踪参数传给 yt-dlp
  if (page > 1) parsed.searchParams.set('p', String(page))
  else parsed.searchParams.delete('p')
  for (const key of [...parsed.searchParams.keys()]) {
    if (key !== 'p') parsed.searchParams.delete(key)
  }

  const inPath = BV_IN_PATH_RE.exec(parsed.pathname)
  return compact({
    url: parsed.toString(),
    bvid: inPath ? `BV${inPath[2]}` : null,
    page,
  })
}
