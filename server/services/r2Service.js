// Cloudflare R2 图片存储服务（S3 兼容协议）。
// 负责：图片上传、容量检查（基于 storage_stats 表的计数器）。
// 当 R2 未配置或容量超限时，上传会被跳过，前端回退到 localStorage base64。
import { AwsClient } from 'aws4fetch'
import { dbPool } from '../db.js'

// R2 配置（从环境变量读取，未配置时 isR2Configured 为 false）
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || ''
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || ''
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || ''
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || ''
const R2_PUBLIC_URL = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

// R2 免费额度 10GB，达 90%（9GB）后停止上传
const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024 // 10GB
const R2_CAPACITY_THRESHOLD = Math.floor(R2_FREE_TIER_BYTES * 0.9) // 9GB

const isR2Configured = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL,
)

// aws4fetch 客户端，仅在 R2 已配置时创建
const r2Client = isR2Configured
  ? new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      region: 'auto',
      service: 's3',
    })
  : null

/**
 * 查询当前 R2 已用存储量（从 storage_stats 表读取累计字节数）。
 * @returns {Promise<number>} 已用字节数，表不存在或无数据时返回 0
 */
async function getStorageUsage() {
  try {
    const [rows] = await dbPool.query(
      'SELECT total_bytes FROM storage_stats WHERE id = 1 LIMIT 1',
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return row ? Number(row.total_bytes) : 0
  } catch {
    // storage_stats 表可能尚未创建
    return 0
  }
}

/**
 * 累加 R2 已用存储量。
 * @param {number} bytes 新增字节数
 * @returns {Promise<void>}
 */
async function incrementStorageUsage(bytes) {
  try {
    await dbPool.query(
      `INSERT INTO storage_stats (id, total_bytes) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE total_bytes = total_bytes + VALUES(total_bytes)`,
      [bytes],
    )
  } catch (error) {
    console.warn('[r2] 更新存储计数器失败:', error?.message || error)
  }
}

/**
 * 将图片上传到 R2，返回公开访问 URL。
 * 上传前检查容量，超过免费额度 90% 时跳过上传。
 * @param {Buffer} buffer 图片二进制数据
 * @param {string} mime MIME 类型，如 image/jpeg
 * @returns {Promise<string | null>} R2 公开 URL；未配置或容量超限时返回 null
 */
async function uploadImageToR2(buffer, mime) {
  if (!isR2Configured || !r2Client) {
    return null
  }

  // 容量检查
  const currentUsage = await getStorageUsage()
  if (currentUsage + buffer.length > R2_CAPACITY_THRESHOLD) {
    console.warn(`[r2] 容量已达阈值: ${currentUsage} + ${buffer.length} > ${R2_CAPACITY_THRESHOLD}，跳过上传`)
    return null
  }

  // 生成唯一对象 key：images/2026/09/xxxxxxxx.ext
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 10)
  const ext = (mime.split('/')[1] || 'jpeg').replace('jpeg', 'jpg')
  const key = `images/${yyyy}/${mm}/${rand}.${ext}`

  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${key}`

  const res = await r2Client.fetch(endpoint, {
    method: 'PUT',
    body: buffer,
    headers: {
      'Content-Type': mime,
    },
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`[r2] 上传失败(${res.status}):`, text.slice(0, 200))
    return null
  }

  // 累加存储计数
  await incrementStorageUsage(buffer.length)

  return `${R2_PUBLIC_URL}/${key}`
}

export {
  isR2Configured,
  getStorageUsage,
  incrementStorageUsage,
  uploadImageToR2,
}
