'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  usePlayerProfile,
  useUpdatePlayerProfile,
  useChangePassword,
  useEnable2fa,
  useVerify2fa,
  useUI,
  type Enable2faResult,
} from '@oss/react-hooks';

function errorOf(e: unknown): string | undefined {
  return e instanceof Error ? e.message : undefined;
}

// Profile preferences (display name / currency / language) + security
// (password change, 2FA enrolment). Each section is an independent form so a
// failure in one does not block the others.
export function PlayerSettingsPage() {
  const { Card } = useUI();
  return (
    <div className="settings-page">
      <h1 className="settings-page__title">Settings</h1>
      <Card className="settings-page__section">
        <ProfileSection />
      </Card>
      <Card className="settings-page__section">
        <ChangePasswordSection />
      </Card>
      <Card className="settings-page__section">
        <TwoFactorSection />
      </Card>
    </div>
  );
}

function ProfileSection() {
  const { Input, Button } = useUI();
  const profile = usePlayerProfile();
  const update = useUpdatePlayerProfile();
  const [displayName, setDisplayName] = useState('');
  const [currency, setCurrency] = useState('');
  const [language, setLanguage] = useState('');

  // Seed the form once the profile loads.
  useEffect(() => {
    if (profile.data) {
      setDisplayName(profile.data.displayName);
      setCurrency(profile.data.currency);
      setLanguage(profile.data.language);
    }
  }, [profile.data]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    await update.mutateAsync({ displayName, currency, language }).catch(() => {});
  };

  return (
    <form className="settings-page__form" onSubmit={onSubmit}>
      <h2>Profile</h2>
      <Input label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      <Input label="Display currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
      <Input label="Language" value={language} onChange={(e) => setLanguage(e.target.value)} />
      {update.isSuccess && <div className="settings-page__ok">Saved.</div>}
      {errorOf(update.error) && <div className="auth-screen__error">{errorOf(update.error)}</div>}
      <Button type="submit" loading={update.isPending}>
        Save profile
      </Button>
    </form>
  );
}

function ChangePasswordSection() {
  const { Input, Button } = useUI();
  const change = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    try {
      await change.mutateAsync({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
    } catch {
      // surfaced via change.error
    }
  };

  return (
    <form className="settings-page__form" onSubmit={onSubmit}>
      <h2>Change password</h2>
      <Input
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        required
      />
      <Input
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        minLength={8}
        required
      />
      {change.isSuccess && <div className="settings-page__ok">Password updated.</div>}
      {errorOf(change.error) && <div className="auth-screen__error">{errorOf(change.error)}</div>}
      <Button type="submit" loading={change.isPending}>
        Update password
      </Button>
    </form>
  );
}

function TwoFactorSection() {
  const { Input, Button } = useUI();
  const enable = useEnable2fa();
  const verify = useVerify2fa();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrolment, setEnrolment] = useState<Enable2faResult | null>(null);

  const onEnable = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    try {
      setEnrolment(await enable.mutateAsync({ password }));
    } catch {
      // surfaced via enable.error
    }
  };

  const onVerify = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    await verify.mutateAsync({ code }).catch(() => {});
  };

  if (verify.isSuccess) {
    return (
      <div className="settings-page__form">
        <h2>Two-factor authentication</h2>
        <div className="settings-page__ok">Two-factor authentication is enabled.</div>
      </div>
    );
  }

  if (enrolment) {
    return (
      <form className="settings-page__form" onSubmit={onVerify}>
        <h2>Two-factor authentication</h2>
        <p>Scan this URI in your authenticator app, then enter the 6-digit code:</p>
        <code className="settings-page__totp">{enrolment.totpUri}</code>
        <p>
          Backup codes: <strong>{enrolment.backupCodes.join(', ')}</strong>
        </p>
        <Input label="Authenticator code" value={code} onChange={(e) => setCode(e.target.value)} required />
        {errorOf(verify.error) && <div className="auth-screen__error">{errorOf(verify.error)}</div>}
        <Button type="submit" loading={verify.isPending}>
          Verify and enable
        </Button>
      </form>
    );
  }

  return (
    <form className="settings-page__form" onSubmit={onEnable}>
      <h2>Two-factor authentication</h2>
      <p>Add an extra layer of security with an authenticator app.</p>
      <Input
        label="Confirm password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {errorOf(enable.error) && <div className="auth-screen__error">{errorOf(enable.error)}</div>}
      <Button type="submit" loading={enable.isPending}>
        Set up 2FA
      </Button>
    </form>
  );
}
