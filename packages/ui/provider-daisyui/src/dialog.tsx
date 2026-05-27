import type { DialogProps } from '@oss/ui-provider-contract';

export function Dialog({ open, onClose, title, description, children }: DialogProps) {
  if (!open) return null;

  return (
    <div className="modal modal-open" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-box">
        {title && <h3 className="text-lg font-bold">{title}</h3>}
        {description && <p className="py-2 text-sm opacity-70">{description}</p>}
        {children}
      </div>
      <button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
        close
      </button>
    </div>
  );
}
