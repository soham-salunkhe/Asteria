import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy FSOC Python backend REST calls
      '/api/simulation': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/api/scenarios': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/api/runs': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/api/reports': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/api/health': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // WebSocket proxy with better error handling
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
        changeOrigin: true,
        // Suppress proxy errors in console
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('[Vite WS Proxy] Error (non-fatal):', err.message);
          });
          proxy.on('proxyReqWs', (_proxyReq, _req, _socket) => {
            console.log('[Vite WS Proxy] WebSocket proxying...');
          });
        },
      },
      // Node backend (Gemini guide, old routes)
      '/api/guide': {
        target: 'http://localhost:5001',
        changeOrigin: true,
      },
    },
  },
})
