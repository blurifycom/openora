import { describe, it } from 'vitest';

describe('parseServiceManifest', () => {
  it.todo('returns null when the manifest is unset');
  it.todo('returns null when the manifest is blank');
  it.todo('parses ids separated by commas or whitespace');
  it.todo('parses the no-routes flag');
  it.todo('rejects an unknown flag or extra segments');
  it.todo('rejects an id named both with and without no-routes');
  it.todo('collapses a repeated id');
});

describe('applyServiceManifest', () => {
  it.todo('returns every entry when there is no manifest');
  it.todo('keeps only the listed modules');
  it.todo('fails on an unknown module id and lists the known ids');
  it.todo('keeps a module the listed modules depend on only when it is listed');
  it.todo('a module marked no-routes loads without mounting its routers');
});

describe('service completeness', () => {
  it.todo('a service missing a port its kept modules require fails the boot with a clear error');
  it.todo('a complete service passes the check');
});
