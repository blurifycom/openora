import { describe, it } from 'vitest';

describe('isAllowedHost', () => {
  it.todo('accepts a listed host regardless of case');
  it.todo('refuses an unlisted host and a lookalike suffix');
  it.todo('refuses everything with an empty allow-list');
});

describe('isAllowedHttpsUrl', () => {
  it.todo('accepts an https url on a listed host');
  it.todo('refuses http and non-http schemes');
  it.todo('refuses a url with credentials or an unparseable url');
});

describe('isAllowedUrlPrefix', () => {
  it.todo('accepts a url under a listed prefix');
  it.todo('refuses a url that only shares a string prefix with a different path segment');
  it.todo('refuses a url with a different origin');
});
