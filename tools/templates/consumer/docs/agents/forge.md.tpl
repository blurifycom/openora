# Code forge: GitHub

Code review for `{{gitRemotePath}}` happens on GitHub pull requests, driven by the [`gh`](https://cli.github.com) CLI. Every skill that opens, reads, or comments on a pull request reads this file instead of hardcoding commands, so a repo on a different forge rewrites this one file and the skills keep working.

Swapping forge: keep the headings below and replace the commands. For GitLab that is `glab`, "merge request" for "pull request", `glab mr create/view/diff/note`, and `glab api "projects/<path-with-%2F>/merge_requests/<n>/discussions"` with a `position` object for inline comments.

## Coordinates

- Repo: `{{gitRemotePath}}`. CLI: `gh` (authenticate once with `gh auth login`).
- Noun: pull request, "PR" for short. The default target branch is `{{mrTarget}}`.

## Where a change lands

- Topic branch (`feat/*`, `fix/*`, `{{trackerKey}}-*`) -> `{{mrTarget}}`.
- A repo that promotes through environment branches adds them here (for example `{{mrTarget}}` -> `stage` -> `prod`) and never opens a PR straight from a topic branch to the last one.
- If the current branch is not listed, target `{{mrTarget}}`.

## Open a pull request

```
gh pr create --base <target> --head <current> --title "<type>: <summary>" --body "<body>"
```

Reuse an open PR for the same head -> base instead of opening a duplicate: `gh pr list --head <current> --base <target>`. Never delete a long-lived branch on merge.

## Read a pull request

- Intent and discussion: `gh pr view <n> --comments`
- Patch: `gh pr diff <n>`
- Unresolved threads: `gh api "repos/{{gitRemotePath}}/pulls/<n>/comments"`
- CI: `gh pr checks <n>`

## Inline review comments

Anchor each comment to a line of the diff on the head commit:

```
gh api "repos/{{gitRemotePath}}/pulls/<n>/comments" \
  -f body="<comment>" -f commit_id="<head-sha>" -f path="<file>" -F line=<new-line> -f side=RIGHT
```

Take `<head-sha>` from `gh pr view <n> --json headRefOid`. Anchor on the NEW-file line of an added line. Verify the response carries a non-null `line`; if it came back as a plain issue comment, delete it and retry rather than leaving an unanchored note. Post the verdict itself as one summary comment: `gh pr comment <n> --body "<one sentence>"`.

## Rules

- Never push without an explicit per-action confirmation from the user.
- Never merge a pull request unless the user asks for that exact action.
- Never resolve someone else's review thread.
