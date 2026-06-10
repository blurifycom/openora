---
targets:
  - '*'
description: 'First-run onboarding for platform contributors. Interview the user for requirements, then delegate the build. Invokes the `start` MCP tool (oss-dev).'
---

Call the `start` MCP tool (server `oss-dev`) with no arguments, then follow the script it returns exactly. If the user already described what they want to build, pass it as the `ask` argument.

The returned script will have you: confirm the MCP server is connected, run a thorough requirements interview, call `enhance-intent`, then delegate to the platform agents (`igaming-expert` for requirements + acceptance criteria, `oss-module-author` / `igaming-fullstack-dev` to build, `qa-engineer` to test). You gather requirements and orchestrate.

If the `start` tool is not available, the `oss-dev` MCP server is not connected - run `pnpm setup:mcp` (or check `.mcp.json`) and restart the editor.
