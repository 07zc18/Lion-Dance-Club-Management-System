import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),

    VitePWA({
      registerType: 'autoUpdate',

      includeAssets: ['lion-sync.svg'],

      manifest: {
        name: 'LionSync',
        short_name: 'LionSync',
        description: 'LionSync - manage lion dance club events, members, payments and finances.',
        theme_color: '#4b141b',
        background_color: '#f7f4f0',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/lion-sync.svg',
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
