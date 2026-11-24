import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),

    VitePWA({
      registerType: 'autoUpdate',

      includeAssets: ['lion-dance.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],

      manifest: {
        name: 'Lion Dance Club Management',
        short_name: 'Lion Dance Club',
        description: 'Manage lion dance club events, members, payments and finances.',
        theme_color: '#241d1c',
        background_color: '#f7f4f0',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/lion-dance.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any'
          }
        ]
      },

      workbox: {
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [
          /^\/api\//
        ]
      },

      devOptions: {
        enabled: false
      }
    })
  ],

  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  }
});
