'use client';

import { useUI } from '../ui-provider.js';
import { Skeleton } from './skeleton.js';

export function StatCard({
  label,
  value,
  hint,
  loading = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  loading?: boolean;
}) {
  const { Card } = useUI();
  return (
    <Card className="stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{loading ? <Skeleton width="3.5em" /> : value}</div>
      {hint && <div className="stat-card__hint">{hint}</div>}
    </Card>
  );
}
