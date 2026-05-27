import type { InputProps } from '@oss/ui-provider-contract';
import { cx } from './cx.js';

export function Input({ label, error, className, ...props }: InputProps) {
  return (
    <label className="form-control w-full">
      {label && (
        <div className="label">
          <span className="label-text">{label}</span>
        </div>
      )}
      <input
        {...props}
        className={cx('input input-bordered w-full', error && 'input-error', className)}
        aria-invalid={Boolean(error)}
      />
      {error && (
        <div className="label">
          <span className="label-text-alt text-error" role="alert">
            {error}
          </span>
        </div>
      )}
    </label>
  );
}
