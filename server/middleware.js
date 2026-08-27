// 鉴权 / 限流 / 安全头 中间件。
import crypto from 'node:crypto'
import { DEVICE_TOKEN_HEADER, WINDOW_MS, MAX_REQUESTS_PER_MINUTE, MAX_CHAT_REQUESTS_PER_MINUTE, CORS_ORIGINS } from './config.js'
import { getUserIdByToken, createUserByToken } from './db.js'

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
      'Content-Type, Authorization, x-device-token, Accept, Cache-Control',
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
 * 从请求中提取设备 token：优先读自定义请求头，其次尝试 Authorization: Bearer。
 * @param {import('express').Request} req
 * @returns {string} 提取到的 token，未找到时返回空串
 */
function getTokenFromRequest(req) {
  const tokenFromHeader = String(req.headers[DEVICE_TOKEN_HEADER] || '').trim()
  if (tokenFromHeader) {
    return tokenFromHeader
  }

  const authHeader = String(req.headers.authorization || '').trim()
  if (!authHeader) {
    return ''
  }

  const matched = authHeader.match(/^Bearer\s+(.+)$/i)
  return matched?.[1]?.trim() || ''
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
 * 仅对 /api/models 做 token 引导：若无有效 token 则生成并写入 users 表，
 * 再通过响应头 x-device-token 返回给前端。其它路径直接放行。
 */
async function ensureToken(req, res, next) {
  if (req.path !== '/api/models') {
    return next()
  }

  try {
    let token = getTokenFromRequest(req)
    if (token) {
      const userId = await getUserIdByToken(token)
      if (!userId) {
        token = ''
      }
    }

    if (!token) {
      token = generateDeviceToken()
      await createUserByToken(token)
    }

    req.deviceToken = token
    res.setHeader('x-device-token', token)
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
