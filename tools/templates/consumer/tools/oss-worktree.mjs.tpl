#!/usr/bin/env node
// A git worktree of the sibling OSS checkout - the only place an agent in this repo may change
// OSS code (the guard-core hook allows {{ossFromRoot}}/.worktrees/ and denies the rest of the
// checkout). Same command for every agent and every human, so a paired change looks the same
// on every machine.
//
//   pnpm oss:worktree <branch>            create or reuse the worktree, install its deps
//   pnpm oss:worktree <branch> --link     ...then build it and point `pnpm link:oss` at it
//   pnpm oss:worktree <branch> --remove   remove it; relinks the main checkout if it was linked
//
// Use the same branch name as this repo's branch: that is how skills pair the two requests.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
// oxlint-disable no-console

const OSS = resolve('{{ossFromRoot}}');
const USAGE = 'usage: pnpm oss:worktree <branch> [--link | --remove]';

const die = (message) => {
  console.error(`oss:worktree - ${message}`);
  process.exit(1);
};

const [branch, flag] = process.argv.slice(2);
if (!branch || branch.startsWith('--') || (flag && !['--link', '--remove'].includes(flag))) {
  die(USAGE);
}
if (!existsSync(join(OSS, '.git'))) {
  die(`no OSS checkout at ${OSS} - clone it next to this repo first.`);
}

const worktree = join(OSS, '.worktrees', branch.replaceAll('/', '+'));
const worktreeFromHere = relative(process.cwd(), worktree);
const git = (...args) =>
  execFileSync('git', ['-C', OSS, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const gitOrEmpty = (...args) => {
  try {
    return execFileSync('git', ['-C', OSS, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
};
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const hasLinkScript = () =>
  Boolean(JSON.parse(readFileSync('package.json', 'utf8')).scripts?.['link:oss']);
const isLinkedTo = (dir) =>
  existsSync('pnpm-workspace.yaml') &&
  readFileSync('pnpm-workspace.yaml', 'utf8').includes(`link:${relative(process.cwd(), dir)}/`);

if (flag === '--remove') {
  const wasLinked = isLinkedTo(worktree);
  if (existsSync(worktree)) {
    try {
      git('worktree', 'remove', worktree);
    } catch {
      die(`${worktreeFromHere} has uncommitted changes - commit or discard them, then rerun.`);
    }
  }
  if (wasLinked && hasLinkScript()) {
    run('pnpm', ['link:oss']);
  }
  console.log(`removed ${worktreeFromHere}`);
  process.exit(0);
}

if (!existsSync(worktree)) {
  git('fetch', 'origin', '--quiet');
  const base = gitOrEmpty('rev-parse', '--abbrev-ref', 'origin/HEAD') || 'origin/dev';
  if (gitOrEmpty('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) {
    git('worktree', 'add', worktree, branch);
  } else if (gitOrEmpty('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)) {
    git('worktree', 'add', '--track', '-b', branch, worktree, `origin/${branch}`);
  } else {
    git('worktree', 'add', '--no-track', '-b', branch, worktree, base);
  }
  run('pnpm', ['-C', worktree, 'install', '--frozen-lockfile']);
}

if (flag === '--link') {
  if (!hasLinkScript()) {
    die('this repo has no `link:oss` script - link the worktree through pnpm overrides by hand.');
  }
  // @openora/* resolve from dist/, so a linked worktree works only once it is built.
  run('pnpm', ['-C', worktree, 'build']);
  run('pnpm', ['link:oss', worktreeFromHere]);
}

console.log(worktreeFromHere);
