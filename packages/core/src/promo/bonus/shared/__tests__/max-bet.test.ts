import { describe, it } from 'vitest';

describe('resolveMaxBet', () => {
  it.todo('returns the fixed max bet when no rate is set');
  it.todo('returns null when neither a rate nor a fixed max bet is set');
  it.todo('scales the granted amount by the rate');
  it.todo('raises the result to the floor when below it');
  it.todo('lowers the result to the ceiling when above it');
  it.todo('keeps the result when between floor and ceiling');
});

describe('maxBetTermsIssues', () => {
  it.todo('reports no issue for coherent terms');
  it.todo('reports an issue when both a fixed max bet and a rate are given');
  it.todo('reports an issue when the floor is above the ceiling');
  it.todo('reports an issue when a floor or ceiling is given without a rate');
});
