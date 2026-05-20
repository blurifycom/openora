import type { BadgeProps } from '@oss/ui-provider-contract';

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <span data-variant={variant} className={className}>
      {children}
    </span>
  );
}
