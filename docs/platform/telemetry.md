# Usage telemetry

Openora reports anonymous usage so we know how many installs are running and which versions
and runtimes they're on. It's on by default and takes one environment variable to turn off.
The decision is in [ADR-0044](../adr/0044-opt-out-anonymous-usage-telemetry.md).

## What is sent

Every report carries the same fields and nothing else:

- a random instance id, generated on first boot and stored in the database, so one deployment
  counts once however many replicas it runs
- the `@openora/core` version
- the Node.js version, the operating system and the CPU architecture
- how many players were active in the last day and the last 30 days, as two plain counts (empty
  when the player module isn't loaded)

No hostname, IP-derived data, player id, operator name, config value or request data is sent.
The collector sees the sending IP like any HTTP server does. Umami turns it into a country and
doesn't keep the raw address.

## When

- On server start, at most once an hour per deployment, so a crash loop or a rolling deploy
  doesn't flood the collector.
- Once a day from the job queue, so a server that runs for months still counts as active. The
  queue fires it once per day across all replicas.
- Once when `npm create @openora` scaffolds a project. The scaffolder sends a fresh random id
  each run, so every run counts as one project, whoever ran it.

A report that fails is dropped with one warning in the log. Nothing retries, and a failure
never delays or breaks boot.

## Where

Reports go to `https://telemetry.openora.ai`, an [Umami](https://umami.is) instance run by the
Openora maintainers. `OPENORA_TELEMETRY_URL` points them somewhere else, for example a collector
of your own.

## Turning it off

Any one of these switches it off. Nothing is sent and the daily job is removed from the queue:

```bash
OPENORA_TELEMETRY_DISABLED=1   # or the cross-tool standard DO_NOT_TRACK=1
```

```ts
createApp({ ...config, telemetry: false });
```

```bash
npm create @openora my-app -- --no-telemetry
```

It's always off under `NODE_ENV=test` or when `CI` is set, so pipeline and e2e runs don't count as
installs. The server logs one line at boot when telemetry is on, with the switch to turn it off.
