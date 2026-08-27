[English](./README.en.md)

# 元启 AI 聊天项目

**在线演示**: https://aichat.firefly2099.vercel.app

后端 API: https://aichat-production-2004.up.railway.app

这是一个基于 Vue 3 + TypeScript + Vite 的 AI 聊天应用，界面参考 DeepSeek 风格，当前版本 1.0.0，支持：

- 左侧历史会话侧边栏（置顶 / 重命名 / 批量删除）
- 首页和聊天页路由切换
- 会话持久化（内存 store + MySQL 长期存储）
- 流式输出打字机效果
- Element Plus 图标和基础组件样式
- 真正的服务端代理模型请求（仅 DeepSeek）
- 文件上传并提取文本（txt / md / csv / json / 代码 / pdf / docx / xlsx / pptx）
- 图片上传：走 DeepSeek Files API（base64 → file_id → 视觉模型）
- 附件展示：聊天气泡内展示图片与文件卡片，刷新后由 localStorage 按下标合并回消息
- 锚点定位、深度思考与搜索开关、Markdown 渲染与代码高亮
- API Key 保护与 IP 限流
- 基于设备 token 的接口鉴权

## 技术栈

- Vue 3 / TypeScript / Vite
- Vue Router / Element Plus / Pinia
- markdown-it / highlight.js / dompurify
- Express / MySQL（mysql2）
- 文件解析：pdfjs-dist / mammoth / xlsx / jszip / multer

## 项目结构

### 前端

- src/App.vue：应用入口
- src/main.ts：应用初始化
- src/router/index.ts：路由配置
- src/layouts/MainLayout.vue：全局两栏布局
- src/components/AppHeader.vue：顶部栏
- src/components/SidebarNav.vue：左侧会话导航
- src/components/ComposerPanel.vue：输入与上传面板
- src/components/ImagePreviewModal.vue：图片预览弹窗
- src/views/HomeView.vue：首页
- src/views/ChatView.vue：聊天页
- src/views/ChatView.css：聊天页 scoped 样式
- src/store/sessionStore.ts：会话状态管理
- src/store/modelStore.ts：模型状态管理
- src/api/chatApi.ts：统一接口层（自动携带 token）
- src/utils/markdown.ts：Markdown 渲染与代码高亮
- src/utils/fileText.ts：附件文本提取
- src/style.css：全局样式

### 后端（MVC 拆分）

- server/index.js：启动入口（app、全局中间件、监听 3001）
- server/config.js：配置常量
- server/db.js：MySQL 连接池与数据访问
- server/middleware.js：鉴权 / 限流 / 安全头
- server/services/modelsService.js：模型列表服务
- server/services/chatService.js：聊天纯函数与服务
- server/controllers/modelsController.js：模型接口
- server/controllers/sessionController.js：会话接口
- server/controllers/chatController.js：聊天接口
- server/routes.js：路由挂载

## 安全性说明

- API Key 仅保存在服务端 .env 中，不在前端暴露
- 每个设备+浏览器首次访问 /api/models 时，会由服务端签发并返回 token
- 除 /api/models 外，其他 /api 接口均要求携带 x-device-token
- 前端仅访问本地代理接口 /api/chat/stream，不直接调用第三方模型
- 后端对 /api/chat/stream 和 /api/models 加了简单 IP 限流，避免被刷爆
- 上游模型返回的原始错误会被服务端记录日志并对客户端返回通用错误，避免泄露敏感信息
- 通过 `Cache-Control: no-store` 和基础安全响应头降低被缓存和 XSS 的风险

## 运行方式

1. 安装依赖
   npm install

2. 配置环境变量
   复制 .env.example 为 .env，并填充 DEEPSEEK_API_KEY
   同时配置 MySQL 连接：MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE

3. 启动开发环境
   npm run dev

4. 访问应用
   前端：http://localhost:5173
   后端：http://localhost:3001

## 主要功能

- 首页路由：/
- 会话页路由：/chat/:sessionID
- 点击品牌或“开启新对话”创建新会话
- 点击历史会话恢复对应对话
- 侧边栏可展开/收起，支持会话置顶、重命名、批量删除
- 会话数据保存在内存中，切换路由不丢失
- 会话和消息持久化在 MySQL，页面刷新后不丢失
- 文件上传后自动提取文本并随消息发送，支持 txt / md / csv / json / 代码 / pdf / docx / xlsx / pptx（旧版 doc / ppt 仅给出提示）
- 图片上传走 DeepSeek Files API，由视觉模型识别
- 聊天气泡内展示图片与文件卡片，刷新后由 localStorage 按下标合并回消息
- 支持锚点定位、深度思考与搜索开关、Markdown 渲染与代码高亮
- 使用 fetch + ReadableStream 读取流式模型输出并追加到答案内容中，实现打字机效果
- 新建会话会自动基于首条聊天内容生成标题，侧边栏可随时编辑标题并保存

## 说明

本项目已接入真实 AI 模型代理（DeepSeek），通过后端统一管理 API Key 和请求限流，适合在本地开发环境中进行真实聊天调试。
