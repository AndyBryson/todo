import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/todo/',
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      injectRegister: 'auto',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Todo',
        short_name: 'Todo',
        display: 'standalone',
        start_url: '/todo/',
        scope: '/todo/',
        theme_color: '#2455d6',
        background_color: '#f6f6f4',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        navigateFallback: '/todo/index.html',
        // Google URLs are cross-origin so never match; this reserves a same-origin sign-in callback.
        navigateFallbackDenylist: [/^\/todo\/oauth/],
        // The offline copy is the IndexedDB mirror, so no runtime caching of API responses.
        runtimeCaching: [],
      },
    }),
  ],
});
