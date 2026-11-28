export type JobWorkerSelection = {
  include: readonly string[] | null;
  exclude: readonly string[];
};

export type SelectedJobWorkers<T> = {
  consumed: T[];
  skipped: T[];
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

export function matches(pattern: string, queue: string): boolean {
  return pattern.endsWith('*') ? queue.startsWith(pattern.slice(0, -1)) : queue === pattern;
}

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
        'Fix the pattern, or select the module that registers the queue: SERVICE_MANIFEST ' +
        'must name it, without ":no-routes".',
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
