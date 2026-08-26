// 拉取上游 provider 的可用模型列表。

// 模型列表内存缓存：按 provider 标签缓存，TTL 内不回源上游。
// 模型列表极少变化，缓存可显著减少对 DeepSeek 的回源请求。
// 仅缓存成功结果；失败仍由调用方走 fallbackModels 兜底，不缓存错误。
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000 // 1 小时
const modelCache = new Map() // label -> { data, expiresAt }

/**
 * 读取上游 provider 的可用模型列表。
 * 优先从真实大模型服务获取，网络异常时回退到本地兜底数据。
 * @param {{ key: string | undefined, baseUrl: string, requestModel: string, label: string }} provider
 * @returns {Promise<Array<{ id: string, label: string, description: string, status: string }>>}
 */
async function fetchAvailableModelsFromProvider(provider) {
  if (!provider?.key) {
    return []
  }

  // 命中未过期缓存则直接返回，避免每次回源上游
  const cached = modelCache.get(provider.label)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data
  }

  const baseUrl = String(provider.baseUrl || '').replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${provider.key}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Provider models request failed: ${response.status}`)
  }

  const payload = await response.json()
  const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []

  const result = items
    .map((model, index) => {
      const id = String(model?.id || model?.model || model?.name || `model-${index}`)
      const label = String(model?.label || model?.display_name || model?.id || model?.name || id)
      const description = String(model?.description || '当前模型可供使用。')
      const status = model?.status ? String(model.status) : '在线'

      return {
        id,
        label,
        description,
        status,
      }
    })
    .filter((model) => model.id)

  // 仅在成功时写入缓存
  modelCache.set(provider.label, { data: result, expiresAt: Date.now() + MODEL_CACHE_TTL_MS })
  return result
}

export { fetchAvailableModelsFromProvider }
