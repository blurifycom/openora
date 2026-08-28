# Issue tracker

Work for this operator is tracked in `<your-tracker>` (Jira project `<KEY>`, Linear team, GitHub issues, ...). Requirements and reasoning live in `<your-wiki>` (a Confluence space, Notion, ...). Decisions that never made it into a ticket live in `<your-team-channel>`. Code review happens on the repo's merge requests.

Fill in the placeholders above once; every skill that says "fetch the relevant ticket" reads this file.

## Keys and where they appear

- Ticket key: `<KEY>-<n>`. `<KEY>-0` means "no ticket" (chores).
- Branch: `<type>/<KEY>-<n>/<slug>`. MR description ends with `Closes <KEY>-<n>`.
- Resolve the key from, in order: the argument the user gave, the MR description, the MR title, the branch name, commit subjects.

## What "read the ticket" means

A ticket is read when ALL of this has been seen - never from the description alone:

1. Description and acceptance criteria.
2. Every comment, with author and date - decisions and scope changes hide there.
3. Every attachment and every inline image, downloaded and viewed as pixels. Filenames, thumbnails and metadata prove nothing.
4. Parent epic and linked issues named by the AC.
5. Every wiki page the ticket links - its body, its images, its comments. The AC are the spec; the page behind them is the reasoning.
6. A chat thread, only when the ticket or MR says the design or decision lives there. Optional otherwise.

How: use a reader that returns the image bytes. For Jira + Confluence that is the `atlassian-read` skill (`read.py issue <KEY>-<n>`, then `page <id>` per linked page) or the REST API with an API token: Jira `GET /rest/api/3/issue/<KEY>-<n>?fields=summary,status,description,attachment,comment,issuelinks,parent` and `GET /rest/api/3/attachment/content/<id>`; Confluence `GET /wiki/api/v2/pages/<id>?body-format=atlas_doc_format`, `/attachments`, `/footer-comments`, `/inline-comments`. Bodies are ADF: `text` nodes carry prose, `media` nodes carry images (`attrs.alt` is the Jira attachment filename; on Confluence `attrs.id` is the attachment `fileId`). The Atlassian MCP is fine for search, text and writes, but returns no image bytes - it is never sufficient on its own when attachments exist.

Credentials are personal and come from a local, untracked env file. Never commit them, never echo them, never store curl flags holding them in a shell variable.

## When a skill says "fetch the relevant ticket"

Run the protocol above and distill: goal in one line, AC quoted as bullets, decisions from comments (who, when), design references (which screenshot shows what), out-of-scope lines. Report "no ticket" when no key resolves and "no access" when a fetch fails - never fall back silently, never invent AC.

## Writing

- Never comment on, transition, or edit a ticket or wiki page unless the user asks for that exact write. Reading authorizes nothing.
- MR comments go through the repo's CLI (`review --post`), draft-and-confirm.
- Chat: draft only, never send.
