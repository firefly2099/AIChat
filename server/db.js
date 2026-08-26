// 会话数据访问层：MySQL 连接池 + token/users/sessions/messages 读写。
import mysql from 'mysql2/promise'
import {
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,
} from './config.js'

const dbPool = mysql.createPool({
  host: MYSQL_HOST,
  port: MYSQL_PORT,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  connectionLimit: 10,
  charset: 'utf8mb4',
})

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

  const [rows] = await dbPool.query('SELECT id FROM users WHERE token = ? LIMIT 1', [normalized])
  const row = Array.isArray(rows) ? rows[0] : null
  return row?.id ? Number(row.id) : null
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
    messages: (messageRows || []).map((item) => ({
      id: Number(item.id),
      role: item.role,
      content: String(item.content || ''),
    })),
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
    'SELECT id, role, content, sort_order FROM chat_messages WHERE session_id = ? ORDER BY sort_order ASC, id ASC',
    [sessionId],
  )

  return sessionToPayload(sessionRow, Array.isArray(messageRows) ? messageRows : [])
}

export {
  dbPool,
  ensureTables,
  getUserIdByToken,
  createUserByToken,
  sessionToPayload,
  loadSessionDetailById,
}
