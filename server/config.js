// 配置常量与静态表。
// env 在此处读取，因此 dotenv 必须先于本模块加载（在 index.js 顶部 import 'dotenv/config'）。

const QWEN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'
// 允许携带文档提取文本（与前端附件总文本上限 20k 对齐）。
// 原 4000 过小，会把上传文档的提取文本几乎全部截掉，导致模型看不到文档内容。
const MAX_MESSAGE_LENGTH = 20000
// 常规 API（会话读写、快照保存、模型列表等便宜 DB 操作）的每分钟请求上限。
// 25 过低：正常使用（切会话、防抖快照、流式发送）就会打爆 429。提到 300 覆盖正常高频读写。
const MAX_REQUESTS_PER_MINUTE = 300
// 聊天流式单独收紧：每次都会回源 DeepSeek，防止 API Key 被刷爆。
const MAX_CHAT_REQUESTS_PER_MINUTE = 30
const WINDOW_MS = 60 * 1000

const QWEN_API_KEY = process.env.QWEN_API_KEY
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const QWEN_API_BASE_URL = process.env.QWEN_API_BASE_URL || QWEN_DEFAULT_BASE_URL
const DEEPSEEK_API_BASE_URL = process.env.DEEPSEEK_API_BASE_URL || DEEPSEEK_DEFAULT_BASE_URL
const MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1'
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306)
const MYSQL_USER = process.env.MYSQL_USER || 'root'
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || ''
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'aichat'

const DEVICE_TOKEN_HEADER = 'x-device-token'

// CORS 允许来源，逗号分隔。默认允许本地开发 5173 端口。
// 部署到 Vercel 预览/生产时，把前端域名追加进来，例如：
//   CORS_ORIGINS=https://aichat.example.com,https://aichat-abc.vercel.app
// 也会自动匹配 *.vercel.app 域名（Vercel 预览部署）。
// 若值为空字符串（仅本地 dev），则只走本地白名单 + Vercel 通配。
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)

/**
 * 可供前端展示的兜底模型列表。
 * 当上游 provider 不可用时，前端仍可继续显示基础选项。
 */
const fallbackModels = [
  {
    id: 'deepseek-v3',
    label: 'DeepSeek V3',
    description: '适合中文理解和工程问题排查。',
    status: '在线',
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    description: '深度思考模型，适合复杂推理与数学问题。',
    status: '在线',
  },
]

/**
 * DeepSeek 业务错误码映射表。
 * 这些错误通常来自上游服务，在前端展示时需要转换成更易懂的提示文本。
 * @type {Record<number, string>}
 */
const DEEPSEEK_ERROR_MESSAGE_MAP = {
  400: '请求格式错误：请根据错误信息检查请求体格式与字段内容。',
  401: '认证失败：请检查 API Key 是否正确，或重新生成后重试。',
  402: '余额不足：账户余额不足，请前往充值页完成充值后再试。',
  422: '参数错误：请根据返回信息修正具体请求参数。',
  429: '请求速率达到上限：请降低并发或稍后重试。',
  500: '服务器故障：DeepSeek 服务内部异常，请稍后重试。',
  503: '服务器繁忙：DeepSeek 当前负载较高，请稍后再试。',
}

export {
  QWEN_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_BASE_URL,
  MAX_MESSAGE_LENGTH,
  MAX_REQUESTS_PER_MINUTE,
  MAX_CHAT_REQUESTS_PER_MINUTE,
  WINDOW_MS,
  QWEN_API_KEY,
  DEEPSEEK_API_KEY,
  QWEN_API_BASE_URL,
  DEEPSEEK_API_BASE_URL,
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,
  DEVICE_TOKEN_HEADER,
  CORS_ORIGINS,
  fallbackModels,
  DEEPSEEK_ERROR_MESSAGE_MAP,
}
