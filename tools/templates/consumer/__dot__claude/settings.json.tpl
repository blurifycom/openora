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
        "matcher": "Bash|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node .rulesync/hooks/guard-core.mjs"
          }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node .rulesync/hooks/guard-generated.mjs"
          }
        ]
      },
      {
        "matcher": "Task",
        "hooks": [
          {
            "type": "command",
            "command": "node .rulesync/hooks/guard-subagent.mjs"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node .rulesync/hooks/post-edit.mjs"
          }
        ]
      }
    ]
  }
}
