# Issue tracker: Jira (project `{{trackerKey}}`) + Confluence + Slack

Work for this operator is tracked in Jira project `{{trackerKey}}` on `{{jiraSite}}`. Requirements and reasoning live in Confluence space `{{wikiSpace}}`. Decisions that never made it into a ticket live in Slack `{{teamChannel}}`. Code review happens on GitLab `{{gitRemotePath}}` merge requests (`glab`).

Every skill that says "fetch the relevant ticket" reads this file.

## Keys and where they appear

- Ticket key: `{{trackerKey}}-<n>`. `{{trackerKey}}-0` means "no ticket" (chores).
- Branch: `<type>/{{trackerKey}}-<n>/<slug>`. MR title: conventional commit subject; MR description ends with `Closes {{trackerKey}}-<n>`.
- Resolve the key from, in order: the argument the user gave, the MR description, the MR title, the branch name, commit subjects.

## What "read the ticket" means

A ticket is read when ALL of this has been seen - never from the description alone:

1. Description and acceptance criteria (task items render as `- [ ]` / `- [x]`).
2. Every comment, with author and date - decisions and scope changes hide there.
3. Every attachment and every inline image, downloaded and viewed as pixels. Filenames, thumbnails, `blob:` links and metadata prove nothing.
4. Parent epic and linked issues named by the AC.
5. Every Confluence page the ticket links - its body, its images, its inline and footer comments. The AC are the spec; the page behind them is the reasoning.
6. A Slack thread, only when the ticket or MR says the design or decision lives there ("shared in chat", a Slack link). Optional otherwise.

How:

- With the `atlassian-read` skill installed: `python3 ~/.claude/skills/atlassian-read/scripts/read.py issue {{trackerKey}}-<n>` then `page <id>` for each linked page. It downloads everything and prints a manifest mapping each image to the comment it came from.
- Without it, REST with an Atlassian API token: Jira `GET /rest/api/3/issue/{{trackerKey}}-<n>?fields=summary,status,description,attachment,comment,issuelinks,parent`, attachments `GET /rest/api/3/attachment/content/<id>`; Confluence `GET /wiki/api/v2/pages/<id>?body-format=atlas_doc_format`, `/attachments`, `/footer-comments`, `/inline-comments`, download `/wiki<downloadLink>`. Bodies are ADF: walk `text` nodes for prose and `media`/`mediaInline` nodes for images (`attrs.alt` is the Jira attachment filename; on Confluence `attrs.id` is the attachment `fileId`).
- The Atlassian MCP is fine for search, text and writes, but it returns no image bytes - it is never sufficient on its own when attachments exist.
- Slack: the `slack-reader` agent when available, else the Slack MCP, scoped to the channel and thread named.

Credentials are personal: `CONFLUENCE_EMAIL` / `CONFLUENCE_TOKEN` (an Atlassian API token) from a local, untracked env file. Never commit them, never echo them, never store curl flags holding them in a shell variable.

## When a skill says "fetch the relevant ticket"

Run the protocol above and distill: goal in one line, AC quoted as bullets, decisions from comments (who, when), design references (which screenshot shows what), out-of-scope lines. Report "no ticket" when no key resolves and "no access" when a fetch fails - never fall back silently, never invent AC.

## Writing

- Never comment on, transition, or edit a Jira issue or Confluence page unless the user asks for that exact write. Reading authorizes nothing.
- MR comments go through `glab` (`review --post`), draft-and-confirm.
- Slack: draft only, never send.
