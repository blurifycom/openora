// Layout defects a screenshot read can miss: overlapping text, text cut by an
// `overflow: hidden|clip` box, text sticking out of the viewport sideways.
// Run: playwright-cli -s=v eval "$(cat .claude/skills/ui-verify/layout-check.js)"
// Returns one line per finding; [] is clean. Findings are leads for the screenshot
// review, not verdicts: a carousel peek or a deliberate ellipsis can show up here.
// A finding names a selector and a position, never the text: a screen can show player data.
// playwright-cli eval takes a bare function expression.
// oxlint-disable-next-line no-unused-expressions
() => {
  const EDGE_PX = 1;
  const OVERLAP_PX = 2;
  const MAX_TEXTS = 800;
  const MAX_FINDINGS = 40;

  const describe = (el) => {
    const tagged = el.closest('[data-testid]');
    const testId = tagged ? `[data-testid="${tagged.getAttribute('data-testid')}"] ` : '';
    const classes = [...el.classList]
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join('');
    return `${testId}${el.tagName.toLowerCase()}${classes}`;
  };
  const clips = (style) => /hidden|clip/.test(style.overflowX + style.overflowY);
  const scrolls = (style) => /auto|scroll/.test(style.overflowX + style.overflowY);
  const overflowBy = (inner, outer) =>
    [
      ['top', outer.top - inner.top],
      ['right', inner.right - outer.right],
      ['bottom', inner.bottom - outer.bottom],
      ['left', outer.left - inner.left],
    ].filter(([, px]) => px > EDGE_PX);
  const intersects = (a, b) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const isOpaque = (el) => {
    const style = getComputedStyle(el);
    const alpha = style.backgroundColor.match(/[\d.]+/g)?.[3] ?? '1';
    return (
      style.backgroundImage !== 'none' ||
      style.backdropFilter !== 'none' ||
      (style.backgroundColor !== 'transparent' && Number(alpha) >= 0.5)
    );
  };
  // A modal or sheet over the page puts an opaque layer between the two texts in the paint stack.
  const isLayerBetween = (a, b, x, y) => {
    const stack = document.elementsFromPoint(x, y);
    const [upper, lower] = [stack.indexOf(a), stack.indexOf(b)].sort((p, q) => p - q);
    if (upper < 0) {return false;}
    const below = stack[lower];
    return stack.slice(upper + 1, lower).some((el) => !el.contains(below) && isOpaque(el));
  };

  const findings = [];
  const at = (r) =>
    `at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  const report = (kind, el, box, detail) =>
    findings.push(`${kind} - ${describe(el)} ${at(box)} - ${detail}`);

  const texts = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && texts.length < MAX_TEXTS; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!node.textContent.trim() || !el || el.closest('script,style,noscript,template')) {continue;}
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {continue;}
    range.selectNodeContents(node);
    const lines = [...range.getClientRects()].filter((r) => r.width >= 1 && r.height >= 1);
    if (!lines.length) {continue;}
    const box = range.getBoundingClientRect();

    let hiddenByDesign = false;
    let clippedBy = null;
    let insideScroller = false;
    for (
      let a = el, child = null;
      a && a !== document.body && !insideScroller;
      child = a, a = a.parentElement
    ) {
      const style = getComputedStyle(a);
      const outer = a.getBoundingClientRect();
      if (!clips(style)) {
        insideScroller = scrolls(style);
        continue;
      }
      // sr-only boxes and slides parked fully outside their track are meant to be unseen;
      // a block only partly inside its clipper has lines cut off.
      const shown = child ? child.getBoundingClientRect() : box;
      if (outer.width <= 1 || outer.height <= 1 || !intersects(shown, outer)) {
        hiddenByDesign = true;
        break;
      }
      // Glyphs taller than a tight line-height poke past the box without any layout overflow.
      const overflows =
        a.scrollWidth > a.clientWidth + EDGE_PX || a.scrollHeight > a.clientHeight + EDGE_PX;
      if (!clippedBy && overflows && overflowBy(box, outer).length) {clippedBy = { a, style, outer };}
    }
    if (hiddenByDesign) {continue;}

    if (clippedBy) {
      const edges = overflowBy(box, clippedBy.outer).map(
        ([edge, px]) => `${edge} ${Math.round(px)}px`,
      );
      const isEllipsis =
        clippedBy.style.textOverflow === 'ellipsis' || clippedBy.style.webkitLineClamp !== 'none';
      const kind = isEllipsis ? 'TRUNCATED' : 'CLIPPED';
      report(kind, el, box, `cut by ${describe(clippedBy.a)} at ${edges.join(', ')}`);
    }
    if (
      !clippedBy &&
      !insideScroller &&
      (box.right > innerWidth + EDGE_PX || box.left < -EDGE_PX)
    ) {
      report(
        'OFFSCREEN',
        el,
        box,
        `x ${Math.round(box.left)}..${Math.round(box.right)}, viewport ${innerWidth}`,
      );
    }
    // Only the part left visible can overlap anything.
    const shownLines = clippedBy
      ? lines
          .map((r) => ({
            left: Math.max(r.left, clippedBy.outer.left),
            top: Math.max(r.top, clippedBy.outer.top),
            right: Math.min(r.right, clippedBy.outer.right),
            bottom: Math.min(r.bottom, clippedBy.outer.bottom),
          }))
          .filter((r) => r.right > r.left && r.bottom > r.top)
      : lines;
    texts.push({ el, box, lines: shownLines });
  }

  const overlapOf = (ra, rb) => {
    const left = Math.max(ra.left, rb.left);
    const top = Math.max(ra.top, rb.top);
    const width = Math.min(ra.right, rb.right) - left;
    const height = Math.min(ra.bottom, rb.bottom) - top;
    return width > OVERLAP_PX && height > OVERLAP_PX
      ? { x: left + width / 2, y: top + height / 2 }
      : null;
  };
  // ponytail: O(n^2) over line boxes, fine under MAX_TEXTS; bucket by row if pages outgrow it.
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      const point = a.lines.flatMap((ra) => b.lines.map((rb) => overlapOf(ra, rb))).find(Boolean);
      if (point && !isLayerBetween(a.el, b.el, point.x, point.y)) {
        report('OVERLAP', a.el, a.box, `with ${describe(b.el)} ${at(b.box)}`);
      }
    }
  }

  const page = document.documentElement;
  if (page.scrollWidth > page.clientWidth + EDGE_PX) {
    findings.unshift(
      `PAGE-SCROLLS-X - html - scrollWidth ${page.scrollWidth} > ${page.clientWidth}`,
    );
  }
  const extra = findings.length - MAX_FINDINGS;
  return extra > 0 ? [...findings.slice(0, MAX_FINDINGS), `+${extra} more`] : findings;
}
