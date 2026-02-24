import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'node18',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        server: resolve(__dirname, 'server.ts')
      },
      external: [
        'express',
        'http-proxy-middleware',
        'redis',
        '@kubernetes/client-node',
        'winston',
        'winston/transports'
      ],
      output: {
        format: 'cjs',
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js'
      }
    }
  },
  server: {
    watch: {
      usePolling: true
    }
  }
});
