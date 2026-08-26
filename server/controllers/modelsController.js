// /api/models 路由处理。
import { fallbackModels } from '../config.js'
import { fetchAvailableModelsFromProvider } from '../services/modelsService.js'
import { getProviderConfig } from '../services/chatService.js'

/**
 * 返回前端可用的模型列表。
 * 优先从 DeepSeek / Qwen 真正的模型接口拉取，失败时退回静态兜底数据。
 */
async function getModels(req, res) {
  // 仅支持 DeepSeek，避免 Qwen 不可用时模型列表拉取失败
  const provider = getProviderConfig('deepseek-v3')

  try {
    const providerModels = await fetchAvailableModelsFromProvider(provider)
    if (providerModels.length) {
      return res.json({ token: req.deviceToken, models: providerModels })
    }
    return res.json({ token: req.deviceToken, models: fallbackModels })
  } catch (error) {
    console.warn('Failed to fetch provider models, using fallback list:', error)
    return res.json({ token: req.deviceToken, models: fallbackModels })
  }
}

export { getModels }
