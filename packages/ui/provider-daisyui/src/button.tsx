import type { ButtonProps } from '@oss/ui-provider-contract';
import { cx } from './cx.js';

const VARIANT: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  destructive: 'btn-error',
  outline: 'btn-outline',
};

const SIZE: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  children,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cx('btn', VARIANT[variant], SIZE[size], className)}
      disabled={loading ?? props.disabled}
      data-variant={variant}
      data-size={size}
    >
      {loading ? <span className="loading loading-spinner loading-sm" /> : children}
    </button>
  );
}
