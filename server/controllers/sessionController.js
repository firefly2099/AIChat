// 会话 CRUD + 快照 + 批量路由处理。
import { dbPool, sessionToPayload, loadSessionDetailById } from '../db.js'
import { sanitizeIds, sanitizeModelId } from '../services/chatService.js'
import { MAX_MESSAGE_LENGTH } from '../config.js'

/**
 * 列出当前用户所有会话（按置顶 + 更新时间倒序），含每个会话的消息。
 */
async function listSessions(req, res) {
  try {
    const [rows] = await dbPool.query(
      'SELECT id, title, model_id, thinking_enabled, search_enabled, pinned, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC',
      [req.userId],
    )

    const sessions = []
    for (const row of Array.isArray(rows) ? rows : []) {
      const [msgRows] = await dbPool.query(
        'SELECT id, role, content, sort_order FROM chat_messages WHERE session_id = ? ORDER BY sort_order ASC, id ASC',
        [row.id],
      )
      sessions.push(sessionToPayload(row, Array.isArray(msgRows) ? msgRows : []))
    }

    return res.json(sessions)
  } catch (error) {
    console.error('Load sessions failed:', error)
    return res.status(500).json({ error: '读取会话失败，请稍后重试。' })
  }
}

/**
 * 读取单个会话详情（含消息列表）。
 */
async function getSession(req, res) {
  try {
    const sessionId = String(req.params.sessionId || '').trim()
    if (!sessionId) {
      return res.status(400).json({ error: '会话ID不能为空。' })
    }

    const payload = await loadSessionDetailById(req.userId, sessionId)
    if (!payload) {
      return res.status(404).json({ error: '会话不存在。' })
    }

    return res.json(payload)
  } catch (error) {
    console.error('Load session detail failed:', error)
    return res.status(500).json({ error: '读取会话详情失败，请稍后重试。' })
  }
}

/**
 * 创建或覆盖一个会话：upsert chat_sessions 并整体替换其消息列表。
 * 请求体包含 id / title / modelId / thinkingEnabled / searchEnabled / messages。
 */
async function createSession(req, res) {
  try {
    const id = String(req.body?.id || '').trim()
    const title = String(req.body?.title || '新对话').trim() || '新对话'
    const modelId = sanitizeModelId(String(req.body?.modelId || 'deepseek-v3')) || 'deepseek-v3'
    const thinkingEnabled = Boolean(req.body?.thinkingEnabled)
    const searchEnabled = Boolean(req.body?.searchEnabled)
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : []

    if (!id) {
      return res.status(400).json({ error: '会话ID不能为空。' })
    }

    // 归属权校验：id 已存在但不属于当前用户时禁止覆盖，防止会话劫持
    const [existing] = await dbPool.query('SELECT user_id FROM chat_sessions WHERE id = ?', [id])
    if (Array.isArray(existing) && existing.length > 0 && String(existing[0].user_id) !== String(req.userId)) {
      return res.status(403).json({ error: '无权操作该会话。' })
    }

    await dbPool.query(
      `INSERT INTO chat_sessions (id, user_id, title, model_id, thinking_enabled, search_enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         model_id = VALUES(model_id),
         thinking_enabled = VALUES(thinking_enabled),
         search_enabled = VALUES(search_enabled),
         pinned = COALESCE(pinned, 0),
         updated_at = CURRENT_TIMESTAMP`,
      [id, req.userId, title, modelId, thinkingEnabled ? 1 : 0, searchEnabled ? 1 : 0],
    )

    await dbPool.query('DELETE FROM chat_messages WHERE session_id = ?', [id])

    for (let i = 0; i < messages.length; i += 1) {
      const item = messages[i]
      const role = item?.role === 'assistant' ? 'assistant' : 'user'
      const content = String(item?.content || '').slice(0, MAX_MESSAGE_LENGTH)

      await dbPool.query(
        'INSERT INTO chat_messages (session_id, role, content, sort_order) VALUES (?, ?, ?, ?)',
        [id, role, content, i],
      )
    }

    const payload = await loadSessionDetailById(req.userId, id)
    return res.status(201).json(payload)
  } catch (error) {
    console.error('Create session failed:', error)
    return res.status(500).json({ error: '创建会话失败，请稍后重试。' })
  }
}

/**
 * 保存会话快照：整体替换消息列表与基础字段（标题 / 模型 / 开关）。
 * 与 createSession 行为一致，区别在于 URL 带 sessionId、HTTP 语义为 PUT。
 */
