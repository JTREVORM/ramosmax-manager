import type { MetadataRoute } from 'next';

/**
 * PWA manifest. RamosMAX is installable so staff can add it to a phone home
 * screen and run it like an app — and because iOS Safari only delivers Web
 * Push to an installed PWA (iOS 16.4+), which the notification strategy
 * depends on.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RamosMAX Management System',
    short_name: 'RamosMAX',
    description: 'RamosMAX Automotive Care (U) Ltd — management system.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f7f7f9',
    theme_color: '#362060',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
