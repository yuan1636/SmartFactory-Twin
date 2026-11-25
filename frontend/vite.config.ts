import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// /api 代理到本机后端：开发期前端只写相对路径，避免跨域与端口写死。
// 注意 target 用 127.0.0.1 而不是 localhost —— Windows 下 localhost 先解析到 ::1，
// 而 uvicorn 只监听 IPv4，每个请求会白等约 2 秒（第 2 阶段实测 2030ms → 4ms）。
export default defineConfig({
  plugins: [react()],
  // three 的 examples/jsm 是按需引入的，Vite 默认在"第一次遇到"时才预打包。
  // 那个时机太晚：dev server 已跑起来，重新打包会去删 .vite/deps_temp_*，
  // 一旦被环境拦下（本机实测：104 个文件的批量删除被安全策略拒绝），
  // 整个 dev server 直接崩，界面白屏但看不出原因。
  // 所以把已用到的模块全部写死，启动时一次打包完，运行期不再"发现新依赖"。
  // 新增 examples 模块时记得同步这里。
  optimizeDeps: {
    include: [
      'three/examples/jsm/controls/OrbitControls',
      'three/examples/jsm/postprocessing/EffectComposer',
      'three/examples/jsm/postprocessing/RenderPass',
      'three/examples/jsm/postprocessing/UnrealBloomPass',
      'three/examples/jsm/postprocessing/OutputPass',
      'three/examples/jsm/postprocessing/SMAAPass',
      'three/examples/jsm/renderers/CSS2DRenderer',
      'three/examples/jsm/utils/BufferGeometryUtils',
    ],
  },
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
