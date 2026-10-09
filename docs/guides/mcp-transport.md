# Connect an MCP client to the platform

A running platform can serve its agent read tools to an admin's own MCP client, such as Claude
Code, over MCP Streamable HTTP. The admin authenticates with a token they generate in the
Backoffice, and every call runs under that admin's permissions. This is not the `oss-dev` server
from [MCP Server Setup](./mcp-setup.md), which inspects this repository's code for coding
agents. The agent hub does not use this endpoint either: it calls the MCP kernel in-process.

The design and its trade-offs are recorded in
[ADR-0043](../adr/0043-mcp-http-transport-with-admin-bound-tokens.md).

## Enable the endpoint (operator)

The endpoint is off by default. Enabling it takes two steps.

1. Install the MCP SDK next to `@openora/core`. Core declares it as an optional peer dependency
   and loads it only while the endpoint is on, so a deployment without MCP never installs it.

   ```bash
   pnpm add @modelcontextprotocol/sdk@1.29.0
   ```

2. Turn the endpoint on in the `agents.mcp` block of the platform config, with the backoffice
   host it answers on. The [agents config schema](../../packages/core/src/contracts/schemas/agents.ts)
   lists every setting with its default and bounds.

   ```yaml
   agents:
     mcp:
       enabled: true
       allowedHosts:
         - backoffice-api.example.com
   ```

- **Bind it to the backoffice host.** The config refuses to enable the endpoint without at least
  one allowed host. On any other host the path is a plain 404, so it never appears on the player
  domain. The host is read from the request, so let every proxy or load balancer in front of the
  app set the `Host` header itself and reject absolute-form request targets, or serve the endpoint
  from a deployment only the backoffice proxy reaches.
- **Browser origins.** A request that carries an `Origin` header is refused unless that origin is
  listed. Desktop clients send none, so the list normally stays empty.
- **Token issuance.** Each admin can hold a limited number of active tokens and issue a limited
  number per hour. A token gets the default lifetime unless the admin picks a shorter or longer
  one, up to the configured cap.
- **Rate limits.** Every client address has a per-minute limit before any token is looked up, and
  every token has a per-minute and a per-day limit. They run on the shared rate limiter, which
  needs Redis; while it is unreachable the endpoint answers 503 instead of serving unthrottled.
- **Personal data.** By default the kernel removes the output fields a tool marks as personal
  (names, contact details, date of birth and similar) before they reach the client, and with it
  whatever model the client uses. Switching that off sends them through.
- **Path.** The endpoint is served at `/mcp` unless configured otherwise.

## Grant access

Two permissions in the IAM catalog control the endpoint:

- **MCP access** lets an admin generate, list and revoke their own tokens, and is checked again on
  every request. Taking it away - removing it from a role, deleting the role, unassigning the role, or giving an admin a first role that replaces the static admin role without it - revokes the affected admins' tokens for good.
- **MCP token oversight** lets an admin see every admin's tokens and revoke any of them,
  including revoking all of them at once.

The static admin role and the seeded admin and super-admin roles hold both. A role created before
this release gets them through the role matrix. MCP access is all-or-nothing, so only the
read-write level grants it.

A token never reaches more than its admin's own grants: the tools an admin cannot use are not
listed, and the kernel checks each tool's permission again on every call.

## Generate a token (admin)

The platform ships the token routes; the operator's Backoffice builds the screen on top of them.
Only an active admin can generate a token. Copy it at once: it is shown only once, and the
platform stores only its hash.

## Connect Claude Code

```bash
claude mcp add --transport http --scope local openora \
  https://backoffice-api.example.com/mcp \
  --header "Authorization: Bearer <token>"
```

Run `/mcp` in Claude Code (or restart it) to connect. The tools appear with underscores in their
names, for example the player summary tool as `player_summary`. When a token is revoked or
expires, Claude Code reports that the server rejected the header in its configuration; generate a
new token, update the header and reconnect.

- Keep the server name short. Claude Code names a tool `mcp__<server>__<tool>`, and the model API
  rejects names longer than 64 characters.
- Claude Code keeps the header, token included, in its local configuration in plain text. Prefer
  a short lifetime, and never put the token in a committed `.mcp.json`; an uncommitted one can
  read it from an environment variable.

## Claude Desktop and claude.ai

Their remote connectors accept only OAuth, which the platform does not offer. A local bridge that
speaks stdio to Desktop and adds the bearer header towards the platform works around that. This
path has not been verified by the platform maintainers.

## What the client gets

- Only read tools, never a proposal or an action.
- Output limited to each tool's allow-listed fields, without the personal ones unless the
  operator switched them on.
- An audit record for every tool call, including a call naming a tool the endpoint does not
  expose, with the token, the admin, the tool and its version, the client address and agent, and
  hashes of the input and of exactly the output returned, never the data itself.

## Revoke a token

- The owner revokes their own tokens; an admin with token oversight revokes anyone's, or all.
- The platform revokes all of a user's tokens when their account is deactivated, when they stop
  being an admin, when an IAM change takes away their MCP access, when all of their sessions are
  revoked (a forced logout, a two-factor reset, an email change), and when their password is
  reset or changed. A revoked token stays revoked after the account or the access is restored.
- Each revocation commits together with the change that caused it, except after a password
  change or reset, which is committed first: every token issued before it is refused from that
  moment whether or not its revocation succeeds. If that revocation fails, the tokens are still
  listed as active, and count towards the admin's token limit, until someone revokes them or they
  expire.
- Turning the endpoint off in the platform config removes it at the next start. Revoking all
  tokens, or removing MCP access from a role, takes effect immediately.

## Troubleshooting

| Status | Meaning                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 400    | The body is not valid JSON, or it is a JSON-RPC batch, which the endpoint does not accept.                                       |
| 401    | The token is missing, unknown, expired or revoked, or predates the admin's latest password change or reset. Generate a new one.  |
| 403    | The admin lacks MCP access, the account is deactivated, a required two-factor enrolment is missing, or the origin is not listed. |
| 404    | The endpoint is off, the path is wrong, or the host is not in the allowed-host list.                                             |
| 405    | The client asked for a server-sent event stream. Clients fall back to plain requests on their own.                               |
| 406    | The client does not accept both JSON and event-stream responses, which MCP Streamable HTTP requires.                             |
| 413    | The request body is larger than 1 MiB.                                                                                           |
| 415    | The request is not sent as JSON.                                                                                                 |
| 429    | The token or the client address hit its limit. Retry after the time the response names.                                          |
| 503    | The rate limiter is unreachable. Retry shortly.                                                                                  |
