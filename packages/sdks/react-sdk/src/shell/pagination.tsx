'use client';

import { useUI } from '../ui-provider.js';

export function Pagination({
  page,
  totalPages,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { Button } = useUI();
  return (
    <div className="pagination">
      <span className="muted">
        Page {page} of {totalPages}
      </span>
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={onPrev}>
        Prev
      </Button>
      <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={onNext}>
        Next
      </Button>
    </div>
  );
}
