# Comments

Read this before writing a comment or JSDoc.

- Comment WHY, never WHAT: hidden constraint, invariant, bug workaround (link it), trade-off. If a
  block needs a comment to be understood, rename/extract instead.
- No section-divider comments (`// ---`, `// ===`).
- Every JSDoc is multi-line, always - `/**`, the text, and `*/` each on their own line. A
  single-line `/** ... */` is never allowed, even for one sentence. Add one only on an independent
  function/class (not a React component or hook) that is >~15 lines or has non-obvious params. One
  sentence; document the surprising contract, not the name.
- Never JSDoc a React component or hook - a genuinely surprising note goes on the specific
  prop/param type, or an inline comment at the call site.
- Deferred work: `// TODO:` with the concrete follow-up, never a bare TODO.
- Placeholder/sample data and stubs: greppable `// mock:` comment so throwaway code stays
  findable.
