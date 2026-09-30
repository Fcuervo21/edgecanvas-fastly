import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

function hostedBoundary(): Plugin {
  return {
    name: 'edgecanvas-hosted-boundary',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler: html => html.replace('/src/main.ts', '/src/hosted.ts'),
    },
    load(id) {
      if (id.startsWith(resolve('server') + '/') || /(?:^|\/)StepsData\/|\.csv(?:[?#]|$)/i.test(id.replaceAll('\\', '/'))) {
        this.error('Private datasets cannot be imported into the hosted frontend.');
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: mode === 'hosted' ? [hostedBoundary()] : [],
  // Hosted assets must not inherit files copied from the local public directory.
  ...(mode === 'hosted' ? { publicDir: false, build: { outDir: 'dist-hosted' } } : {}),
  server: { host: '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:4174', changeOrigin: true } } },
}));
