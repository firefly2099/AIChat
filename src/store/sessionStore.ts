// 会话状态与本地持久化层：pinia store + 跨路由附件暂存 + 消息附件扩展信息。
import { defineStore } from 'pinia'

export type SessionMessage = {
  id: number
  role: 'user' | 'assistant'
  content: string
}

export type Session = {
  id: string
  title: string
  modelId: string
  thinkingEnabled?: boolean
  searchEnabled?: boolean
  messages: SessionMessage[]
  createdAt?: string
  updatedAt?: string
  pinned?: boolean
}

const MAX_TITLE_LENGTH = 36

export const useSessionStore = defineStore('session', {
  state: () => ({
    sessionMap: {} as Record<string, Session>,
  }),
  getters: {
    sessionList(state) {
      return Object.values(state.sessionMap).sort((a, b) => {
        const pinA = a.pinned ? 1 : 0
        const pinB = b.pinned ? 1 : 0
        if (pinA !== pinB) return pinB - pinA
        const timeA = new Date(a.updatedAt || 0).getTime()
        const timeB = new Date(b.updatedAt || 0).getTime()
        return timeB - timeA
      })
    },
  },
  actions: {
    saveSession(session: Session) {
      this.sessionMap[session.id] = {
        ...(this.sessionMap[session.id] || {}),
        ...session,
      }
    },
    getSession(sessionID: string) {
      return this.sessionMap[sessionID]
    },
    replaceSessions(sessions: Session[]) {
      const next: Record<string, Session> = {}
      for (const session of sessions) {
        next[session.id] = session
      }
      this.sessionMap = next
    },
    updateSessionTitleLocal(sessionID: string, title: string) {
      const target = this.sessionMap[sessionID]
      if (!target) {
        return
      }

      this.sessionMap[sessionID] = {
        ...target,
        title,
        updatedAt: new Date().toISOString(),
      }
    },
    removeSession(sessionID: string) {
      if (!this.sessionMap[sessionID]) {
        return
      }

      const next = { ...this.sessionMap }
      delete next[sessionID]
      this.sessionMap = next
      // 同步清理本地附件扩展信息，避免 localStorage 残留
      clearMessageExtras(sessionID)
    },
  },
})

/**
 * 根据用户输入生成会话标题。
 */
export function buildSessionTitleByPrompt(prompt: string) {
  const normalized = String(prompt || '').trim().replace(/\s+/g, ' ')
  if (!normalized) {
    return '新对话'
  }

  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, MAX_TITLE_LENGTH)}...`
}

/**
 * 生成新的会话 ID
 * 使用加密安全的随机 UUID，避免可预测的会话 ID 被构造后用于劫持
 * （createSession/saveSnapshot 的 upsert 会按 id 匹配，弱 ID 有被猜中风险）
 */
export function createSessionId() {
  // crypto.randomUUID 在现代浏览器（secure context）中全局可用
  return crypto.randomUUID()
}

/**
 * 保存或更新某个会话
 */
export function saveSession(session: Session) {
  useSessionStore().saveSession(session)
}

/**
 * 获取某个会话
 */
export function getSession(sessionID: string) {
  return useSessionStore().getSession(sessionID)
}

/**
 * 按更新时间倒序返回历史会话。
 */
export function getSessionList() {
  return useSessionStore().sessionList
}

/**
 * 批量写入会话，用于初始化或刷新侧边栏历史。
 */
export function replaceSessions(sessions: Session[]) {
  useSessionStore().replaceSessions(sessions)
}

// 首页 → 聊天页跨路由暂存的待处理附件（仅内存，刷新即失效）。
// 路由 query 无法承载 File / base64 图片，故用模块级 Map 中转。
const pendingAttachmentsMap = new Map<string, File[]>()

/**
 * 暂存某会话的待处理附件（首页发送时调用）。
 */
export function setPendingAttachments(sessionID: string, files: File[]) {
  pendingAttachmentsMap.set(sessionID, files)
}

/**
 * 取出并清除某会话的暂存附件（聊天页恢复会话时调用）。
 */
export function takePendingAttachments(sessionID: string): File[] | undefined {
  const files = pendingAttachmentsMap.get(sessionID)
  if (files) pendingAttachmentsMap.delete(sessionID)
  return files
}

/**
 * 消息附件扩展信息：图片 base64 / 文件元信息 / 提取文本。
 * 后端 chat_messages 表不存这些字段（避免 base64 与大段文本撑爆库），
 * 故仅 localStorage 持久化，刷新后按下标合并回消息。
 */
export type MessageExtras = {
  attachments?: { url: string; mime: string }[]
  files?: { name: string; size: number }[]
  fileContext?: string
  imageUrls?: string[]
}

const MSG_EXTRAS_PREFIX = 'aichat_msg_extras:'

/**
 * 保存某会话的消息附件扩展信息（按下标对齐快照消息数组顺序）。
 */
export function saveMessageExtras(sessionID: string, extrasByIndex: Record<number, MessageExtras>) {
  if (typeof window === 'undefined') return
  const keys = Object.keys(extrasByIndex)
  if (keys.length === 0) {
    window.localStorage.removeItem(MSG_EXTRAS_PREFIX + sessionID)
    return
  }
  try {
    window.localStorage.setItem(MSG_EXTRAS_PREFIX + sessionID, JSON.stringify(extrasByIndex))
  } catch (error) {
    // 配额超限等异常：静默丢弃，不影响主流程
    console.warn('保存消息附件扩展失败:', error)
  }
}

/**
 * 读取某会话的消息附件扩展信息，用于刷新后合并回消息。
 */
export function loadMessageExtras(sessionID: string): Record<number, MessageExtras> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(MSG_EXTRAS_PREFIX + sessionID)
    return raw ? (JSON.parse(raw) as Record<number, MessageExtras>) : {}
  } catch {
    return {}
  }
}

/**
 * 清除某会话的消息附件扩展信息（删除会话时调用）。
 */
export function clearMessageExtras(sessionID: string) {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(MSG_EXTRAS_PREFIX + sessionID)
}
