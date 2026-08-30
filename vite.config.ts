import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    rolldownOptions: {
      output: {
        minify: {
          compress: {
            dropConsole: true,
            dropDebugger: true,
          },
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            const ct = String(proxyRes.headers['content-type'] || '')
            if (ct.includes('text/event-stream')) {
              // 移除 Content-Length 强制 chunked，任何代理/浏览器都不能缓冲
              delete proxyRes.headers['content-length']
              delete proxyRes.headers['content-encoding']
              proxyRes.headers['x-accel-buffering'] = 'no'
              proxyRes.headers['x-accel-charset'] = 'utf-8'
              proxyRes.headers['cache-control'] = 'no-cache, no-transform'
              proxyRes.headers['connection'] = 'keep-alive'
            }
          })
        },
      },
    },
  },
})
