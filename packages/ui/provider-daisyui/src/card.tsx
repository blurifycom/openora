import type { CardProps } from '@oss/ui-provider-contract';
import { cx } from './cx.js';

export function Card({ children, className }: CardProps) {
  return (
    <div className={cx('card bg-base-100 shadow-sm', className)}>
      <div className="card-body">{children}</div>
    </div>
  );
}
