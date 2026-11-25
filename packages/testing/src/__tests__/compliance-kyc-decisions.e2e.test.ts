import { describe, it } from 'vitest';

describe('KYC submission and vendor decisions', () => {
  it.todo('player submits KYC and the status becomes pending with a vendor reference');
  it.todo('player submits KYC again while a verification is in progress and gets a conflict');
  it.todo(
    'vendor webhook with an approved decision approves the player and emits the status change',
  );
  it.todo('vendor webhook with a rejected decision declines the player and keeps the block');
  it.todo(
    'vendor webhook that is approved but has an incomplete check moves the player to resubmission requested',
  );
  it.todo('vendor webhook for an underage player declines with the underage reason');
  it.todo('vendor webhook with an unreadable date of birth requests resubmission');
  it.todo('vendor webhook with an invalid signature is rejected and changes nothing');
  it.todo('vendor webhook replayed with the same reference leaves a single decision row');
  it.todo('vendor webhook whose reference belongs to another player is refused');
  it.todo('vendor webhook whose tier disagrees with the stored verification is refused');
});

describe('KYC status stream and views', () => {
  it.todo('player stream receives the new status when a vendor decision lands');
  it.todo('player stream never receives another player status');
  it.todo('unauthenticated client cannot open the KYC status stream');
  it.todo('player reads own KYC view with basic and enhanced sections');
  it.todo('player cannot read another player KYC view and admin can');
});

describe('Admin KYC actions', () => {
  it.todo('admin requests resubmission and the player sees resubmission requested');
  it.todo('admin requests resubmission twice and gets a conflict');
  it.todo('admin overrides a player to approved and the status reads manually overridden');
  it.todo('admin overrides a player that has no verification and gets not found');
  it.todo('admin bulk-approves several players and each gets an audit row');
  it.todo('player cannot override, resubmit or bulk-approve');
  it.todo('admin requests enhanced KYC while a verification is in progress and gets a conflict');
});
