'use client';

import { useEffect, type ReactNode } from 'react';
import { useNavigate, useSession } from '@oss/react-hooks';

type SessionResponse = { id?: string; user?: { id?: string } } | null | undefined;

export function AuthGuard({
  children,
  loginPath = '/login',
}: {
  children: ReactNode;
  loginPath?: string;
}) {
  const navigate = useNavigate();
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
      navigate.replace(loginPath);
    }
  }, [isLoading, isError, hasSession, navigate, loginPath]);

  if (isLoading || !hasSession) {
    return (
      <div className="auth-screen">
        <div className="muted">Loading...</div>
      </div>
    );
  }

  return <>{children}</>;
}
