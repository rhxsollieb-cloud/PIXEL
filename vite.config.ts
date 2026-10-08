import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  // App owns disposable project/interaction services. Reload that boundary on
  // edits, while keeping CSS and ordinary component Fast Refresh available.
  plugins: [react({ exclude: [/node_modules/, /\/App\.tsx$/] })],
  envPrefix: 'PIXEL_PUBLIC_',
  server: {
    host: '127.0.0.1', port: Number(process.env.PIXEL_PORT ?? 4310), strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.PIXEL_API_PORT ?? 4311}`, changeOrigin: true } },
    fs: { allow: ['..'], deny: ['**/.env', '**/.env.*', '**/.git/**'] },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
