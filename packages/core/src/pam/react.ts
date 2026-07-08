// `@openora/core/pam/react` - domain-owned hooks, keeping the base @openora/core/react SDK domain-agnostic.
export {
  useCurrentUser,
  useLogin,
  useLogout,
  useRegister,
  useRequestPasswordReset,
  useResetPassword,
} from './identity/react/auth.js';
export {
  useEnable2fa,
  useVerify2fa,
  useDisable2fa,
  useVerifyEmail,
  useUpdateProfile,
  useChangePassword,
  useSendEmailVerification,
  type Enable2faResult,
} from './identity/react/account.js';
export {
  usePlayerProfile,
  useUpdatePlayerProfile,
  type PlayerProfile,
} from './profile/react/profile.js';
