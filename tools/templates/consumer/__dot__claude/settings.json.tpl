{
  "enableAllProjectMcpServers": false,
  "enabledMcpjsonServers": ["oss"],
  "env": {
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1"
  },
  "permissions": {
    "deny": ["Edit(./node_modules/**)"],
    "additionalDirectories": ["{{ossFromRoot}}"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.rulesync/hooks/guard-core.mjs\""
          }
        ]
      },
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.rulesync/hooks/guard-generated.mjs\""
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.rulesync/hooks/guard-mr.mjs\""
          }
        ]
      },
      {
        "matcher": "Task|Agent",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.rulesync/hooks/guard-subagent.mjs\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.rulesync/hooks/post-edit.mjs\""
          }
        ]
      }
    ]
  }
}
