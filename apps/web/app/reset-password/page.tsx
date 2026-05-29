import { Suspense } from 'react';
import { ResetPasswordPage } from '@oss/react-pages';

// Reads the reset token from the query string (useSearchParams) -> dynamic.
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense>
      <ResetPasswordPage />
    </Suspense>
  );
}
