import { describe, it } from 'vitest';

describe('parseArgs', () => {
  it.todo('takes the first positional argument as the target');
  it.todo('reads --name with a space or an equals sign');
  it.todo('--no-telemetry turns telemetry off');
  it.todo('fails with usage when the target is missing');
});

describe('isTelemetryEnabled', () => {
  it.todo('is on by default');
  it.todo('is off when the flag, OPENORA_TELEMETRY_DISABLED or DO_NOT_TRACK is set');
  it.todo('is off in CI and under NODE_ENV test');
  it.todo('does not treat 0 or an empty value as set');
});

describe('sanitizeName', () => {
  it.todo('lowercases and replaces unsafe characters');
  it.todo('trims leading and trailing dashes');
  it.todo('falls back to a default name when nothing is left');
});

describe('emitTree', () => {
  it.todo('substitutes known variables and leaves unknown placeholders');
  it.todo('maps __dot__ segments to dotfiles');
  it.todo('strips the tpl suffix');
  it.todo('creates nested directories');
});

describe('buildVars', () => {
  it.todo('carries the project name and the dependency versions');
});
