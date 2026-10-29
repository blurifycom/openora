---
name: ui-verify
targets: ['*']
description: >
  Verify a UI change in a real browser with the global `playwright-cli`: cheap checks first,
  then four screenshots per changed screen read for spacing, overlap, cut text and contrast,
  then the per-AC videos for the PR. Use after any change to a page, component, style or
  player/operator flow, on "check it looks right", "verify the UI", "does it render", "take a
  screenshot", "record a video", and to reproduce a UI bug before fixing it.
claudecode:
  context: fork
  model: sonnet
  effort: medium
---

# ui-verify ({{name}})

Global `playwright-cli` (`@playwright/cli`), never a browser MCP: it costs a fraction of the
tokens. Do not spawn subagents. Return text only. A subagent (`tester`, `builder`) does not
invoke this skill, which forks one of its own: it reads this file and follows it itself.

## Stack

- Player app :3000, backoffice :3002, API :3001, unless the repo's rules name other ports (a
  worktree slot, say). Ports held by another checkout: never kill it, ask.
- Accounts: the seed's (`admin@oss.dev` / `password1234` after `pnpm db:seed`). Save a login once
  with `state-save /tmp/ui-verify/<app>.json`, `state-load` it after.
- Theme: switch with the app's own toggle in a video; for a still, set what the toggle sets
  (a cookie or `localStorage`) with `eval`, then reload.

## Cost ladder

Deterministic checks first, reading pixels last. Write each check as an assertion with an
expected value (`[data-testid=balance]` text matches `/\d+(\.\d+)? USDT/`) and stop at the
first rung that answers it.

1. **Shell.** The route serves: `curl -s -o /dev/null -w '%{http_code}' <url>`.
2. **Browser, one value.** `eval` for existence, text, count, computed style; `console error`
   and `requests` grepped for `4\d\d|5\d\d`; `find "<text>"` for one node.
3. **Structure.** `snapshot <target>` scoped to the changed component; a full-page `snapshot`
   only with `--depth` or `--filename` + `grep`.
4. **Pixels.** The screenshot review below.

Batch commands in one bash call. Output over ~50 lines goes to `/tmp/ui-verify/` and gets
`grep`, not read whole. One named session per run (`-s=<name>`), `close` at the end.

## Screenshot review

Screenshots are for you, videos for the reviewer: nobody reads a video back, so layout defects
are caught here. Every changed screen, after the checks pass and before the videos. Four shots:
mobile and desktop, light and dark (backoffice: desktop only).

- Sizes: never shrink a shot, halving it halves every padding you judge. Mobile 390x844 at 2x
  device pixels (780x1688), desktop 1440x900 at 1x: both under the 2000 px per-image cap a
  session with over 20 images gets, about 1.7k tokens each.
- Tall screens: one shot per viewport height (`eval "() => scrollTo(0, <y>)"`, then shoot),
  never `--full-page`, which downscales a long page until its text is unreadable.
- Before reading, run `layout-check.js` in each of the four. It lists overlapping, clipped,
  truncated and off-screen text and a page that scrolls sideways; every line it returns is a
  check to settle on the shot. `sh .claude/skills/ui-verify/layout-check.check.sh` is its self-test.
- Read each shot for: spacing consistent with its neighbours, alignment, overlapping or cut text,
  anything off-screen or out of its container, contrast in dark, and the ticket's designs. Every
  shot gets a report line, a clean one too. A defect is a FAIL with the png path; it gets fixed
  and shot again.

```bash
mkdir -p /tmp/ui-verify
echo '{"browser":{"contextOptions":{"deviceScaleFactor":2}}}' > /tmp/ui-verify/2x.json
playwright-cli -s=m open <url> --config=/tmp/ui-verify/2x.json && playwright-cli -s=m resize 390 844
playwright-cli -s=m eval "$(cat .claude/skills/ui-verify/layout-check.js)"
playwright-cli -s=m screenshot --hires --filename=/tmp/ui-verify/<screen>-mobile-dark.png
# switch theme, reload, repeat as -light; desktop in its own session:
# no --config, resize 1440 900, no --hires
```

In the PR, after the Videos section, collapsed per screen (upload as in `docs/agents/forge.md`):

```markdown
<details><summary>Screenshots: <screen></summary>

|         | Light                    | Dark                    |
| ------- | ------------------------ | ----------------------- |
| Mobile  | ![mobile light](upload)  | ![mobile dark](upload)  |
| Desktop | ![desktop light](upload) | ![desktop dark](upload) |

</details>
```

## Video evidence

After the screenshot review: one clip per acceptance criterion (`docs/standards/testing.md`),
recorded on the local stack, one at mobile size (`resize 390 844`) and one at desktop
(`resize 1440 900`), each switching theme with the app's toggle partway through. A fix: that pair
failing before, and passing after. Never read a video back.

```bash
playwright-cli -s=v video-start /tmp/ui-verify/ac1-<slug>-mobile.webm
playwright-cli -s=v video-show-actions
playwright-cli -s=v video-chapter "AC1: <criterion in a few words>" --duration=1500
# drive the AC ... toggle the theme ... until its outcome is on screen
playwright-cli -s=v video-stop
```

## Report

One line per check: `PASS|FAIL - <check> - rung <n> - expected <x>, got <y> - <artifact path>`,
plus the failure detail for each FAIL. A pixel claim neither a measurement nor the shot can
settle is `UNSURE - <check> - <what is ambiguous> - <png path>`, never a guess. Return every shot
and clip path.

## Bugs

Reproduce here first, as close to real use as possible, then fix, then rerun the same checks.
A fix without a before and after run is unverified.
