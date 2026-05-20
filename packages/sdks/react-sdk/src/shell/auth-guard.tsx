'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '../hooks/auth.js';

type SessionResponse = { id?: string; user?: { id?: string } } | null | undefined;

export function AuthGuard({
  children,
  loginPath = '/login',
}: {
  children: ReactNode;
  loginPath?: string;
}) {
  const router = useRouter();
  const { data, isLoading, isError } = useSession() as {
    data: SessionResponse;
    isLoading: boolean;
    isError: boolean;
  };

  // /identity/me returns the user object directly. Older shapes wrapped it as
  // { user }. Accept either.
  const hasSession = !!(data?.id ?? data?.user?.id);

  useEffect(() => {
    if (!isLoading && (isError || !hasSession)) {
      router.replace(loginPath);
    }
  }, [isLoading, isError, hasSession, router, loginPath]);

  if (isLoading || !hasSession) {
    return (
      <div className="auth-screen">
        <div className="muted">Loading...</div>
      </div>
    );
  }

  return <>{children}</>;
}
