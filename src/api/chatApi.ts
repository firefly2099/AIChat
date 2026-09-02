// 后端 API 客户端：device token 管理 + 模型 / 会话 / SSE 头部封装。
import { getDeviceFingerprint, FINGERPRINT_HEADER } from '@/utils/fingerprint'

const DEVICE_TOKEN_KEY = 'aichat_device_token'

/**
 * 请求前缀（开发/生产分离）。
 * - 开发：直连 http://localhost:3001，彻底绕过 Vite dev proxy。
 *   Vite 的 http-proxy 对 POST + SSE 流式响应不稳定（会缓冲/挂死），
 *   开发态直连后端是唯一可靠方案。后端 CORS 已放行 localhost。
 * - 生产：用 VITE_API_BASE_URL 绝对路径（部署后端的公网域名），绕过 Vercel 静态站直连后端。
 *   Vercel 不运行 Express + MySQL，因此生产无法走同源相对路径。
 *   后端 CORS 中间件已配置本地白名单 + *.vercel.app 通配，不会被浏览器拦截。
 */
const API_BASE = (() => {
  if (import.meta.env.DEV) {
    return String(import.meta.env.VITE_DEV_API_BASE || 'http://localhost:3001').replace(/\/$/, '')
  }
  const base = String(import.meta.env.VITE_API_BASE_URL || '').trim()
  // 去掉末尾斜杠，保证 `/api/...` 拼接后不会出现 "//"
  return base.replace(/\/$/, '')
})()

/**
 * 拼接 API 地址：开发前缀空，生产前缀为 VITE_API_BASE_URL。
 * @param {string} path 以 /api/ 开头的相对路径
 * @returns {string} 实际请求 URL
 */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

export type ApiModel = {
  id: string
  label: string
  description: string
  status: string
}

export type ApiSessionMessage = {
  id: number
  role: 'user' | 'assistant'
  content: string
  imageUrls?: string[]
}

export type ApiSessionMessageInput = {
  id?: number
  role: 'user' | 'assistant'
  content: string
  imageUrls?: string[]
}

export type ApiSession = {
  id: string
  title: string
  modelId: string
  thinkingEnabled?: boolean
  searchEnabled?: boolean
  pinned?: boolean
  messages: ApiSessionMessage[]
  createdAt?: string
  updatedAt?: string
}

type RequestOptions = {
  bootstrapToken?: boolean
}

function getStorage() {
  if (typeof window === 'undefined') {
    return null
  }
  return window.localStorage
}

/**
 * 读取本地存储中的设备 token。
 * @returns {string} token，未取到时返回空串
 */
export function getDeviceToken() {
  return getStorage()?.getItem(DEVICE_TOKEN_KEY) || ''
}

function setDeviceToken(token: string) {
  const nextToken = String(token || '').trim()
  if (!nextToken) {
    return
  }
  getStorage()?.setItem(DEVICE_TOKEN_KEY, nextToken)
}

/**
 * 构造所有请求共用的 Headers：device token + 浏览器指纹。
 * 指纹是异步计算的，但只算一次（模块级缓存），因此第二次起几乎无开销。
 */
async function buildHeaders(extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders || {})
  const token = getDeviceToken()

  if (token) {
    headers.set('x-device-token', token)
    headers.set('Authorization', `Bearer ${token}`)
  }

  try {
    const fp = await getDeviceFingerprint()
    if (fp) headers.set(FINGERPRINT_HEADER, fp)
  } catch {
    // 指纹计算失败不阻塞请求：最不济就是按新设备走
  }
  return headers
}

async function parseErrorMessage(response: Response) {
  try {
    const payload = await response.json()
    return payload?.error || payload?.message || `请求失败: ${response.status}`
  } catch {
    const text = await response.text()
    return text || `请求失败: ${response.status}`
  }
}

