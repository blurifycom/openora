'use client';

import { useId } from 'react';

export type TimeSeriesPoint = { date: string; count: number };

/**
 * Dependency-free SVG area chart. Themed via `--bo-*` variables so it inherits
 * whatever palette `ThemeProvider` is serving. No charting library - keeps the
 * consumer bundle lean (a igaming admin doesn't need recharts for one sparkline).
 */
export function TimeSeriesChart({
  data,
  height = 220,
  label,
}: {
  data: TimeSeriesPoint[];
  height?: number;
  label?: string;
}) {
  const gradId = useId().replace(/:/g, '');
  const width = 720;
  const padX = 8;
  const padY = 12;

  if (data.length === 0) {
    return <div className="muted">No data for this window.</div>;
  }

  const max = Math.max(1, ...data.map((d) => d.count));
  const stepX = (width - padX * 2) / Math.max(1, data.length - 1);
  const scaleY = (v: number): number => height - padY - (v / max) * (height - padY * 2);

  const pts = data.map((d, i) => [padX + i * stepX, scaleY(d.count)] as const);
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const area =
    `M${pts[0]![0].toFixed(1)},${(height - padY).toFixed(1)} ` +
    pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
    ` L${pts[pts.length - 1]![0].toFixed(1)},${(height - padY).toFixed(1)} Z`;

  const total = data.reduce((s, d) => s + d.count, 0);
  const peak = data.reduce((a, b) => (b.count > a.count ? b : a), data[0]!);

  return (
    <div className="chart">
      {label && (
        <div className="chart__header">
          <span className="chart__label">{label}</span>
          <span className="chart__meta">
            {total} total · peak {peak.count} on {peak.date}
          </span>
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="chart__svg"
        role="img"
        aria-label={label ?? 'time series'}
      >
        <defs>
          <linearGradient id={`g-${gradId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--bo-accent)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--bo-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#g-${gradId})`} />
        <path
          d={line}
          fill="none"
          stroke="var(--bo-accent)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r="1.6"
            fill="var(--bo-accent-bright)"
            vectorEffect="non-scaling-stroke"
          >
            <title>
              {data[i]!.date}: {data[i]!.count}
            </title>
          </circle>
        ))}
      </svg>
      <div className="chart__axis">
        <span>{data[0]!.date}</span>
        <span>{data[data.length - 1]!.date}</span>
      </div>
    </div>
  );
}
