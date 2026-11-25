import { describe, it } from 'vitest';

describe('ExchangeRateService', () => {
  it.todo(
    'refuses a source or target currency the operator does not offer without calling the reader',
  );
  it.todo('checks currencies case-insensitively');
  it.todo(
    'answers a batch with a null quote for an unsupported source currency instead of failing the batch',
  );
  it.todo('refuses a batch whose target currency is unsupported');
  it.todo('answers a batch in the order of the requested currencies');
});
