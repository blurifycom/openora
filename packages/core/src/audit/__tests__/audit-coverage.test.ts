import { describe, it, expect } from 'vitest';
import { DOMAIN_EVENT_CATALOG } from '@openora/core/contracts';
import { SUBSCRIBED_TOPICS } from '../plugin.js';
import { AUDIT_COVERAGE_GAPS } from '../contract/coverage.js';

describe('audit coverage', () => {
  it('classifies every domain event topic exactly once', () => {
    const classified = [...SUBSCRIBED_TOPICS, ...Object.keys(AUDIT_COVERAGE_GAPS)];

    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...DOMAIN_EVENT_CATALOG].sort());
  });
});
