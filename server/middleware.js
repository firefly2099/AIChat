// 鉴权 / 限流 / 安全头 中间件。
import crypto from 'node:crypto'
import { DEVICE_TOKEN_HEADER, WINDOW_MS, MAX_REQUESTS_PER_MINUTE, MAX_CHAT_REQUESTS_PER_MINUTE, CORS_ORIGINS } from './config.js'
import { getUserIdByToken, createUserByToken, getTokenByFingerprint, setUserFingerprint } from './db.js'

// Cookie 中 device token 的键名
const DEVICE_TOKEN_COOKIE = 'aichat_device_token'
// 前端请求头中的浏览器指纹键名（与前端 FINGERPRINT_HEADER 保持一致）
const FINGERPRINT_HEADER = 'x-fingerprint'
// Cookie 有效期：1 年（秒）。清浏览记录通常不会连带清 Cookie，只要不主动清站点数据就能保留。
const COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60

/**
 * 从请求中提取浏览器指纹（同步）。
 * @param {import('express').Request} req
 */
function getFingerprintFromRequest(req) {
  return String(req.headers[FINGERPRINT_HEADER] || '').trim()
}

/**
 * 创建一个独立的 IP 限流中间件，各自维护独立的请求时间戳桶（互不影响）。
 * 仅用 req.ip（已由 app.set('trust proxy') 解析真实客户端 IP），不读 x-forwarded-for 以防伪造。
 * @param {number} max 每窗口期最大请求数
 * @param {number} windowMs 窗口期（毫秒）
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter(max, windowMs) {
  const buckets = new Map()
  return (req, res, next) => {
    const ip = String(req.ip || 'unknown')
    const now = Date.now()
    const bucket = buckets.get(ip) || []
    const valid = bucket.filter((time) => now - time < windowMs)
    if (valid.length >= max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' })
    }
    valid.push(now)
    buckets.set(ip, valid)
    next()
  }
}

// 本地开发默认白名单（Vite dev server 5173 + 预览 4173）。
const DEFAULT_LOCAL_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173']

/**
 * 判定来源是否在 CORS 白名单内。
 * - 默认本地开发端口（5173/4173）
 * - process.env.CORS_ORIGINS 配置的域名（逗号分隔）
 * - *.vercel.app（Vercel 预览部署与生产部署通配）
 * @param {string | undefined} origin
 * @returns {boolean}
 */
function isOriginAllowed(origin) {
  if (!origin) return false
  if (DEFAULT_LOCAL_ORIGINS.includes(origin)) return true
  if (CORS_ORIGINS.includes(origin)) return true
  // Vercel 预览/生产域名（支持多级子域名，如 xxx.vercel.app 或 xxx.yyy.vercel.app）
  if (/^https:\/\/(?:[-a-z0-9]+\.)*vercel\.app$/i.test(origin)) return true
  return false
}

/**
 * CORS 中间件。前端部署到 Vercel 后，域名不再与后端同源，必须放行跨域。
 * - 预检 OPTIONS 直接 204 带头返回；
 * - 非预检请求只在白名单内附头，不带 Vary: Origin 避免缓存混乱。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function corsMiddleware(req, res, next) {
  const origin = String(req.headers.origin || '')
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-device-token, x-fingerprint, Accept, Cache-Control',
    )
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, OPTIONS, PATCH',
    )
    // 预检 2 小时内不用再发，减少 Vercel 冷启动开销
    res.setHeader('Access-Control-Max-Age', '7200')
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }
  next()
}

// 常规 API（会话读写、快照保存、模型列表）：较宽松，覆盖正常使用的高频读写。
const rateLimit = createRateLimiter(MAX_REQUESTS_PER_MINUTE, WINDOW_MS)
// 聊天流式：每次都回源 DeepSeek，单独收紧防止 API Key 被刷爆。
const chatRateLimit = createRateLimiter(MAX_CHAT_REQUESTS_PER_MINUTE, WINDOW_MS)

/**
 * 生成随机设备 token（24 字节 hex）。
 * @returns {string}
 */
function generateDeviceToken() {
  return crypto.randomBytes(24).toString('hex')
}

/**
 * 从请求中提取 device token：
 * 优先级：自定义请求头 x-device-token > Authorization Bearer > Cookie。
 * 设计意图：localStorage 存一份（加载快、前端可读到），Cookie 存一份（持久化兜底清缓存场景）。
 * @param {import('express').Request} req
 * @returns {string} 提取到的 token，未找到时返回空串
 */
