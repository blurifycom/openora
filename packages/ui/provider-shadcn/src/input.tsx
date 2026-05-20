import type { InputProps } from '@oss/ui-provider-contract';

export function Input({ label, error, ...props }: InputProps) {
  return (
    <div>
      {label && <label>{label}</label>}
      <input {...props} aria-invalid={Boolean(error)} />
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
