import { describe, it } from 'vitest';

describe('adminMutationAudit', () => {
  it.todo(
    'records one admin resource action row for a successful mutation that noted nothing audit-worthy',
  );
  it.todo('does not add a row when the mutation already wrote its own audit row');
  it.todo('does not add a row when it published a topic the audit module covers');
  it.todo('records a failure row when a mutation throws after audit-worthy work was rolled back');
  it.todo('does not record anything for a read method');
  it.todo('does not record anything for an authorization or permission denial');
  it.todo('a failing fallback write is logged and does not change the response to the admin');
});
