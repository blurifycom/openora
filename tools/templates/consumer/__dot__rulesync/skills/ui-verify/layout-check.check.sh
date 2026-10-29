#!/bin/sh
# Self-check for layout-check.js: the fixture plants 5 defects next to 5 look-alikes that are fine.
set -e
dir=$(dirname "$0")
url="data:text/html;base64,$(base64 -i "$dir/layout-check.fixture.html" | tr -d '\n')"
playwright-cli -s=layout-check open "$url" >/dev/null 2>&1
playwright-cli -s=layout-check resize 390 844 >/dev/null
out=$(playwright-cli -s=layout-check eval "$(cat "$dir/layout-check.js")")
playwright-cli -s=layout-check close >/dev/null
for expected in PAGE-SCROLLS-X 'CLIPPED.*Line two' 'TRUNCATED.*game title' 'OFFSCREEN.*too wide' 'OVERLAP.*Balance.*USDT'; do
  echo "$out" | grep -q "$expected" || { echo "FAIL: missing $expected"; echo "$out"; exit 1; }
done
count=$(echo "$out" | grep -cE '^  "(PAGE|CLIPPED|TRUNCATED|OFFSCREEN|OVERLAP)')
[ "$count" -eq 5 ] || { echo "FAIL: $count findings, expected 5"; echo "$out"; exit 1; }
echo PASS
