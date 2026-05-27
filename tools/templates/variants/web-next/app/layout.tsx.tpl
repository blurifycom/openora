import type { ReactNode } from 'react';
import { Bricolage_Grotesque, Hanken_Grotesk, JetBrains_Mono } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';
import '@oss/react-sdk/styles.css';

const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});
const body = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-body', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata = { title: '{{name}}' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
