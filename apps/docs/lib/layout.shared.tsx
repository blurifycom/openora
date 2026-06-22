import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-display" style={{ fontWeight: 700, letterSpacing: '-0.03em' }}>
          OSS <span style={{ color: 'var(--color-fd-primary)' }}>iGaming</span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
