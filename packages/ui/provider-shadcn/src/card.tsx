import type { CardProps } from '@oss/ui-provider-contract';

export function Card({ children, className }: CardProps) {
  return <div className={className}>{children}</div>;
}
