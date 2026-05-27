import type { ReactNode } from 'react';
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router';
import { Providers } from '../providers';
import { PlayerShell } from '../components/player-shell';
import appStyles from '../styles.css?url';
import ossStyles from '@oss/react-sdk/styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: '{{name}}' },
    ],
    links: [
      { rel: 'stylesheet', href: appStyles },
      { rel: 'stylesheet', href: ossStyles },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Providers>
        <PlayerShell>
          <Outlet />
        </PlayerShell>
      </Providers>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
