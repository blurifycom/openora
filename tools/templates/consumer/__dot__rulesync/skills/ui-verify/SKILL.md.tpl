---
name: ui-verify
targets: ['*']
description: >
  Verify a UI change in a real browser with the global `playwright-cli`: cheap checks first,
  then four screenshots per changed screen read for spacing, overlap, cut text and contrast,
  then one clip per acceptance criterion for the PR. Use after any change to a page, component, style or
  player/operator flow, on "check it looks right", "verify the UI", "does it render", "take a
  screenshot", "record a video", and to reproduce a UI bug before fixing it.
claudecode:
  context: fork
  model: sonnet
  effort: medium
---

# ui-verify ({{name}})

Global `playwright-cli` (`npm i -g @playwright/cli` if missing), never a browser MCP: it costs a
fraction of the tokens. Do not spawn subagents. Return text only. A subagent (`tester`, `builder`) does not
invoke this skill, which forks one of its own: it reads this file and follows it itself.

## Stack

- Player app :3000, backoffice :3002, API :3001, unless the repo's rules name other ports (a
  worktree slot, say). Ports held by another checkout: never kill it, ask.
- Accounts: the seed's (`admin@oss.dev` / `password1234` after `pnpm bootstrap`). Save a login once
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

Keep the four as your own layout check: they are not uploaded, unless the change is look-only,
where the before and after shots go side by side in the description.

## Video evidence

One clip per acceptance criterion, each the whole flow of that AC in one take, from the screen the
user starts on to the outcome the AC names, never a few seconds of the end state. Last, once, on the
final commit after the tests are green and review is clean (`ship` step 4b): a clip taken earlier is
thrown away by the next fix round. Record on the local stack in the AC's main viewport (mobile for a
player screen, desktop for an operator one), no theme switch: themes and sizes come from the four
shots above. A fix also gets a Before clip of the same flow, recorded on the base branch. Never read
a video back.

ACs a spec drives come first: every spec that drives one, new or existing, in one run with video
on (the repo's record switch, or `test.use({ video: 'on' })`); each lands in
`test-results/<test>/video.webm`; copy it to `/tmp/ui-verify/<ac>-<slug>.webm`, since the next run
wipes `test-results/`. Only an AC no spec drives gets `playwright-cli`. Use test accounts only,
never real user data. A login is never on camera: `state-load` a saved login, or type any secret,
before `video-start`. `video-show-actions` prints every typed value on screen, so nothing secret is
typed after it:

```bash
playwright-cli -s=v resize 390 844        # 1440 900 for an operator screen
playwright-cli -s=v state-load <saved-login>.json
playwright-cli -s=v video-start /tmp/ui-verify/ac1-<slug>.webm
playwright-cli -s=v video-show-actions
# drive the AC ... until its outcome is on screen
playwright-cli -s=v video-stop
```

Upload each clip as `docs/agents/forge.md` says and embed it in its cell of the Evidence table
(`Flow | Before | Now | AC`, one row per AC). An AC with no visible flow still gets its row, with
sample request/response output in the Now cell. A still with real user data is blurred before
upload; a clip cannot be blurred. After a fix to an open PR, record again only the ACs it touched
and replace those cells.

## Report

One line per check: `PASS|FAIL - <check> - rung <n> - expected <x>, got <y> - <artifact path>`,
plus the failure detail for each FAIL. A pixel claim neither a measurement nor the shot can
settle is `UNSURE - <check> - <what is ambiguous> - <png path>`, never a guess. Return every shot path, and one clip
path per AC and per Before cell.

## Bugs

Reproduce here first, as close to real use as possible, then fix, then rerun the same checks.
A fix without a before and after run is unverified.
