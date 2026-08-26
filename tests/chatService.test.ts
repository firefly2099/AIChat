import { describe, it, expect } from 'vitest'
// 后端聊天服务纯函数测试
import {
  sanitizeIds,
  sanitizeModelId,
  normalizeUpstreamError,
  getFriendlyErrorMessage,
  parseBooleanQuery,
  buildFeaturePrompt,
  getProviderConfig,
} from '../server/services/chatService.js'
import { DEEPSEEK_ERROR_MESSAGE_MAP } from '../server/config.js'

describe('sanitizeIds', () => {
  it('去空、去重、trim', () => {
    expect(sanitizeIds(['a', 'b', 'a', ' ', '', null, 'c'])).toEqual(['a', 'b', 'c'])
  })
  it('非数组一律返回空数组', () => {
    expect(sanitizeIds(null)).toEqual([])
    expect(sanitizeIds(undefined)).toEqual([])
    expect(sanitizeIds('abc')).toEqual([])
  })
})

describe('sanitizeModelId', () => {
  it('剥离非法字符，仅留字母数字点下划线连字符', () => {
    expect(sanitizeModelId('deepseek@v3!')).toBe('deepseekv3')
  })
  it('空值回退默认 deepseek-v3', () => {
    expect(sanitizeModelId('')).toBe('deepseek-v3')
    expect(sanitizeModelId(null)).toBe('deepseek-v3')
    expect(sanitizeModelId(undefined)).toBe('deepseek-v3')
  })
  it('保留点/下划线/连字符', () => {
    expect(sanitizeModelId('deepseek_chat-v4.flash')).toBe('deepseek_chat-v4.flash')
  })
})

describe('normalizeUpstreamError', () => {
  it('解析 DeepSeek {error:{message,code}} 结构', () => {
    const r = normalizeUpstreamError({ status: 429 }, '{"error":{"message":"rate limit","code":"rate_limit"}}')
    expect(r.status).toBe(429)
    expect(r.code).toBe('rate_limit')
    expect(r.message).toBe('rate limit')
  })
  it('解析通用 {message} 结构', () => {
    const r = normalizeUpstreamError({ status: 500 }, '{"message":"boom"}')
    expect(r.message).toBe('boom')
  })
  it('非 JSON body 落到 rawBody 文案', () => {
    const r = normalizeUpstreamError({ status: 502 }, 'oops')
    expect(r.message).toBe('oops')
    expect(r.code).toBe(502)
  })
  it('空 body 走兜底文案', () => {
    const r = normalizeUpstreamError({ status: 500 }, '')
    expect(r.message).toBe('模型服务暂时不可用。')
  })
})

describe('getFriendlyErrorMessage', () => {
  it('按状态码映射已知文案', () => {
    expect(getFriendlyErrorMessage(429)).toBe(DEEPSEEK_ERROR_MESSAGE_MAP[429])
  })
  it('未知状态码走兜底', () => {
    expect(getFriendlyErrorMessage(599)).toBe('模型服务暂时不可用，请稍后再试。')
  })
  it('带详情时拼接", 详情："', () => {
    const msg = getFriendlyErrorMessage(429, '限流')
    expect(msg).toContain('详情：限流')
  })
})

describe('parseBooleanQuery', () => {
  it('true/1 为真', () => {
    expect(parseBooleanQuery('true')).toBe(true)
    expect(parseBooleanQuery('1')).toBe(true)
    expect(parseBooleanQuery('TRUE')).toBe(true)
  })
  it('其它为假', () => {
    expect(parseBooleanQuery('false')).toBe(false)
    expect(parseBooleanQuery('0')).toBe(false)
    expect(parseBooleanQuery('')).toBe(false)
    expect(parseBooleanQuery(undefined)).toBe(false)
  })
})

describe('buildFeaturePrompt', () => {
  it('无开关原样返回', () => {
    expect(buildFeaturePrompt('你好', false, false)).toBe('你好')
  })
  it('深度思考注入', () => {
    const out = buildFeaturePrompt('你好', true, false)
    expect(out).toContain('深度思考')
    expect(out).toContain('用户问题：你好')
  })
  it('智能搜索注入', () => {
    expect(buildFeaturePrompt('你好', false, true)).toContain('智能搜索')
  })
  it('双开关同时注入', () => {
    const out = buildFeaturePrompt('你好', true, true)
    expect(out).toContain('深度思考')
    expect(out).toContain('智能搜索')
  })
})

describe('getProviderConfig', () => {
  it('deepseek-v3 映射到 v4-flash', () => {
    const cfg = getProviderConfig('deepseek-v3')
    expect(cfg.label).toBe('deepseek')
    expect(cfg.requestModel).toBe('deepseek-v4-flash')
    expect(cfg.keyName).toBe('DEEPSEEK_API_KEY')
  })
  it('deepseek-reasoner 原样保留', () => {
    const cfg = getProviderConfig('deepseek-reasoner')
    expect(cfg.label).toBe('deepseek')
    expect(cfg.requestModel).toBe('deepseek-reasoner')
  })
  it('非 deepseek 走 qwen 兜底分支', () => {
    const cfg = getProviderConfig('qwen3-7b')
    expect(cfg.label).toBe('qwen')
    expect(cfg.requestModel).toBe('qwen3-7b')
  })
  it('未知模型落到 qwen 原样', () => {
    const cfg = getProviderConfig('some-unknown-model')
    expect(cfg.label).toBe('qwen')
    expect(cfg.requestModel).toBe('some-unknown-model')
  })
})
