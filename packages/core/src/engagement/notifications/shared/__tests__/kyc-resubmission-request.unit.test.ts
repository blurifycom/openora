import { describe, expect, it } from 'vitest';
import { isStaffKycResubmissionRequest } from '../kyc-resubmission-request.js';

type Input = Parameters<typeof isStaffKycResubmissionRequest>[0];

describe('isStaffKycResubmissionRequest', () => {
  it.each<[Input['status'], Input['source'], boolean]>([
    ['resubmission_requested', 'manual', true],
    ['resubmission_requested', 'vendor', false],
    ['resubmission_requested', 'webhook', false],
    ['resubmission_requested', 'reverify', false],
    ['resubmission_requested', 'exemption', false],
    ['approved', 'manual', false],
    ['rejected', 'manual', false],
    ['pending', 'manual', false],
  ])('status %s from %s is a staff request: %s', (status, source, expected) => {
    expect(isStaffKycResubmissionRequest({ status, source })).toBe(expected);
  });
});
