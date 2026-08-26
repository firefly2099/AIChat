// 用 express.Router 挂载所有控制器路由。路径与原 app.xxx 完全一致（相对 /api 挂载）。
import express from 'express'
import { rateLimit, chatRateLimit, requireAuth } from './middleware.js'
import { getModels } from './controllers/modelsController.js'
import {
  listSessions,
  getSession,
  createSession,
  saveSnapshot,
  updateTitle,
  deleteSession,
  pinSession,
  batchPin,
  batchDelete,
} from './controllers/sessionController.js'
import { streamChat } from './controllers/chatController.js'

const router = express.Router()

router.get('/models', rateLimit, getModels)
router.get('/sessions', rateLimit, requireAuth, listSessions)
router.get('/sessions/:sessionId', rateLimit, requireAuth, getSession)
router.post('/sessions', rateLimit, requireAuth, createSession)
router.put('/sessions/:sessionId/snapshot', rateLimit, requireAuth, saveSnapshot)
router.patch('/sessions/:sessionId/title', rateLimit, requireAuth, updateTitle)
router.delete('/sessions/:sessionId', rateLimit, requireAuth, deleteSession)
router.patch('/sessions/:sessionId/pin', rateLimit, requireAuth, pinSession)
router.post('/sessions/batch/pin', rateLimit, requireAuth, batchPin)
router.post('/sessions/batch/delete', rateLimit, requireAuth, batchDelete)
router.post('/chat/stream', chatRateLimit, streamChat)

export default router
