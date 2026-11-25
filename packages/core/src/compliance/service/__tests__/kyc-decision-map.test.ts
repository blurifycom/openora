import { describe, it } from 'vitest';

describe('vendor status mapping', () => {
  it.todo('maps approved, rejected, pending and not started to the matching KYC status');
});

describe('vendor decision gate', () => {
  it.todo(
    'an underage date of birth declines with the underage reason regardless of vendor status',
  );
  it.todo('an approved vendor status with all checks approved stays approved');
  it.todo(
    'an approved vendor status with a failed or unknown check requests resubmission with the check named',
  );
  it.todo('an approved vendor status with an empty check list requests resubmission');
  it.todo('an approved vendor status without a check list is approved');
  it.todo('an approved vendor status with an unreadable date of birth requests resubmission');
  it.todo('a rejected vendor status stays rejected even when all checks are approved');
  it.todo('a pending vendor status passes through unchanged');
});

describe('decided statuses and manual override', () => {
  it.todo('approved, rejected and manually overridden count as decided');
  it.todo('pending, not started and resubmission requested count as undecided');
  it.todo('a manual approved override resolves to manually overridden');
  it.todo('a manual rejected override resolves to rejected');
  it.todo('duplicate device or high-risk country signals warrant the high-risk tag');
  it.todo('no risk signal does not warrant the high-risk tag');
});
