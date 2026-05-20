import type { ButtonProps } from '@oss/ui-provider-contract';

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  children,
  ...props
}: ButtonProps) {
  return (
    <button {...props} disabled={loading ?? props.disabled} data-variant={variant} data-size={size}>
      {loading ? '...' : children}
    </button>
  );
}
