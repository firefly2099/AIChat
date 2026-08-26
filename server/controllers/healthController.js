// 健康检查控制器：返回服务状态 + MySQL 连接状态。
import { dbPool } from '../db.js'

/**
 * GET /api/health
 * 轻量健康检查端点，供 Railway/负载均衡探活。
 * 同时返回 MySQL 连接状态，方便排查数据库层面问题。
 */
async function healthCheck(_req, res) {
  let mysqlStatus = 'unknown'
  let mysqlError = null
  try {
    await dbPool.query('SELECT 1')
    mysqlStatus = 'ok'
  } catch (err) {
    mysqlStatus = 'error'
    mysqlError = err?.message || String(err)
  }

  const httpStatus = mysqlStatus === 'ok' ? 200 : 503
  res.status(httpStatus).json({
    status: mysqlStatus === 'ok' ? 'ok' : 'degraded',
    service: 'aichat',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mysql: {
      status: mysqlStatus,
      error: mysqlError,
    },
  })
}

export { healthCheck }
