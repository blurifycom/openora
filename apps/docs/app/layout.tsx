import { Bricolage_Grotesque, Hanken_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['400', '500', '600', '700', '800'],
});

const sans = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-sans-doc',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-mono-doc',
  weight: ['400', '500', '600'],
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
