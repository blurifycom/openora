import { describe, it } from 'vitest';

describe('player rank and rewards', () => {
  it.todo(
    'wagering past a tier threshold promotes the player and the rank read shows the new tier',
  );
  it.todo('the ladder read is public and lists tiers in order');
  it.todo('the rank lookup by user ids returns only public rank fields and deduplicates ids');
  it.todo('claiming a rank reward credits it once and a repeated claim is refused');
  it.todo(
    'claiming a rank reward that does not exist or belongs to another player returns not found',
  );
  it.todo('reading own rank or rewards without a session is rejected as unauthorized');
});

describe('admin rank ladder', () => {
  it.todo('an admin sets the ladder and the change is audited');
  it.todo('reading the admin ladder before one is configured returns not configured');
  it.todo('a ladder with overlapping or unordered thresholds is refused');
  it.todo('a non-admin setting the ladder or config is refused as forbidden');
});
