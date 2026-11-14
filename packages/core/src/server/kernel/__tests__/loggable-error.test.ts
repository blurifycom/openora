import { describe, expect, it } from 'vitest';
import { loggableError } from '../loggable-error.js';

describe('loggableError', () => {
  it('keeps the name and code of an error and drops its message', () => {
    const err = Object.assign(new TypeError('token hash 9f86d081 leaked'), { code: 'E_TOKEN' });

    expect(loggableError(err)).toStrictEqual({ name: 'TypeError', code: 'E_TOKEN' });
  });

  it('reads the code off the cause when the error carries none', () => {
    const cause = Object.assign(new Error('terminating connection'), { code: '57P01' });
    const err = new Error('Failed query: select * from mcp_token\nparams: 9f86d081', { cause });

    expect(loggableError(err)).toStrictEqual({ name: 'Error', code: '57P01' });
  });

  it('turns a numeric code into a string', () => {
    expect(loggableError(Object.assign(new Error('x'), { code: 503 }))).toStrictEqual({
      name: 'Error',
      code: '503',
    });
  });

  it('names an error without a code by its class alone', () => {
    expect(loggableError(new RangeError('Maximum call stack size exceeded'))).toStrictEqual({
      name: 'RangeError',
    });
  });

  it('names a thrown value that is not an error by its type', () => {
    expect(loggableError('password=hunter2')).toStrictEqual({ name: 'string' });
    expect(loggableError({ code: 'E_X', message: 'secret' })).toStrictEqual({ name: 'object' });
  });
});
