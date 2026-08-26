import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Vitest 配置：复用 Vite 的 Vue 插件。
// 默认 node 环境；需要 DOM 的测试在文件顶部用 `// @vitest-environment happy-dom` 单独声明。
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