async function requestJSON<T>(url: string, init: RequestInit = {}, options: RequestOptions = {}) {
  const response = await fetch(url, {
    ...init,
    headers: await buildHeaders(init.headers),
    // 跨域 fetch 必须显式 include，才能把后端（Railway）Set-Cookie 的持久化 token cookie 带上，
    // 否则清 localStorage 后会被当新用户，导致会话丢失。
    credentials: 'include',
  })

  const responseToken = response.headers.get('x-device-token') || ''
  if (responseToken) {
    setDeviceToken(responseToken)
  }

  if (!response.ok) {
    const message = await parseErrorMessage(response)
    throw new Error(message)
  }

  const payload = await response.json()

  if (options.bootstrapToken && payload?.token) {
    setDeviceToken(String(payload.token))
  }

  return payload as T
}

function normalizeModels(items: unknown[]): ApiModel[] {
  return items.map((item, index) => {
    const model = item as Partial<ApiModel>
    const id = String(model.id || `model-${index}`)
    return {
      id,
      label: String(model.label || id),
      description: String(model.description || '当前模型可供使用。'),
      status: String(model.status || '在线'),
    }
  })
}

function normalizeSessionMessage(item: ApiSessionMessageInput, index: number): ApiSessionMessage {
  return {
    id: typeof item.id === 'number' ? item.id : Date.now() + index,
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.content || ''),
    imageUrls: Array.isArray(item.imageUrls) ? item.imageUrls : undefined,
  }
}

