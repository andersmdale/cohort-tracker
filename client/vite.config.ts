import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // shared/ and server/sql are imported from outside the client folder
    fs: { allow: ['..'] },
    proxy: { '/api': { target: process.env.API_TARGET ?? 'http://localhost:4000', changeOrigin: true } },
  },
});
