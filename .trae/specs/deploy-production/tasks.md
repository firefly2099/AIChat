# AIChat 生产部署 - The Implementation Plan

## [x] Task 1: 后端添加健康检查端点
- **Priority**: high
- **Depends On**: None
- **Description**: 
  - 在 Express 根路径 `GET /` 添加健康检查响应，返回 JSON 格式的服务状态信息
  - 避免 "Cannot GET /" 的裸错误页面，方便运维排查
  - 同时添加 `GET /api/health` 端点用于负载均衡/健康检查
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `programmatic` TR-1.1: `GET /` 返回 200 + JSON `{ status: 'ok', service: 'aichat', version: '1.0.0' }`
  - `programmatic` TR-1.2: `GET /api/health` 返回 200 + JSON，包含 MySQL 连接状态
- **Notes**: 不修改现有路由结构，仅新增根路径处理器

## [x] Task 2: 后端 CORS 配置适配生产环境
- **Priority**: high
- **Depends On**: Task 1
- **Description**: 
  - 确认 `CORS_ORIGINS` 环境变量正确解析
  - 在 Railway 后端 Variables 中添加 `CORS_ORIGINS`（Vercel 前端域名）
  - 确保 `*.vercel.app` 通配匹配生效
- **Acceptance Criteria Addressed**: AC-3, AC-6
- **Test Requirements**:
  - `programmatic` TR-2.1: 从 Vercel 域名发起的请求，响应包含 `Access-Control-Allow-Origin`
  - `programmatic` TR-2.2: OPTIONS 预检请求返回 204
- **Notes**: 当前 `isOriginAllowed` 已支持 `*.vercel.app` 通配，需确认 Railway 环境变量覆盖正确

## [x] Task 3: 部署前端到 Vercel
- **Priority**: high
- **Depends On**: Task 1, Task 2
- **Description**: 
  - 在 Vercel 平台导入 GitHub AIChat 仓库
  - 配置环境变量 `VITE_API_BASE_URL` 指向 Railway 后端公网 URL
  - 确保 `vercel.json` 中 rewrites 规则正确（SPA fallback）
  - 触发部署并验证
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-3.1: Vercel 部署成功，Build log 无错误
  - `human-judgement` TR-3.2: 访问前端域名，页面正常渲染
- **Notes**: `vercel.json` 已配置，无需修改

## [x] Task 4: 端到端联调验证
- **Priority**: high
- **Depends On**: Task 3
- **Description**: 
  - 回填 Railway 后端的 `CORS_ORIGINS` 为 Vercel 前端域名
  - 验证完整流程：首页 → 发送消息 → AI 回复 → 刷新保持历史
  - 验证图片/文件上传功能
- **Acceptance Criteria Addressed**: AC-3, AC-5
- **Test Requirements**:
  - `human-judgement` TR-4.1: 用户在前端发送文本消息，收到 AI 流式回复
  - `human-judgement` TR-4.2: 刷新页面后，对话历史仍在
  - `human-judgement` TR-4.3: 上传图片后气泡显示图片，重新生成时图片不丢
- **Notes**: 此步骤需要真实用户验证

## [x] Task 5: 安全与部署加固
- **Priority**: medium
- **Depends On**: Task 4
- **Description**: 
  - 确认 Railway 后端 Variables 中不包含敏感信息泄漏
  - 确认 `.env` / `.env.example` 不被 git 跟踪
  - 验证 CSP 头、限流、安全头正常生效
  - 更新 README.md 中的部署说明
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `programmatic` TR-5.1: `.gitignore` 排除 `.env`、`node_modules`、`dist`
  - `programmatic` TR-5.2: `GET /api/models` 响应包含 `Content-Security-Policy` 头
  - `human-judgement` TR-5.3: README.md 部署步骤清晰可执行
