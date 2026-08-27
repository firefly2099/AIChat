[中文](./README.md)

# Yuanqi AI Chat Project

**Live Demo**: https://aichat.firefly2099.vercel.app

Backend API: https://aichat-production-2004.up.railway.app

An AI chat application built with Vue 3 + TypeScript + Vite, with a UI inspired by DeepSeek. Current version 1.0.0. Features:

- Left sidebar with conversation history (pin / rename / batch delete)
- Route-based switching between home and chat pages
- Conversation persistence (in-memory store + long-term MySQL storage)
- Streaming typewriter-style output
- Element Plus icons and base component styling
- Real server-side proxy for model requests (DeepSeek only)
- File upload with text extraction (txt / md / csv / json / code / pdf / docx / xlsx / pptx)
- Image upload via the DeepSeek Files API (base64 → file_id → vision model)
- Attachment rendering: image and file cards inside chat bubbles; after refresh, attachments are merged back into messages by index using localStorage
- Anchor navigation, deep-thinking and web-search toggles, Markdown rendering with code highlighting
- API key protection and IP rate limiting
- Device-token based API authentication

## Tech Stack

- Vue 3 / TypeScript / Vite
- Vue Router / Element Plus / Pinia
- markdown-it / highlight.js / dompurify
- Express / MySQL (mysql2)
- File parsing: pdfjs-dist / mammoth / xlsx / jszip / multer

## Project Structure

### Frontend

- src/App.vue: application entry
- src/main.ts: application bootstrap
- src/router/index.ts: routing configuration
- src/layouts/MainLayout.vue: global two-column layout
- src/components/AppHeader.vue: top header bar
- src/components/SidebarNav.vue: left conversation navigation
- src/components/ComposerPanel.vue: input and upload panel
- src/components/ImagePreviewModal.vue: image preview modal
- src/views/HomeView.vue: home page
- src/views/ChatView.vue: chat page
- src/views/ChatView.css: scoped styles for the chat page
- src/store/sessionStore.ts: conversation state management
- src/store/modelStore.ts: model state management
- src/api/chatApi.ts: unified API layer (auto-attaches token)
- src/utils/markdown.ts: Markdown rendering and code highlighting
- src/utils/fileText.ts: attachment text extraction
- src/style.css: global styles

### Backend (MVC layout)

- server/index.js: bootstrap (app, global middleware, listens on 3001)
- server/config.js: configuration constants
- server/db.js: MySQL connection pool and data access
- server/middleware.js: auth / rate limiting / security headers
- server/services/modelsService.js: model list service
- server/services/chatService.js: chat pure functions and service
- server/controllers/modelsController.js: model endpoints
- server/controllers/sessionController.js: session endpoints
- server/controllers/chatController.js: chat endpoints
- server/routes.js: route mounting

## Security Notes

- The API key is kept only in the server-side .env and is never exposed to the frontend
- Each device+browser receives a signed token from the server on first visit to /api/models
- All /api endpoints except /api/models require an x-device-token header
- The frontend only calls the local proxy endpoint /api/chat/stream and never talks to the upstream model directly
- The backend applies simple IP rate limiting on /api/chat/stream and /api/models to prevent abuse
- Raw errors from the upstream model are logged on the server and a generic error is returned to the client to avoid leaking sensitive information
- `Cache-Control: no-store` and baseline security headers reduce caching and XSS risk

## Getting Started

1. Install dependencies
   npm install

2. Configure environment variables
   Copy .env.example to .env and fill in DEEPSEEK_API_KEY
   Also configure the MySQL connection: MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE

3. Start the development environment
   npm run dev

4. Open the app
   Frontend: http://localhost:5173
   Backend: http://localhost:3001

## Main Features

- Home route: /
- Conversation route: /chat/:sessionID
- Click the brand or "Start a new conversation" to create a new conversation
- Click a history entry to resume the corresponding conversation
- The sidebar can be expanded/collapsed and supports pin, rename, and batch delete
- Conversation data is held in memory so it survives route changes
- Conversations and messages are persisted in MySQL and survive page refreshes
- Uploaded files are automatically parsed into text and sent with the message; supported formats include txt / md / csv / json / code / pdf / docx / xlsx / pptx (legacy doc / ppt only show a hint)
- Image uploads go through the DeepSeek Files API and are recognized by the vision model
- Chat bubbles render image and file cards; after refresh, attachments are merged back into messages by index via localStorage
- Anchor navigation, deep-thinking and web-search toggles, Markdown rendering with code highlighting
- Uses fetch + ReadableStream to read streaming model output and append it to the answer, producing a typewriter effect
- A new conversation auto-generates a title from the first message; the title can be edited and saved from the sidebar at any time

## Notes

This project is wired to a real AI model proxy (DeepSeek). The backend centrally manages the API key and request rate limiting, making it suitable for real-world chat debugging in a local development environment.
