import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'RamosMAX Management System',
    template: '%s · RamosMAX',
  },
  description: 'RamosMAX Automotive Care (U) Ltd — management system.',
  applicationName: 'RamosMAX',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'RamosMAX',
    statusBarStyle: 'black-translucent',
  },
  // Staff data must never be indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never lock zoom: staff need to magnify amounts and plate numbers.
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#362060' },
    { media: '(prefers-color-scheme: dark)', color: '#121016' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-UG">
      <body>{children}</body>
    </html>
  );
}
