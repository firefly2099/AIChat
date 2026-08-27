// /api/chat/stream 路由处理（SSE 流式 + 图片上传 + 上游超时 + done 事件解析）。
import { MAX_MESSAGE_LENGTH } from '../config.js'
import { getUserIdByToken } from '../db.js'
import { getTokenFromRequest } from '../middleware.js'
import {
  buildFeaturePrompt,
  getProviderConfig,
  uploadImageToDeepSeekFiles,
  normalizeUpstreamError,
  getFriendlyErrorMessage,
  sanitizeModelId,
} from '../services/chatService.js'

/**
 * 流式聊天接口。
 * 负责接收前端的 model + message，并把请求转发给上游大模型 API。
 * 返回的内容使用 text/event-stream，允许前端逐字追加渲染。
 */
async function streamChat(req, res) {
  const t0 = performance.now()
  const token = getTokenFromRequest(req)
  const userId = await getUserIdByToken(token)
  const t1 = performance.now()
  if (!token || !userId) {
    res.status(401)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.write(`data: ${JSON.stringify({ type: 'error', text: '缺少有效 token，请先刷新模型列表。' })}\n\n`)
    res.end()
    return
  }

  req.userId = userId
  req.deviceToken = token
  // 改用 POST body 传参，避免长消息超出 URL 长度限制
  const { model, message, thinkingEnabled: thinkingEnabledRaw, searchEnabled: searchEnabledRaw, images } = req.body || {}
  const safeMessage = String(message || '你好').slice(0, MAX_MESSAGE_LENGTH)
  const thinkingEnabled = Boolean(thinkingEnabledRaw)
  const searchEnabled = Boolean(searchEnabledRaw)
  const messageWithFeatures = buildFeaturePrompt(safeMessage, thinkingEnabled, searchEnabled)
  const promptModel = sanitizeModelId(String(model || 'deepseek-v3'))
  const provider = getProviderConfig(promptModel)

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  if (!provider.key) {
    res.write(`data: ${JSON.stringify({ type: 'error', text: '服务暂未配置模型密钥，请联系管理员。' })}\n\n`)
    res.end()
    return
  }

  try {
    // 构建上游消息：有图片时先走 Files API 上传拿 file_id，再用视觉模型引用；
    // 无图片则纯文本。上传放在 try 内以便错误走统一 SSE 错误出口。
    let requestModel = provider.requestModel
    let upstreamMessages
    if (Array.isArray(images) && images.length > 0) {
      // 只接受 data: 协议的 base64 图片，避免后端去拉取任意外链（SSRF 风险）
      const validImages = images.filter(
        (img) => img && typeof img.url === 'string' && img.url.startsWith('data:'),
      )

      // 单次最多 5 张图片，防止滥用导致上游配额被刷爆
      if (validImages.length > 5) {
        res.write(`data: ${JSON.stringify({ type: 'error', text: '单次最多上传 5 张图片。' })}\n\n`)
        res.end()
        return
      }

      // 单张解码后不能超过 10MB，防止超大 base64 撑爆内存
      const MAX_IMAGE_BYTES = 10 * 1024 * 1024
      for (const img of validImages) {
        const commaIdx = img.url.indexOf(',')
        const base64Part = commaIdx >= 0 ? img.url.slice(commaIdx + 1) : img.url
        if (Buffer.byteLength(base64Part, 'base64') > MAX_IMAGE_BYTES) {
          res.write(`data: ${JSON.stringify({ type: 'error', text: '单张图片不能超过 10MB。' })}\n\n`)
          res.end()
          return
        }
      }

      const content = [{ type: 'text', text: messageWithFeatures }]
      for (const img of validImages) {
        const fileId = await uploadImageToDeepSeekFiles(img.url, img.mime, provider.key)
        content.push({ type: 'file', file_id: fileId })
      }
      upstreamMessages = [{ role: 'user', content }]
      // 仅 deepseek-v4-flash-vision-exp 支持图片输入，有图片时强制切到视觉模型
      requestModel = 'deepseek-v4-flash-vision-exp'
    } else {
      upstreamMessages = [{ role: 'user', content: messageWithFeatures }]
    }

    // 上游 API 请求超时保护：60 秒内无响应则主动断开
    const upstreamController = new AbortController()
    const upstreamTimeout = setTimeout(() => upstreamController.abort(), 60_000)

    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.key}`,
      },
      body: JSON.stringify({
        model: requestModel,
        messages: upstreamMessages,
        stream: true,
      }),
      signal: upstreamController.signal,
    })

    clearTimeout(upstreamTimeout)
    const t2 = performance.now()
    console.log(`[streamChat] token验证=${(t1 - t0).toFixed(0)}ms, 上游TTFB=${(t2 - t1).toFixed(0)}ms, model=${requestModel}`)

    if (!response.ok) {
      const rawBody = await response.text()
      const upstreamError = normalizeUpstreamError(response, rawBody)
      const friendlyMessage = getFriendlyErrorMessage(Number(upstreamError.status), upstreamError.message)

      console.error('Upstream provider error:', upstreamError.status, upstreamError.code, upstreamError.message)
      throw new Error(friendlyMessage)
    }

    if (!response.body) {
      throw new Error('模型服务返回为空。')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') {
          continue
        }

        if (!trimmed.startsWith('data:')) {
          continue
        }

        const payload = trimmed.slice(5).trim()
        if (!payload) {
          continue
        }

        try {
          const json = JSON.parse(payload)
          const delta = json.choices?.[0]?.delta?.content

          if (typeof delta === 'string' && delta) {
            res.write(`data: ${JSON.stringify({ type: 'chunk', text: delta })}\n\n`)
          }
        } catch (error) {
          console.warn('解析流数据失败:', payload)
        }
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', model: requestModel })}\n\n`)
    res.end()
  } catch (error) {
    const safeText = error instanceof Error ? error.message : '模型服务暂时不可用，请稍后再试。'
    const isTimeout = error instanceof Error && error.name === 'AbortError'
    console.error('Stream handler failed:', safeText)
    const errorText = isTimeout ? '模型服务响应超时，请稍后重试。' : safeText
    res.write(`data: ${JSON.stringify({ type: 'error', text: errorText })}\n\n`)
    res.end()
  }
}

export { streamChat }
