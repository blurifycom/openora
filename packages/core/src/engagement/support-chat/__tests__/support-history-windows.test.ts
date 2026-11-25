import { describe, it } from 'vitest';

describe('support history email windows', () => {
  it.todo('an item inside the window of a previous email is attributed to that email');
  it.todo('the first window is bounded by account creation when there is no earlier change');
  it.todo('an item before the first window is excluded');
  it.todo('only the three most recent previous emails are kept');
  it.todo('a redelivered email change event is dropped and the first row stays');
  it.todo('a row timed by its write time is never dropped as a redelivery');
  it.todo('an invalid carried change time falls back to the write time');
  it.todo('a change stamped within clock skew of its audit row keeps its carried time');
  it.todo('a null before or after email yields an open ended window');
});
