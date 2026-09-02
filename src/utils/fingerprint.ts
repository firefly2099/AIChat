/**
 * 浏览器设备指纹：基于 UA/屏幕/时区/CPU 核心/平台等稳定特征，
 * 计算 64 位十六进制的 SHA-256。用于「清 localStorage + 清 Cookie + 清站点数据」
 * 之后的身份恢复。
 *
 * 设计原则：
 * - 稳定性：特征选择尽量不随日常操作变化（避开窗口大小、缩放比例等易变项）
 * - 区分度：多重特征混合，使不同设备的碰撞概率足够低
 * - 零依赖：只用 Web 标准 API，不引入第三方库
 *
 * 使用方式：
 *   import { getDeviceFingerprint, FINGERPRINT_HEADER } from '@/utils/fingerprint'
 *   const fp = await getDeviceFingerprint()  // 结果会做模块级缓存
 */

export const FINGERPRINT_HEADER = 'x-fingerprint'

/** 模块级缓存，一个会话内计算一次即可。 */
let cachedFingerprint: string | null = null

/**
 * 收集一组稳定的浏览器特征，拼成字符串。
 * 选择的特征必须：
 *   ① 相同设备多次读取不变；② 足够区分不同设备/浏览器组合。
 */
function collectStableFeatures(): string {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator)
  const scr = typeof screen !== 'undefined' ? screen : ({} as Screen)

  const ua       = nav.userAgent ?? ''
  const platform = nav.platform ?? ''
  const vendor   = nav.vendor ?? ''
  const language = nav.language ?? ''
  // 语言列表：能区分地区相近的浏览器，对结果稳定性几乎无影响
  const languages = Array.isArray((nav as any).languages) ? (nav as any).languages.join(',') : ''
  // CPU 核心数：区分 i5/i7/移动设备
  const hardwareConcurrency = String((nav as any).hardwareConcurrency ?? 0)
  // 设备内存：GB 级别，区分 8GB/16GB/32GB 机器
  const deviceMemory = String((nav as any).deviceMemory ?? 0)
  // 屏幕信息：只取 width/height/colorDepth（不包括 availTop 这些会变的）
  const screenInfo = [scr.width, scr.height, scr.colorDepth, scr.pixelDepth].join('x')
  // 时区偏移（分钟，负数即东八区 -480）
  const tzOffset = String(new Date().getTimezoneOffset())
  // 触控支持：移动端 vs 桌面端
  const touchPoints = String(nav.maxTouchPoints ?? 0)
  // 是否支持 WebGL（对是否独立显卡也有粗略区分，不需要实际绘制）
  const hasWebGL = String(Boolean(
    typeof document !== 'undefined' &&
    document.createElement('canvas').getContext?.('webgl'),
  ))

  return [
    ua,
    platform,
    vendor,
    language,
    languages,
    hardwareConcurrency,
    deviceMemory,
    screenInfo,
    tzOffset,
    touchPoints,
    hasWebGL,
  ].join('||')
}

/**
 * 把任意字符串按 SHA-256 输出 64 hex。
 * 优先走 crypto.subtle（浏览器支持度足够），不可用时退回简单 64bit FNV 拼 4 轮凑 16 hex，
 * 并在末尾补 '0' 到 64 位保证长度一致（不要求碰撞安全，仅避免后端字段长度不足）。
 */
async function sha256Hex(input: string): Promise<string> {
  const subtle = (typeof crypto !== 'undefined' && (crypto as any).subtle) as SubtleCrypto | undefined
  if (subtle) {
    const data = new TextEncoder().encode(input)
    const digest = await subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  // 回退：FNV-1a 64 位（用字符串哈希 + 截断），16 字符 + 尾 0 补满 64。
  // 仅作为极旧浏览器的兼容兜底，不参与实际碰撞概率计算。
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const hex1 = h.toString(16).padStart(8, '0')
  let h2 = 0xdeadbeef
  for (let i = input.length - 1; i >= 0; i--) {
    h2 ^= input.charCodeAt(i)
    h2 = Math.imul(h2, 0x01000193) >>> 0
  }
  const hex2 = h2.toString(16).padStart(8, '0')
  return (hex1 + hex2 + hex1 + hex2 + hex1 + hex2 + hex1 + hex2).padEnd(64, '0').slice(0, 64)
}

/**
 * 获取当前设备浏览器指纹（SHA-256，64 字符十六进制）。
 * 结果做模块级缓存，单次会话计算成本可忽略。
 */
export async function getDeviceFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint
  const features = collectStableFeatures()
  cachedFingerprint = await sha256Hex(features)
  return cachedFingerprint
}
