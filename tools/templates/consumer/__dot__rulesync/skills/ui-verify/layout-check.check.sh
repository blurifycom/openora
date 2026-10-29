#!/bin/sh
# Self-check for layout-check.js: the page below plants 5 defects next to 5 look-alikes that are fine.
set -e
dir=$(dirname "$0")
fixture=$(cat <<'HTML'
<!doctype html>
<html>
  <body style="margin: 0; font: 16px sans-serif; width: 390px">
    <p>
      Clean wrapped paragraph that wraps across lines with a <a href="#">link inside</a> and more
      text after it.
    </p>
    <div data-testid="overlap-card" style="position: relative; height: 40px">
      <span>Balance</span><span style="position: absolute; left: 20px; top: 0">USDT 12.50</span>
    </div>
    <div data-testid="clip-box" style="height: 18px; overflow: hidden">
      <p style="margin: 0">Line one<br />Line two cut off</p>
    </div>
    <div
      data-testid="ellipsis"
      style="width: 80px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis"
    >
      A very long game title
    </div>
    <span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)"
      >Screen reader only</span
    >
    <div style="overflow: hidden; width: 200px; white-space: nowrap">
      <div style="display: inline-block; width: 200px">Slide one</div>
      <div style="display: inline-block; width: 200px">Slide two parked</div>
    </div>
    <div data-testid="wide" style="white-space: nowrap">
      This label is far too wide for a mobile viewport and runs out
    </div>
    <div style="overflow-x: auto; white-space: nowrap; width: 200px">
      Scrollable chips row that is wider than its box on purpose
    </div>
    <p style="position: relative">Under the modal text</p>
    <div style="position: fixed; top: 0; left: 0; width: 390px; height: 60px; background: #fff">
      <p style="margin: 4px">Modal title over page text</p>
    </div>
  </body>
</html>
HTML
)
url="data:text/html;base64,$(printf '%s' "$fixture" | base64 | tr -d '\n')"
playwright-cli -s=layout-check open "$url" >/dev/null 2>&1
playwright-cli -s=layout-check resize 390 844 >/dev/null
out=$(playwright-cli -s=layout-check eval "$(cat "$dir/layout-check.js")")
playwright-cli -s=layout-check close >/dev/null
for expected in PAGE-SCROLLS-X 'CLIPPED.*clip-box' 'TRUNCATED.*ellipsis' 'OFFSCREEN.*wide' 'OVERLAP.*overlap-card.*with.*overlap-card'; do
  echo "$out" | grep -q "$expected" || { echo "FAIL: missing $expected"; echo "$out"; exit 1; }
done
# Findings never carry page text: a real screen can show player data.
! echo "$out" | grep -qE 'Balance|USDT|Line two|game title|too wide' || { echo "FAIL: page text in findings"; echo "$out"; exit 1; }
count=$(echo "$out" | grep -cE '^  "(PAGE|CLIPPED|TRUNCATED|OFFSCREEN|OVERLAP)')
[ "$count" -eq 5 ] || { echo "FAIL: $count findings, expected 5"; echo "$out"; exit 1; }
echo PASS
