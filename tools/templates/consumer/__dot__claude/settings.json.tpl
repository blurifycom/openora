{
  "enableAllProjectMcpServers": false,
  "enabledMcpjsonServers": ["oss"],
  "permissions": {
    "deny": [
      "Edit(./node_modules/**)",
      "Write(./node_modules/**)",
      "Edit({{ossFromRoot}}/**)",
      "Write({{ossFromRoot}}/**)"
    ]
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
