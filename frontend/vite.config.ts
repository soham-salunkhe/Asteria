import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy FSOC Python backend REST calls
      '/api/simulation': 'http://localhost:8000',
      '/api/scenarios':  'http://localhost:8000',
      '/api/runs':       'http://localhost:8000',
      '/api/reports':    'http://localhost:8000',
      '/api/health':     'http://localhost:8000',
      // WebSocket proxy
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
      // Node backend (Gemini guide, old routes)
      '/api/guide':      'http://localhost:5001',
    },
  },
})