function getTokenFromRequest(req) {
  const tokenFromHeader = String(req.headers[DEVICE_TOKEN_HEADER] || '').trim()
  if (tokenFromHeader) {
    return tokenFromHeader
  }

  const authHeader = String(req.headers.authorization || '').trim()
  if (authHeader) {
    const matched = authHeader.match(/^Bearer\s+(.+)$/i)
    if (matched?.[1]) {
      return matched[1].trim()
    }
  }

  // localStorage 被清时的回退：只要没清 Cookie 就能恢复身份
  const fromCookie = String(req.cookies?.[DEVICE_TOKEN_COOKIE] || '').trim()
  return fromCookie
}

/**
 * 强鉴权中间件：无有效 token 直接 401，鉴权通过则把 userId/deviceToken 挂到 req。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
async function requireAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req)
    if (!token) {
      return res.status(401).json({ error: 'Missing token' })
    }

    const userId = await getUserIdByToken(token)
    if (!userId) {
      return res.status(401).json({ error: 'Invalid token' })
    }

    req.userId = userId
    req.deviceToken = token
    next()
  } catch (error) {
    console.error('Auth failed:', error)
    return res.status(500).json({ error: '鉴权失败，请稍后重试。' })
  }
}

/**
 * 全局安全头，减少 XSS、点击劫持和缓存泄露风险。
 */
function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-XSS-Protection', '0')
  res.setHeader('Cache-Control', 'no-store')
  next()
}

/**
 * 仅对 /api/models 做 token 引导。
 * 身份恢复优先级：
 *   ① x-device-token / Authorization 请求头 —— 前端 localStorage 写入，立即生效
 *   ② aichat_device_token Cookie（1 年持久化）—— 清浏览记录、localStorage 丢失的兜底
 *   ③ 浏览器指纹（x-fingerprint）—— 清「Cookie 和站点数据」全清场景的最后兜底；
 *       仅 fingerprint 在 users 表 1:1 命中时才恢复（≥2 条即碰撞，不恢复以免串账号）
 * 都没命中时才创建新用户，并把浏览器指纹绑定到新建用户。
 */
async function ensureToken(req, res, next) {
  if (req.path !== '/api/models') {
    return next()
  }

  try {
    const fingerprint = getFingerprintFromRequest(req)

    // ① 先取 header + cookie 里已有 token
    let token = getTokenFromRequest(req)
    if (token) {
      const userId = await getUserIdByToken(token)
      if (!userId) token = ''
    }

    // ② header/cookie 都没命中，尝试指纹恢复
    let source = 'header-or-cookie'
    if (!token && fingerprint) {
      const recovered = await getTokenByFingerprint(fingerprint)
      if (recovered) {
        token = recovered
        source = 'fingerprint'
      }
    }

    // ③ 都没命中 → 创建新用户；把 fingerprint 一并绑定到 DB（如存在）
    if (!token) {
      token = generateDeviceToken()
      await createUserByToken(token, fingerprint || undefined)
      source = fingerprint ? 'new-user-with-fp' : 'new-user'
    } else if (fingerprint) {
      // 用 header/cookie 拿到了 token，但 fingerprint 可能是空值；顺手给这条 user 把 fingerprint 补上，
      // 下次清站点数据时就能靠指纹找回。
      await setUserFingerprint(token, fingerprint)
    }

    req.deviceToken = token
    res.setHeader('x-device-token', token)
    // 持久 Cookie 兜底：HttpOnly 防 JS 窃取，前后端跨域必须 SameSite=None + Secure。
    res.cookie(DEVICE_TOKEN_COOKIE, token, {
      maxAge: COOKIE_MAX_AGE_SEC * 1000,
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
    })
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[ensureToken] source=${source} token=${token.slice(0, 8)}…`)
    }
    next()
  } catch (error) {
    console.error('Token bootstrap failed:', error)
    res.status(500).json({ error: '初始化 token 失败，请稍后重试。' })
  }
}

export {
  generateDeviceToken,
  getTokenFromRequest,
  corsMiddleware,
  requireAuth,
  securityHeadersMiddleware,
  ensureToken,
  rateLimit,
  chatRateLimit,
}