function normalizeSession(item: Partial<ApiSession>): ApiSession {
  return {
    id: String(item.id || ''),
    title: String(item.title || '新对话'),
    modelId: String(item.modelId || 'deepseek-v3'),
    thinkingEnabled: Boolean(item.thinkingEnabled),
    searchEnabled: Boolean(item.searchEnabled),
    pinned: Boolean(item.pinned),
    messages: Array.isArray(item.messages) ? item.messages.map((msg, index) => normalizeSessionMessage(msg, index)) : [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

/**
 * 确保本地已有设备 token：无则触发一次 fetchModels 让后端下发并写入。
 * @returns {Promise<string>} 当前有效的设备 token
 */
export async function ensureDeviceToken() {
  if (getDeviceToken()) {
    return getDeviceToken()
  }

  await fetchModels()
  return getDeviceToken()
}

/**
 * 拉取后端可用模型列表，必要时由后端返回并写入 device token。
 * @returns {Promise<ApiModel[]>}
 */
export async function fetchModels() {
  const payload = await requestJSON<{ token?: string; models?: ApiModel[] } | ApiModel[]>(apiUrl('/api/models'), {}, { bootstrapToken: true })

  if (Array.isArray(payload)) {
    return normalizeModels(payload)
  }

  return Array.isArray(payload?.models) ? normalizeModels(payload.models) : []
}

/**
 * 拉取当前用户的全部会话列表。
 * @returns {Promise<ApiSession[]>}
 */
export async function fetchSessions() {
  await ensureDeviceToken()
  const payload = await requestJSON<ApiSession[]>(apiUrl('/api/sessions'))
  return Array.isArray(payload) ? payload.map((item) => normalizeSession(item)) : []
}

/**
 * 按 ID 拉取单个会话详情。
 * @param {string} sessionID 会话 ID
 * @returns {Promise<ApiSession>}
 */
export async function fetchSessionById(sessionID: string) {
  await ensureDeviceToken()
  const payload = await requestJSON<ApiSession>(apiUrl(`/api/sessions/${encodeURIComponent(sessionID)}`))
  return normalizeSession(payload)
}

/**
 * 创建或覆盖一个会话（POST /api/sessions）。
 * @param {object} payload 会话字段（id / title / modelId / 开关 / messages）
 * @returns {Promise<ApiSession>}
 */
export async function createSession(payload: {
  id: string
  title: string
  modelId: string
  thinkingEnabled?: boolean
  searchEnabled?: boolean
  messages?: ApiSessionMessageInput[]
}) {
  await ensureDeviceToken()
  const data = await requestJSON<ApiSession>(apiUrl('/api/sessions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  return normalizeSession(data)
}

/**
 * 保存会话快照：整体替换消息列表与基础字段（PUT /api/sessions/:id/snapshot）。
 * @param {string} sessionID 会话 ID
 * @param {object} payload 快照字段（title / modelId / 开关 / messages）
 * @returns {Promise<ApiSession>}
 */
export async function saveSessionSnapshot(sessionID: string, payload: {
  title: string
  modelId: string
  thinkingEnabled?: boolean
  searchEnabled?: boolean
  messages: ApiSessionMessageInput[]
}) {
  await ensureDeviceToken()
  const data = await requestJSON<ApiSession>(apiUrl(`/api/sessions/${encodeURIComponent(sessionID)}/snapshot`), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  return normalizeSession(data)
}

/**
 * 仅更新会话标题（PATCH /api/sessions/:id/title）。
 * @param {string} sessionID 会话 ID
 * @param {string} title 新标题
 * @returns {Promise<ApiSession>}
 */
export async function updateSessionTitle(sessionID: string, title: string) {
  await ensureDeviceToken()
  const data = await requestJSON<ApiSession>(apiUrl(`/api/sessions/${encodeURIComponent(sessionID)}/title`), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  })
  return normalizeSession(data)
}

/**
 * 删除会话（DELETE /api/sessions/:id）。
 * @param {string} sessionID 会话 ID
 * @returns {Promise<void>}
 */
export async function deleteSession(sessionID: string) {
  await ensureDeviceToken()
  await requestJSON<{ success: boolean }>(apiUrl(`/api/sessions/${encodeURIComponent(sessionID)}`), {
    method: 'DELETE',
  })
}

/**
 * 置顶或取消置顶单个会话（PATCH /api/sessions/:id/pin）。
 * @param {string} sessionID 会话 ID
 * @param {boolean} pinned 是否置顶
 * @returns {Promise<ApiSession>}
 */
export async function pinSession(sessionID: string, pinned: boolean) {
  await ensureDeviceToken()
  const data = await requestJSON<ApiSession>(apiUrl(`/api/sessions/${encodeURIComponent(sessionID)}/pin`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: pinned ? 1 : 0 }),
  })
  return normalizeSession(data)
}

/**
 * 批量置顶/取消置顶会话（POST /api/sessions/batch/pin）。
 * @param {string[]} sessionIds 会话 ID 列表
 * @param {boolean} pinned 是否置顶
 * @returns {Promise<void>}
 */
export async function batchPinSessions(sessionIds: string[], pinned: boolean) {
  await ensureDeviceToken()
  const ids = Array.isArray(sessionIds) ? sessionIds.filter(Boolean) : []
  await requestJSON<{ success: boolean; updated: number }>(apiUrl('/api/sessions/batch/pin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, pinned: pinned ? 1 : 0 }),
  })
}

/**
 * 批量删除会话（POST /api/sessions/batch/delete）。
 * @param {string[]} sessionIds 会话 ID 列表
 * @returns {Promise<void>}
 */
export async function batchDeleteSessions(sessionIds: string[]) {
  await ensureDeviceToken()
  const ids = Array.isArray(sessionIds) ? sessionIds.filter(Boolean) : []
  await requestJSON<{ success: boolean; deleted: number }>(apiUrl('/api/sessions/batch/delete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
}

/**
 * 构造 SSE 流式聊天请求所需的请求头（Accept: text/event-stream + token 鉴权）。
 * @returns {Headers}
 */
export async function buildAuthHeaders() {
  const headers = new Headers({
    Accept: 'text/event-stream',
  })
  const token = getDeviceToken()

  if (token) {
    headers.set('x-device-token', token)
    headers.set('Authorization', `Bearer ${token}`)
  }

  try {
    const fp = await getDeviceFingerprint()
    if (fp) headers.set(FINGERPRINT_HEADER, fp)
  } catch {
    // 指纹失败不阻塞
  }
  return headers
}