async function saveSnapshot(req, res) {
  try {
    const sessionId = String(req.params.sessionId || '').trim()
    if (!sessionId) {
      return res.status(400).json({ error: '会话ID不能为空。' })
    }

    const title = String(req.body?.title || '新对话').trim() || '新对话'
    const modelId = sanitizeModelId(String(req.body?.modelId || 'deepseek-v3')) || 'deepseek-v3'
    const thinkingEnabled = Boolean(req.body?.thinkingEnabled)
    const searchEnabled = Boolean(req.body?.searchEnabled)
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : []

    // 归属权校验：会话已存在但不属于当前用户时禁止覆盖，防止会话劫持
    const [existing] = await dbPool.query('SELECT user_id FROM chat_sessions WHERE id = ?', [sessionId])
    if (Array.isArray(existing) && existing.length > 0 && String(existing[0].user_id) !== String(req.userId)) {
      return res.status(403).json({ error: '无权操作该会话。' })
    }

    await dbPool.query(
      `INSERT INTO chat_sessions (id, user_id, title, model_id, thinking_enabled, search_enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         model_id = VALUES(model_id),
         thinking_enabled = VALUES(thinking_enabled),
         search_enabled = VALUES(search_enabled),
         pinned = COALESCE(pinned, 0),
         updated_at = CURRENT_TIMESTAMP`,
      [sessionId, req.userId, title, modelId, thinkingEnabled ? 1 : 0, searchEnabled ? 1 : 0],
    )

    await dbPool.query('DELETE FROM chat_messages WHERE session_id = ?', [sessionId])

    for (let i = 0; i < messages.length; i += 1) {
      const item = messages[i]
      const role = item?.role === 'assistant' ? 'assistant' : 'user'
      const content = String(item?.content || '').slice(0, MAX_MESSAGE_LENGTH)

      await dbPool.query(
        'INSERT INTO chat_messages (session_id, role, content, sort_order) VALUES (?, ?, ?, ?)',
        [sessionId, role, content, i],
      )
    }

    const payload = await loadSessionDetailById(req.userId, sessionId)
    return res.json(payload)
  } catch (error) {
    console.error('Save session snapshot failed:', error)
    return res.status(500).json({ error: '保存会话失败，请稍后重试。' })
  }
}

/**
 * 仅更新会话标题。
 */
async function updateTitle(req, res) {
  try {
    const sessionId = String(req.params.sessionId || '').trim()
    const title = String(req.body?.title || '').trim() || '新对话'

    if (!sessionId) {
      return res.status(400).json({ error: '会话ID不能为空。' })
    }

    const [result] = await dbPool.query(
      'UPDATE chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [title, sessionId, req.userId],
    )

    if (!result?.affectedRows) {
      return res.status(404).json({ error: '会话不存在。' })
    }

    const payload = await loadSessionDetailById(req.userId, sessionId)
    return res.json(payload)
  } catch (error) {
    console.error('Update title failed:', error)
    return res.status(500).json({ error: '更新标题失败，请稍后重试。' })
  }
}

/**
 * 删除指定会话。
 * chat_messages 通过外键 ON DELETE CASCADE 自动清理，无需单独删除消息。
 */
async function deleteSession(req, res) {
  try {
    const sessionId = String(req.params.sessionId || '').trim()
    if (!sessionId) {
      return res.status(400).json({ error: '会话ID不能为空。' })
    }

    const [result] = await dbPool.query(
      'DELETE FROM chat_sessions WHERE id = ? AND user_id = ?',
      [sessionId, req.userId],
    )

    if (!result?.affectedRows) {
      return res.status(404).json({ error: '会话不存在。' })
    }

    return res.json({ success: true })
  } catch (error) {
    console.error('Delete session failed:', error)
    return res.status(500).json({ error: '删除会话失败，请稍后重试。' })
  }
}

/**
 * 单个会话：置顶/取消置顶
 */
async function pinSession(req, res) {
  try {
    const sessionId = String(req.params.sessionId || '').trim()
    const pinned = req.body?.pinned ? 1 : 0
    if (!sessionId) {
      return res.status(400).json({ error: '会话ID不能为空。' })
    }

    const [result] = await dbPool.query(
      'UPDATE chat_sessions SET pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [pinned, sessionId, req.userId],
    )
    if (!result?.affectedRows) {
      return res.status(404).json({ error: '会话不存在。' })
    }

    const payload = await loadSessionDetailById(req.userId, sessionId)
    return res.json(payload || { id: sessionId, pinned: Boolean(pinned) })
  } catch (error) {
    console.error('Pin session failed:', error)
    return res.status(500).json({ error: '置顶操作失败，请稍后重试。' })
  }
}

/**
 * 批量置顶/取消置顶
 */
async function batchPin(req, res) {
  try {
    const ids = sanitizeIds(req.body?.ids)
    if (!ids.length) {
      return res.status(400).json({ error: '请至少选择一个对话。' })
    }
    const pinned = req.body?.pinned ? 1 : 0
    const placeholders = ids.map(() => '?').join(',')
    const [result] = await dbPool.query(
      `UPDATE chat_sessions SET pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id IN (${placeholders})`,
      [pinned, req.userId, ...ids],
    )
    return res.json({ success: true, updated: Number(result?.affectedRows || 0) })
  } catch (error) {
    console.error('Batch pin sessions failed:', error)
    return res.status(500).json({ error: '批量置顶失败，请稍后重试。' })
  }
}

/**
 * 批量删除
 */
async function batchDelete(req, res) {
  try {
    const ids = sanitizeIds(req.body?.ids)
    if (!ids.length) {
      return res.status(400).json({ error: '请至少选择一个对话。' })
    }
    const placeholders = ids.map(() => '?').join(',')
    const [result] = await dbPool.query(
      `DELETE FROM chat_sessions WHERE user_id = ? AND id IN (${placeholders})`,
      [req.userId, ...ids],
    )
    return res.json({ success: true, deleted: Number(result?.affectedRows || 0) })
  } catch (error) {
    console.error('Batch delete sessions failed:', error)
    return res.status(500).json({ error: '批量删除失败，请稍后重试。' })
  }
}

export {
  listSessions,
  getSession,
  createSession,
  saveSnapshot,
  updateTitle,
  deleteSession,
  pinSession,
  batchPin,
  batchDelete,
}
