import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// /api 代理到本机后端：开发期前端只写相对路径，避免跨域与端口写死。
// 注意 target 用 127.0.0.1 而不是 localhost —— Windows 下 localhost 先解析到 ::1，
// 而 uvicorn 只监听 IPv4，每个请求会白等约 2 秒（第 2 阶段实测 2030ms → 4ms）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
