import { describe, it } from 'vitest';

describe('normalizeUserAgent and deviceHash', () => {
  it.todo('a null or undefined user agent normalises to the empty value');
  it.todo('case and repeated whitespace do not change the hash');
  it.todo('a minor browser version bump does not change the hash');
  it.todo('a different browser or operating system changes the hash');
});

describe('isSameDevice', () => {
  it.todo('two user agents differing only by minor version are the same device');
  it.todo('two user agents of different browsers are different devices');
  it.todo('two missing user agents are the same device');
});

describe('describeDevice', () => {
  it.todo('a missing user agent is labelled unknown');
  it.todo('an unrecognised user agent is labelled unknown');
  it.todo('Edge is detected before Chrome');
  it.todo('Opera is detected before Chrome');
  it.todo(
    'Chrome on Windows, Safari on macOS, Firefox on Linux and Chrome on Android get a browser on operating system label',
  );
  it.todo('iPhone and iPad user agents are labelled iOS');
  it.todo('a known operating system with an unknown browser returns only the operating system');
});

describe('isSuspiciousIpChange', () => {
  it.todo('policy off never flags a change');
  it.todo('a missing session ip or request ip never flags');
  it.todo('an identical ip never flags');
  it.todo('policy any flags every different ip');
  it.todo('policy country flags a change between two different countries');
  it.todo('policy country does not flag when either country is unresolved');
  it.todo('policy country compares countries case insensitively');
});

describe('trustedDeviceExpiry', () => {
  it.todo('adds the configured number of days to the given time');
  it.todo('zero days returns the given time');
});
