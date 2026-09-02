// 会话数据访问层：MySQL 连接池 + token/users/sessions/messages 读写。
import mysql from 'mysql2/promise'
import {
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASS,
  DB_NAME,
} from './config.js'

const dbPool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  connectTimeout: 10_000,
  acquireTimeout: 10_000,
  timeout: 30_000,
})

// token → userId 内存缓存，避免每个请求都走 MySQL。
// token 是设备指纹，几乎不变；TTL 10 分钟。
const tokenCache = new Map()
const TOKEN_CACHE_TTL = 10 * 60 * 1000

/**
 * 初始化数据库表结构（users / chat_sessions / chat_messages），
 * 并对老库做轻量迁移：补 pinned 列与对应索引。
 * @returns {Promise<void>}
 */
async function ensureTables() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      token VARCHAR(128) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_users_token (token)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id VARCHAR(64) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      model_id VARCHAR(128) NOT NULL,
      thinking_enabled TINYINT(1) NOT NULL DEFAULT 0,
      search_enabled TINYINT(1) NOT NULL DEFAULT 0,
      pinned TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_chat_sessions_user_id (user_id),
      KEY idx_chat_sessions_user_pinned (user_id, pinned),
      CONSTRAINT fk_chat_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // 升级已有用户表：给 chat_sessions 加 pinned 字段和索引
  // 注：MySQL 5.x/某些 MariaDB 不支持 ADD COLUMN IF NOT EXISTS，改成先查询列/索引是否存在再执行。
  try {
    const [cols] = await dbPool.query(
      "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_sessions' AND COLUMN_NAME = 'pinned'",
    )
    const pinnedColExists = Number(Array.isArray(cols) ? cols[0]?.c : 0) > 0
    if (!pinnedColExists) {
      await dbPool.query('ALTER TABLE chat_sessions ADD COLUMN pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER search_enabled')
      console.log('[migration] chat_sessions: 已新增 pinned 列')
    }
    const [idxs] = await dbPool.query(
      "SELECT COUNT(*) AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_sessions' AND INDEX_NAME = 'idx_chat_sessions_user_pinned'",
    )
    const pinIdxExists = Number(Array.isArray(idxs) ? idxs[0]?.c : 0) > 0
    if (!pinIdxExists) {
      await dbPool.query('ALTER TABLE chat_sessions ADD INDEX idx_chat_sessions_user_pinned (user_id, pinned)')
      console.log('[migration] chat_sessions: 已新增 idx_chat_sessions_user_pinned 索引')
    }
  } catch (alterError) {
    console.warn('[migration] chat_sessions pinned 迁移失败:', alterError?.message || alterError)
  }

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      session_id VARCHAR(64) NOT NULL,
      role ENUM('user','assistant') NOT NULL,
      content MEDIUMTEXT NOT NULL,
      sort_order INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_chat_messages_session_id (session_id),
      CONSTRAINT fk_chat_messages_session FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // 微信小程序用户表：存 openid / nickname / avatar
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS wx_users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      openid VARCHAR(64) NOT NULL,
      nickname VARCHAR(128) NOT NULL DEFAULT '',
      avatar_url VARCHAR(512) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_wx_users_openid (openid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // 升级已有库：把 chat_messages.content 由 TEXT 扩为 MEDIUMTEXT，
  // 避免长文档（含中文/emoji 多字节）写入时被 65KB 限制截断或报错。
  try {
    const [col] = await dbPool.query(
      "SELECT DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_messages' AND COLUMN_NAME = 'content'",
    )
    const dataType = String(Array.isArray(col) ? col[0]?.t : '').toLowerCase()
    if (dataType === 'text') {
      await dbPool.query('ALTER TABLE chat_messages MODIFY COLUMN content MEDIUMTEXT NOT NULL')
      console.log('[migration] chat_messages: content 已由 TEXT 升级为 MEDIUMTEXT')
    }
  } catch (alterError) {
    console.warn('[migration] chat_messages content 类型升级失败:', alterError?.message || alterError)
  }

  // R2 图片存储计数表：记录已用容量，达免费额度 90% 后停止上传
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS storage_stats (
      id TINYINT UNSIGNED NOT NULL DEFAULT 1,
      total_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // 迁移：给 chat_messages 加 image_urls 列（JSON 数组，存 R2 公开 URL）
  try {
    const [cols] = await dbPool.query(
      "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_messages' AND COLUMN_NAME = 'image_urls'",
    )
    const colExists = Number(Array.isArray(cols) ? cols[0]?.c : 0) > 0
    if (!colExists) {
      await dbPool.query('ALTER TABLE chat_messages ADD COLUMN image_urls TEXT NULL DEFAULT NULL AFTER content')
      console.log('[migration] chat_messages: 已新增 image_urls 列')
    }
  } catch (alterError) {
    console.warn('[migration] chat_messages image_urls 迁移失败:', alterError?.message || alterError)
  }
}

/**
 * 按 token 查询用户 ID。
 * @param {string} token 设备 token
 * @returns {Promise<number | null>} 用户 ID，未找到时返回 null
 */
async function getUserIdByToken(token) {
  const normalized = String(token || '').trim()
  if (!normalized) {
    return null
  }

  const cached = tokenCache.get(normalized)
  if (cached && Date.now() - cached.t < TOKEN_CACHE_TTL) {
    return cached.id
  }

  const [rows] = await dbPool.query('SELECT id FROM users WHERE token = ? LIMIT 1', [normalized])
  const row = Array.isArray(rows) ? rows[0] : null
  const id = row?.id ? Number(row.id) : null
  if (id) {
    tokenCache.set(normalized, { id, t: Date.now() })
  }
  return id
}

/**
 * 按 token 创建新用户，返回其用户 ID。
 * @param {string} token 设备 token
 * @returns {Promise<number | null>} 新建用户的 ID，token 为空时返回 null
 */
async function createUserByToken(token) {
  const normalized = String(token || '').trim()
  if (!normalized) {
    return null
  }

  await dbPool.query('INSERT INTO users (token) VALUES (?)', [normalized])
  return getUserIdByToken(normalized)
}

/**
 * 将数据库行（session + messages）映射为前端使用的 payload 结构。
 * @param {{ id: string, title: string, model_id: string, thinking_enabled: number, search_enabled: number, pinned: number, created_at: string, updated_at: string }} sessionRow
 * @param {Array<{ id: number, role: string, content: string }>} messageRows
 * @returns {{ id: string, title: string, modelId: string, thinkingEnabled: boolean, searchEnabled: boolean, pinned: boolean, messages: Array<{ id: number, role: string, content: string }>, createdAt: string, updatedAt: string }}
 */
function sessionToPayload(sessionRow, messageRows) {
  return {
    id: String(sessionRow.id),
    title: String(sessionRow.title || '新对话'),
    modelId: String(sessionRow.model_id || 'deepseek-v3'),
    thinkingEnabled: Boolean(sessionRow.thinking_enabled),
    searchEnabled: Boolean(sessionRow.search_enabled),
    pinned: Boolean(sessionRow.pinned),
    messages: (messageRows || []).map((item) => {
      // image_urls 存为 JSON 字符串，解析失败时返回空数组
      let imageUrls = []
      if (item.image_urls) {
        try {
          const parsed = JSON.parse(item.image_urls)
          if (Array.isArray(parsed)) {
            imageUrls = parsed.filter((u) => typeof u === 'string' && u)
          }
        } catch {
          // 非 JSON 格式，忽略
        }
      }
      return {
        id: Number(item.id),
        role: item.role,
        content: String(item.content || ''),
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      }
    }),
    createdAt: sessionRow.created_at,
    updatedAt: sessionRow.updated_at,
  }
}

/**
 * 读取单个会话详情（含消息列表）。
 * 仅返回属于该用户且存在的会话，否则返回 null。
 * @param {number} userId 用户 ID
 * @param {string} sessionId 会话 ID
 * @returns {Promise<object | null>}
 */
async function loadSessionDetailById(userId, sessionId) {
  const [sessionRows] = await dbPool.query(
    'SELECT id, title, model_id, thinking_enabled, search_enabled, pinned, created_at, updated_at FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1',
    [sessionId, userId],
  )
  const sessionRow = Array.isArray(sessionRows) ? sessionRows[0] : null
  if (!sessionRow) {
    return null
  }

  const [messageRows] = await dbPool.query(
    'SELECT id, role, content, sort_order, image_urls FROM chat_messages WHERE session_id = ? ORDER BY sort_order ASC, id ASC',
    [sessionId],
  )

  return sessionToPayload(sessionRow, Array.isArray(messageRows) ? messageRows : [])
}

/**
 * 微信小程序：按 openid 查询或创建用户。
 * 复用现有 users 表（token = openid），保证会话/消息接口无需改动。
 * @param {string} openid 微信 openid
 * @returns {Promise<number | null>} 用户 ID
 */
async function getOrCreateUserByOpenid(openid) {
  const normalized = String(openid || '').trim()
  if (!normalized) return null

  // 先查 tokenCache（openid 即 token）
  const cached = tokenCache.get(normalized)
  if (cached && Date.now() - cached.t < TOKEN_CACHE_TTL) {
    return cached.id
  }

  // 查 users 表
  let userId = await getUserIdByToken(normalized)
  if (!userId) {
    userId = await createUserByToken(normalized)
  }
  return userId
}

/**
 * 微信小程序：保存或更新微信用户资料（昵称、头像）。
 * @param {string} openid
 * @param {string} nickname
 * @param {string} avatarUrl
 * @returns {Promise<void>}
 */
async function upsertWxUser(openid, nickname, avatarUrl) {
  const normalizedOpenid = String(openid || '').trim()
  if (!normalizedOpenid) return

  await dbPool.query(
    `INSERT INTO wx_users (openid, nickname, avatar_url)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), avatar_url = VALUES(avatar_url)`,
    [normalizedOpenid, String(nickname || '').slice(0, 128), String(avatarUrl || '').slice(0, 512)],
  )
}

/**
 * 微信小程序：按 openid 查询微信用户资料。
 * @param {string} openid
 * @returns {Promise<{ openid: string, nickname: string, avatarUrl: string } | null>}
 */
async function getWxUserByOpenid(openid) {
  const normalized = String(openid || '').trim()
  if (!normalized) return null

  const [rows] = await dbPool.query(
    'SELECT openid, nickname, avatar_url FROM wx_users WHERE openid = ? LIMIT 1',
    [normalized],
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) return null

  return {
    openid: String(row.openid),
    nickname: String(row.nickname || ''),
    avatarUrl: String(row.avatar_url || ''),
  }
}

export {
  dbPool,
  ensureTables,
  getUserIdByToken,
  createUserByToken,
  sessionToPayload,
  loadSessionDetailById,
  getOrCreateUserByOpenid,
  upsertWxUser,
  getWxUserByOpenid,
}
