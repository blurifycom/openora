export const RulesyncHooksPlugin = async ({ $ }) => {
  return {
    'tool.execute.before': async (input) => {
      {
        const __re = new RegExp('Bash|Edit|Write|MultiEdit|NotebookEdit');
        if (__re.test(input.tool)) {
          await $`node "\${CLAUDE_PROJECT_DIR:-.}/.rulesync/hooks/guard-generated.mjs"`;
        }
      }
      {
        const __re = new RegExp('Task|Agent');
        if (__re.test(input.tool)) {
          await $`node "\${CLAUDE_PROJECT_DIR:-.}/.rulesync/hooks/guard-subagent.mjs"`;
        }
      }
    },
    'tool.execute.after': async (input) => {
      {
        const __re = new RegExp('Edit|Write|MultiEdit|NotebookEdit');
        if (__re.test(input.tool)) {
          await $`node "\${CLAUDE_PROJECT_DIR:-.}/.rulesync/hooks/post-edit.mjs"`;
        }
      }
    },
  };
};
