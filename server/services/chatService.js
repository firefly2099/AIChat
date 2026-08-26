// 聊天相关纯函数与服务。
import {
  DEEPSEEK_ERROR_MESSAGE_MAP,
  DEEPSEEK_API_KEY,
  DEEPSEEK_API_BASE_URL,
  QWEN_API_KEY,
  QWEN_API_BASE_URL,
} from '../config.js'

function sanitizeIds(raw) {
  if (!Array.isArray(raw)) return []
  const set = new Set()
  for (const it of raw) {
    const s = String(it || '').trim()
    if (s) set.add(s)
  }
  return Array.from(set)
}

/**
 * 清洗模型 ID，阻止注入或非法参数。
 * 只保留字母、数字、点、下划线和连字符。
 * @param {string} modelId 输入的模型字符串
 * @returns {string} 清洗后的模型 ID
 */
function sanitizeModelId(modelId) {
  const raw = String(modelId || 'deepseek-v3').trim()
  return raw.replace(/[^a-zA-Z0-9._\-]/g, '')
}

/**
 * 将上游返回的错误体标准化成统一结构，方便后续返回给前端。
 * 兼容 DeepSeek 的 { error: { message, code } } 和通用 { message } 两种写法。
 * @param {Response} response 上游 HTTP 响应
 * @param {string} rawBody 原始响应文本
 * @returns {{ status: number, code: number | string, message: string }}
 */
function normalizeUpstreamError(response, rawBody) {
  let payload = null

  try {
    payload = rawBody ? JSON.parse(rawBody) : null
  } catch (error) {
    payload = null
  }

  const detailMessage = payload?.error?.message || payload?.message || rawBody || '模型服务暂时不可用。'
  const code = payload?.error?.code || payload?.code || response.status

  return {
    status: response.status,
    code,
    message: String(detailMessage).trim() || '模型服务暂时不可用。',
  }
}

/**
 * 根据状态码生成更友好的业务错误说明，且保留上游返回的细节。
 * @param {number} statusCode HTTP 状态码
 * @param {string} detail 细节说明
 * @returns {string}
 */
function getFriendlyErrorMessage(statusCode, detail = '') {
  const baseMessage = DEEPSEEK_ERROR_MESSAGE_MAP[statusCode] || '模型服务暂时不可用，请稍后再试。'

  if (!detail) {
    return baseMessage
  }

  return `${baseMessage} 详情：${detail}`
}

/**
 * 解析查询参数中的布尔值。
 * @param {unknown} value
 * @returns {boolean}
 */
function parseBooleanQuery(value) {
  const raw = String(value || '').trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

/**
 * 根据“深度思考/智能搜索”开关构建上游提示上下文。
 * 通过提示词注入而不是新增未知参数，避免不同 provider 的参数校验失败。
 * @param {string} message
 * @param {boolean} thinkingEnabled
 * @param {boolean} searchEnabled
 * @returns {string}
 */
function buildFeaturePrompt(message, thinkingEnabled, searchEnabled) {
  const lines = []

  if (thinkingEnabled) {
    lines.push('请启用深度思考模式：先给出结构化推理，再输出结论。')
  }

  if (searchEnabled) {
    lines.push('请启用智能搜索模式：在答案中尽量给出可核实的信息来源方向。')
  }

  if (!lines.length) {
    return message
  }

  return `${lines.join('\n')}\n\n用户问题：${message}`
}

/**
 * 根据模型名返回对应的上游 provider 配置和请求模型名。
 * 当前支持 DeepSeek 与 Qwen 两种 provider。
 * @param {string} modelId 原始模型 ID
 * @returns {{key: string | undefined, baseUrl: string, keyName: string, requestModel: string, label: string}}
 */
function getProviderConfig(modelId) {
  const normalized = sanitizeModelId(modelId)

  if (normalized.startsWith('deepseek')) {
    return {
      key: DEEPSEEK_API_KEY,
      baseUrl: DEEPSEEK_API_BASE_URL,
      keyName: 'DEEPSEEK_API_KEY',
      requestModel: normalized === 'deepseek-v3' ? 'deepseek-v4-flash' : normalized,
      label: 'deepseek',
    }
  }

  return {
    key: QWEN_API_KEY,
    baseUrl: QWEN_API_BASE_URL,
    keyName: 'QWEN_API_KEY',
    requestModel: normalized === 'qwen3-7b'
      ? 'qwen3-7b'
      : normalized === 'qwen3-7b-plus'
        ? 'qwen3-7b-plus'
        : normalized === 'qwen3-7b-flash'
          ? 'qwen3-7b-flash'
          : normalized,
    label: 'qwen',
  }
}

/**
 * 将 base64 data URL 形式的图片上传到 DeepSeek Files API，返回 file_id。
 * 图片输入需配合 deepseek-v4-flash-vision-exp 模型，并在对话中用 file content block 引用 file_id。
 * 文档：POST {baseUrl}/files，multipart/form-data，字段 file + purpose=user_data。
 * @param {string} dataUrl 形如 data:image/jpeg;base64,xxxx
 * @param {string} [mime] MIME 类型，缺省时从 dataUrl 头部推断
 * @param {string} apiKey DeepSeek API Key
 * @returns {Promise<string>} file_id（形如 file-api-...）
 */
async function uploadImageToDeepSeekFiles(dataUrl, mime, apiKey) {
  const commaIdx = dataUrl.indexOf(',')
  const header = commaIdx >= 0 ? dataUrl.slice(0, commaIdx) : ''
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : ''
  const matched = header.match(/data:([^;]+)/)
  const inferredMime = mime || (matched && matched[1]) || 'image/jpeg'
  const subType = inferredMime.split('/')[1] || 'jpeg'
  const ext = subType === 'jpeg' ? 'jpg' : subType
  const buffer = Buffer.from(base64, 'base64')
  // Node 18+ 全局 FormData / Blob：fetch 传 FormData 会自动以 multipart/form-data 发送
  const form = new FormData()
  form.append('purpose', 'user_data')
  form.append('file', new Blob([buffer], { type: inferredMime }), `upload.${ext}`)
  const res = await fetch(`${DEEPSEEK_API_BASE_URL.replace(/\/$/, '')}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`图片上传至 DeepSeek 失败(${res.status})：${text.slice(0, 200)}`)
  }
  const data = await res.json()
  if (!data.id) {
    throw new Error('DeepSeek Files API 未返回 file_id。')
  }
  return data.id
}

export {
  sanitizeIds,
  sanitizeModelId,
  normalizeUpstreamError,
  getFriendlyErrorMessage,
  parseBooleanQuery,
  buildFeaturePrompt,
  getProviderConfig,
  uploadImageToDeepSeekFiles,
}
