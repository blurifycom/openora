import type { BadgeProps } from '@oss/ui-provider-contract';
import { cx } from './cx.js';

const VARIANT: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'badge-neutral',
  success: 'badge-success',
  warning: 'badge-warning',
  destructive: 'badge-error',
  outline: 'badge-outline',
};

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <span className={cx('badge', VARIANT[variant], className)} data-variant={variant}>
      {children}
    </span>
  );
}
