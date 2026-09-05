import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend port. Override with SERVER_PORT if you changed PORT for the
// server (see server/src/config.js).
const SERVER_PORT = process.env.SERVER_PORT || 5055;
const target = `http://localhost:${SERVER_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/socket.io': { target, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
