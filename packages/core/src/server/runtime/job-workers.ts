/**
 * Which job queues this process consumes, from `JOB_WORKERS`. `include: null` is every queue,
 * `[]` none; a pattern is a queue name or a prefix ending in `*`.
 */
export type JobWorkerSelection = {
  include: readonly string[] | null;
  exclude: readonly string[];
};

export type SelectedJobWorkers<T> = {
  consumed: T[];
  skipped: T[];
  /** Exclusions no registered queue matched - allowed, an optional module may be absent. */
  idleExclusions: string[];
};

function invalid(entry: string, rule: string): Error {
  return new Error(`[create-app] JOB_WORKERS: "${entry}" ${rule}.`);
}

function assertPattern(pattern: string, entry: string): void {
  if (pattern.length === 0) {
    throw invalid(entry, 'names no queue');
  }
  if (pattern.slice(0, -1).includes('*')) {
    throw invalid(entry, 'may use "*" only at its end, as a prefix');
  }
}

/**
 * Parses `JOB_WORKERS`: comma- or space-separated queue names and `prefix*` patterns, `!` before
 * one to exclude it, `*`/`all` for every queue and `none` for none. Unset or blank is null -
 * every queue, as before the variable existed. Only exclusions mean every queue but those.
 */
export function parseJobWorkers(raw: string | undefined): JobWorkerSelection | null {
  const entries = (raw ?? '').split(/[,\s]+/).filter(Boolean);
  if (entries.length === 0) {
    return null;
  }

  const include: string[] = [];
  const exclude: string[] = [];
  let all = false;
  let none = false;
  for (const entry of entries) {
    if (entry.startsWith('!')) {
      const pattern = entry.slice(1);
      assertPattern(pattern, entry);
      exclude.push(pattern);
    } else if (entry === '*' || entry === 'all') {
      all = true;
    } else if (entry === 'none') {
      none = true;
    } else {
      assertPattern(entry, entry);
      include.push(entry);
    }
  }
  if (none && entries.length > 1) {
    throw invalid(entries.join(','), 'combines "none" with other entries; "none" stands alone');
  }
  if (all && include.length > 0) {
    throw invalid(entries.join(','), 'combines every queue with named ones; exclude with "!"');
  }

  return { include: none ? [] : include.length > 0 ? include : null, exclude };
}

function matches(pattern: string, queue: string): boolean {
  return pattern.endsWith('*') ? queue.startsWith(pattern.slice(0, -1)) : queue === pattern;
}

/**
 * Splits the registered workers into the ones this process consumes and the ones it leaves to
 * another. A queue named for inclusion that nothing registers fails the boot: a typo would
 * otherwise leave a worker process idle while its queue backs up.
 */
export function selectJobWorkers<T extends { queue: string }>(
  registrations: readonly T[],
  selection: JobWorkerSelection | null,
): SelectedJobWorkers<T> {
  if (selection === null) {
    return { consumed: [...registrations], skipped: [], idleExclusions: [] };
  }

  const queues = [...new Set(registrations.map((r) => r.queue))];
  const unmatched = (selection.include ?? []).filter((p) => !queues.some((q) => matches(p, q)));
  if (unmatched.length > 0) {
    throw new Error(
      `[create-app] JOB_WORKERS names queues this process does not register: ` +
        `${unmatched.join(', ')}. Registered queues: ${queues.join(', ') || '(none)'}. ` +
        'Fix the pattern, or load the module that registers the queue (check SERVICE_MANIFEST).',
    );
  }

  const consumes = (queue: string): boolean =>
    (selection.include === null || selection.include.some((p) => matches(p, queue))) &&
    !selection.exclude.some((p) => matches(p, queue));
  return {
    consumed: registrations.filter((r) => consumes(r.queue)),
    skipped: registrations.filter((r) => !consumes(r.queue)),
    idleExclusions: selection.exclude.filter((p) => !queues.some((q) => matches(p, q))),
  };
}
