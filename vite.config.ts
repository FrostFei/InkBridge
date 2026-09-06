import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const pages = mode === 'github-pages';
  const base = pages ? '/InkBridge/' : '/';
  return {
    base,
    plugins: [
      {
        name: 'development-csp',
        apply: 'serve',
        // Vite's development-only React refresh preamble is inline. Production
        // keeps the strict meta policy for hosts without configurable headers.
        transformIndexHtml: (html) =>
          html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*\/>/, ''),
      },
      react(),
      VitePWA({
        registerType: 'prompt',
        injectRegister: false,
        includeAssets: ['icon.svg', 'apple-touch-icon.png'],
        manifest: {
          id: base,
          name: 'InkBridge 墨桥',
          short_name: 'InkBridge',
          description: '离线笔记与 GitHub 同步',
          lang: 'zh-CN',
          start_url: base,
          scope: base,
          display: 'standalone',
          theme_color: '#f7f7f2',
          background_color: '#f7f7f2',
          icons: [
            { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
            {
              src: `${base}icon-512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
          navigateFallback: `${base}index.html`,
          // Only the built application is precached. GitHub responses stay out of Cache Storage.
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
          skipWaiting: false,
          clientsClaim: true,
        },
      }),
    ],
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
      setupFiles: ['tests/setup.ts'],
      testTimeout: 15000,
    },
    build: { sourcemap: false, outDir: pages ? 'dist-pages' : 'dist' },
  };
});
