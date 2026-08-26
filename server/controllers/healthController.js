// 健康检查控制器：返回服务状态 + MySQL 连接状态。
import { dbPool } from '../db.js'
import { MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_DATABASE } from '../config.js'

/**
 * GET /api/health
 * 轻量健康检查端点，供 Railway/负载均衡探活。
 * 同时返回 MySQL 连接状态 + 实际解析到的配置（不含密码），方便排查。
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
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      database: MYSQL_DATABASE,
      mysqlUrlSet: !!process.env.MYSQL_URL,
      mysqlUrlValue: process.env.MYSQL_URL ? '***SET***' : '***UNSET***',
      // 列出所有环境变量键（仅键名，不含值）
      allEnvKeys: Object.keys(process.env).sort(),
    },
  })
}

export { healthCheck }
