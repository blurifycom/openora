---
targets:
  - '*'
description: First-run onboarding for this consumer igaming repo. Interview the user for requirements, then delegate the build to the scoped agents. Invokes the `start` MCP tool.
---

Call the `start` MCP tool (server `oss`) with no arguments, then follow the script it returns exactly. If the user already described what they want to build, pass it as the `ask` argument.

The returned script will have you: confirm the MCP server is connected, run a thorough requirements interview, call `enhance-intent`, then delegate the implementation to the `igaming-expert`, `igaming-builder`, and `igaming-qa` agents (via the Task tool). You gather requirements and orchestrate; you do not write feature code yourself, and you never modify `@blurifycom/*` core.

If the `start` tool is not available, the `oss` MCP server is not connected - tell the user to run `pnpm setup:mcp` and restart the editor.
