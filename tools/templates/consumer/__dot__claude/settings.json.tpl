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
  }
}
