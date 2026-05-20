'use client';

import { Fragment, type CSSProperties } from 'react';

/**
 * A single shimmering placeholder block. Sized via props; styled by the
 * `.skeleton` rules in styles.css so it picks up the active theme surface.
 */
export function Skeleton({
  width = '100%',
  height = '1em',
  radius,
  className,
  style,
}: {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{ width, height, ...(radius !== undefined ? { borderRadius: radius } : {}), ...style }}
      aria-hidden="true"
    />
  );
}

/** A stack of skeleton lines, the last one shortened, for paragraph-ish blocks. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height="0.85em" width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  );
}

/** Placeholder for a detail page: a title plus a grid of label/value rows. */
export function SkeletonDetail({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      <div className="page-header">
        <div>
          <Skeleton width="14rem" height="2.25rem" />
          <div style={{ marginTop: '0.6rem' }}>
            <Skeleton width="9rem" height="0.7rem" />
          </div>
        </div>
        <Skeleton width="6rem" height="2rem" />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          columnGap: '2rem',
          rowGap: '1rem',
        }}
      >
        {Array.from({ length: rows }).map((_, i) => (
          <Fragment key={i}>
            <Skeleton width="6rem" height="0.7rem" />
            <Skeleton width={`${40 + ((i * 13) % 45)}%`} height="0.9rem" />
          </Fragment>
        ))}
      </div>
    </div>
  );
}
