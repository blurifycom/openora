/**
 * Inline SVG icon set. Stroke-based, 14px nominal, currentColor.
 * Tiny on purpose - the type carries the page; icons are punctuation.
 */
import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export function DashboardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="2" width="5.5" height="5.5" />
      <rect x="8.5" y="2" width="5.5" height="3" />
      <rect x="8.5" y="6" width="5.5" height="8" />
      <rect x="2" y="8.5" width="5.5" height="5.5" />
    </svg>
  );
}

export function UsersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="5.5" r="2.6" />
      <path d="M1.5 13.5c0-2.2 2-3.7 4.5-3.7s4.5 1.5 4.5 3.7" />
      <circle cx="11.5" cy="6" r="1.8" />
      <path d="M11.5 9.6c1.5 0 3 .9 3 2.5" />
    </svg>
  );
}

export function PlayersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="5" r="2.8" />
      <path d="M2.5 13.5c0-2.6 2.5-4.2 5.5-4.2s5.5 1.6 5.5 4.2" />
    </svg>
  );
}

export function GamesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="1.5" y="4" width="13" height="8" rx="2" />
      <path d="M4 7v2M3 8h2" />
      <circle cx="11" cy="7" r="0.6" fill="currentColor" />
      <circle cx="12.5" cy="9" r="0.6" fill="currentColor" />
    </svg>
  );
}

export function LogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M9.5 2.5h-6v11h6" />
      <path d="M11 5.5L14 8l-3 2.5" />
      <path d="M14 8H6.5" />
    </svg>
  );
}
