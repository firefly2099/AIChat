# AIChat 生产部署 - Product Requirement Document

## Overview
- **Summary**: 将 AIChat 全栈应用（Vue 3 前端 + Express 后端 + MySQL 数据库）部署到生产环境，实现前端 Vercel + 后端 Railway + 数据库 Railway MySQL 的三层分离架构，确保端到端可访问、功能完整。
- **Purpose**: 完成从本地开发到线上生产的部署流程，使用户能通过公网访问 AI 聊天应用。
- **Target Users**: 个人开发者 / 测试用户

## Goals
- 后端 API 在 Railway 上正常运行，监听 `process.env.PORT`，所有 `/api/*` 路由可访问
- 前端 SPA 部署到 Vercel，通过 `VITE_API_BASE_URL` 指向 Railway 后端
- 数据库连接正常，会话/消息持久化
- CORS 配置正确，前端跨域请求后端无拦截
- 基础健康检查端点可用（`GET /api/models` 返回 JSON）
- CI/CD 流程：GitHub Actions 自动测试 + 部署

## Non-Goals (Out of Scope)
- 不做自定义域名绑定（先用默认 *.vercel.app / *.railway.app 域名）
- 不做 HTTPS 证书管理（Vercel/Railway 自动提供）
- 不做日志监控/告警系统
- 不做多语言国际化部署

## Background & Context
- 项目已完成 1.0.0 版本开发，CI 全绿
- 后端已部署到 Railway，但存在以下问题待修复：
  1. 根路径 `GET /` 返回 "Cannot GET /"（正常，Express 无根路由，但需加健康检查）
  2. 需添加 `CORS_ORIGINS` 环境变量允许 Vercel 前端跨域
  3. 需确认 `MYSQL_URL` 环境变量正确配置
- 前端尚未部署到 Vercel
- Railway MySQL 已创建并运行中

## Functional Requirements
- **FR-1**: 后端 `GET /api/models` 返回 200 + JSON（含 token 和 models 列表）
- **FR-2**: 后端 `GET /api/models` 对无 token 请求自动创建设备 token 并返回
- **FR-3**: 前端 Vercel 部署后，用户能正常打开首页、发送消息、接收 AI 回复
- **FR-4**: 前端刷新后会话历史仍在（数据库持久化）
- **FR-5**: CORS 正确配置，Vercel 前端域名在白名单内
- **FR-6**: 后端 Railway 环境变量完整：`DEEPSEEK_API_KEY`、`DEEPSEEK_API_BASE_URL`、`MYSQL_URL`、`CORS_ORIGINS`
- **FR-7**: 前端 Vercel 环境变量：`VITE_API_BASE_URL` 指向 Railway 后端 URL

## Non-Functional Requirements
- **NFR-1**: 后端启动时间 < 30 秒（Railway 冷启动）
- **NFR-2**: API 响应时间（/api/models）< 3 秒
- **NFR-3**: SSE 流式聊天无 CORS 预检失败
- **NFR-4**: 安全头（CSP、X-Frame-Options 等）正常返回
- **NFR-5**: 限流保护生效（300/min 常规、30/min 聊天）

## Constraints
- **Technical**: Railway Node 20、Vercel Vite、Railway MySQL 5.7/8.0
- **Business**: 使用免费/低价层，不超过 $5/月
- **Dependencies**: DeepSeek API（第三方）、Railway MySQL（已创建）

## Assumptions
- 用户已有 Railway 和 Vercel 账号
- 代理工具正常运行（GitHub 推送需要）
- DeepSeek API Key 有效且有余额
- Railway MySQL 的 `MYSQL_URL` 环境变量已自动创建

## Acceptance Criteria

### AC-1: 后端健康检查
- **Given**: Railway 后端服务已部署且运行中
- **When**: 浏览器访问 `https://<backend-domain>/api/models`
- **Then**: 返回 200 状态码，响应体为 JSON 且包含 `token` 和 `models` 字段
- **Verification**: `programmatic`

### AC-2: 后端根路径友好响应
- **Given**: Railway 后端服务已部署
- **When**: 访问 `https://<backend-domain>/`
- **Then**: 返回 200 + JSON 健康检查信息（而非 "Cannot GET /"）
- **Verification**: `programmatic`

### AC-3: CORS 跨域正常
- **Given**: 前端部署在 Vercel，后端部署在 Railway
- **When**: 前端页面发起 `POST /api/chat/stream` 请求
- **Then**: 请求成功，无 CORS 预检错误，SSE 流正常接收
- **Verification**: `programmatic`

### AC-4: 前端部署成功
- **Given**: Vercel 已导入 AIChat 仓库
- **When**: 部署完成后访问前端域名
- **Then**: 页面正常渲染，无白屏，控制台无致命错误
- **Verification**: `human-judgment`

### AC-5: 端到端聊天
- **Given**: 前端 Vercel + 后端 Railway + 数据库 Railway MySQL 全部就绪
- **When**: 用户在前端首页发送一条消息
- **Then**: 收到 AI 流式回复，刷新后对话历史仍在
- **Verification**: `human-judgment`

### AC-6: CI/CD 自动触发
- **Given**: GitHub push 到 main 分支
- **When**: Actions CI 运行
- **Then**: TypeScript 类型检查、Vitest 38/38 测试通过
- **Verification**: `programmatic`

## Open Questions
- [ ] Railway 免费层休眠后唤醒时间是否可接受？
- [ ] 是否需要绑定自定义域名？
