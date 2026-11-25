import { describe, it } from 'vitest';

describe('entry validation', () => {
  it.todo('rejects a registry that is not an array');
  it.todo('rejects an entry that is not an object');
  it.todo('rejects an entry with a missing or empty id');
  it.todo('rejects an entry with a missing or empty path');
  it.todo('rejects a duplicate plugin id');
});

describe('entry matches plugin', () => {
  it.todo('fails the boot when the entry id differs from the id of the plugin it loads');
  it.todo('fails when the module does not default-export a valid plugin');
});

describe('ports and dependencies', () => {
  it.todo('a plugin with an unbound required port fails the boot naming the plugin and the port');
  it.todo('a plugin with every required port bound boots');
  it.todo('an unbound optional port is reported in a warning and does not fail');
  it.todo('a plugin depending on an unregistered plugin fails with a clear error');
  it.todo('a circular plugin dependency fails and names the cycle');
  it.todo('plugins register after the plugins they depend on');
});
