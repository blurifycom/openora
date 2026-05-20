import { useState, useCallback } from 'react';
import type { ToastProps, UseToastReturn } from '@oss/ui-provider-contract';

export function useToast(): UseToastReturn {
  const [toasts, setToasts] = useState<ToastProps[]>([]);

  const toast = useCallback((props: Omit<ToastProps, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    const entry: ToastProps = { ...props, id };
    setToasts((prev) => [...prev, entry]);

    const duration = props.duration ?? 4000;
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, toast, dismiss };
}
