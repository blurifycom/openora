import type { DialogProps } from '@oss/ui-provider-contract';

export function Dialog({ open, onClose, title, description, children }: DialogProps) {
  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label={title}>
      <div onClick={onClose} aria-hidden="true" />
      <div>
        {title && <h2>{title}</h2>}
        {description && <p>{description}</p>}
        {children}
      </div>
    </div>
  );
}
