const MACHINE_DIRECTIVES = [
  /^\s*(oxlint|eslint)-(disable|enable)(-next-line|-line)?\s+[\w@/-]+(\s*,\s*[\w@/-]+)*\s*$/,
  /^\s*@ts-expect-error\s*$/,
  /^\s*@vitest-environment\s+[\w-]+\s*$/,
  /^\s*\/\s*<reference\s/,
  /^\s*[@#]__(PURE|NO_SIDE_EFFECTS)__\s*$/,
];

const isMachineDirective = (comment) =>
  comment.type === 'Shebang' || MACHINE_DIRECTIVES.some((pattern) => pattern.test(comment.value));

const noComments = {
  meta: { type: 'suggestion' },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (isMachineDirective(comment)) {
            continue;
          }
          context.report({
            loc: comment.loc,
            message:
              'No comments. Move the meaning into names, types or a test, and the reason into the commit, the PR or an ADR. See docs/standards/comments.md.',
          });
        }
      },
    };
  },
};

export default {
  meta: { name: 'openora-comments' },
  rules: { 'no-comments': noComments },
};
