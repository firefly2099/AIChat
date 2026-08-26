// Express 服务入口（薄 bootstrap）：创建 app、挂全局中间件、挂 routes、listen。
// dotenv 必须在最早加载，先于读取 process.env 的 config.js。
import 'dotenv/config'
import express from 'express'
import {
  QWEN_API_BASE_URL,
  DEEPSEEK_API_BASE_URL,
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_USER,
  MYSQL_DATABASE,
  QWEN_API_KEY,
  DEEPSEEK_API_KEY,
} from './config.js'
import { securityHeadersMiddleware, corsMiddleware, ensureToken } from './middleware.js'
import { ensureTables } from './db.js'
import router from './routes.js'

const app = express()
const port = Number(process.env.PORT || 3001)

// 关闭默认 X-Powered-By 头，降低框架信息暴露。
app.disable('x-powered-by')
// 信任一层反代（Vite dev 代理 / 生产 nginx），使 req.ip 取真实客户端 IP 而非代理 IP。
// 注意：仅在确信部署在受信代理之后时启用；直接暴露后端会让 X-Forwarded-For 被伪造。
app.set('trust proxy', 1)
app.use(express.json({ limit: '100mb' }))

// 全局安全头 + CORS + token 引导中间件（仅对 /api/models 做 token 引导）
// CORS 必须挂在最前面，OPTIONS 预检要在鉴权前返回。
app.use(corsMiddleware)
app.use(securityHeadersMiddleware)
app.use(ensureToken)

// 根路径健康检查（供运维/负载均衡探活，返回 JSON 而非 Express 默认 HTML 错误页）
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'aichat',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

// 所有 /api 接口由 routes.js 提供
app.use('/api', router)

/**
 * 启动服务监听端口。
 */
app.listen(port, () => {
  console.log(`AI chat server running at http://localhost:${port}`)
  console.log(`Qwen API base URL: ${QWEN_API_BASE_URL}`)
  console.log(`DeepSeek API base URL: ${DEEPSEEK_API_BASE_URL}`)
  console.log(`MySQL DSN: ${MYSQL_USER}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}`)
  console.log(QWEN_API_KEY ? 'Qwen API Key 已配置' : '未配置 QWEN_API_KEY')
  console.log(DEEPSEEK_API_KEY ? 'DeepSeek API Key 已配置' : '未配置 DEEPSEEK_API_KEY')
})

ensureTables()
  .then(() => {
    console.log('MySQL tables ready')
  })
  .catch((error) => {
    console.error('MySQL init failed:', error)
  })
