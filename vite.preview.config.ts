import { defineConfig, mergeConfig } from 'vite'
import appConfig from './vite.config'

// Use the same pages and API contracts as the application, with a revised directory.
export default mergeConfig(appConfig, defineConfig({
  server: { host: '127.0.0.1', port: 5174, strictPort: true, open: false },
  build: {
    outDir: 'dist-preview',
    rolldownOptions: { input: { main: 'index.html', preview: 'preview.html' } },
  },
}))
