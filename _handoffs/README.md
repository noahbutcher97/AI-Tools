# `_handoffs/`

Durable cross-context documents — written for the *next* person (human or agent) coming to a problem cold.

Each handoff is a self-contained markdown file that explains what was found, what to do about it, and how to verify. They survive a single conversation, span workspaces, and live alongside the code so they don't drift out of reach.

## When to write one

- **Diagnosed bug, fix proposed, not yet applied.** The 2026-05-06 jira_search handoff is the archetype: a downstream consumer hit a 410, root-caused it in another session, but the upstream fix wasn't shipped. The handoff exists so the fix is one cold-read away.
- **Audit findings that won't get fixed today.** When investigation produces a punch list, write the punch list down. The 2026-05-18 bridge scope-leak audit is this shape.
- **Agent-to-agent handback during a workflow.** When one session walks away mid-flow (CL ready but unsubmitted, partial migration, blocked refactor), the handoff captures *enough* state that the next session doesn't have to re-derive everything.
- **Incident notes worth a year from now.** Outage post-mortems, surprising production behavior, weird-but-real-and-load-bearing workarounds.

## When NOT to write one

- **PR descriptions.** If the fix lands in the same session as the diagnosis, the commit message + PR body carries the context. No handoff needed.
- **Session summaries.** "Here's everything I did today" is not a handoff. It rots in days.
- **Memory.** Personal preferences, recurring workflow rules, "remember I always want X" belong in the auto-memory system under `~/.claude/projects/.../memory/`. Handoffs are *project* artifacts, not *user* artifacts.
- **CLAUDE.md material.** Repo-wide guidance about *how* to work in this codebase (code style, test conventions, deploy procedures) belongs in `CLAUDE.md`, not here.

## File naming

`YYYY-MM-DD-short-dash-name.md`

The date is when the issue was found / triaged, **not** when the file was written. (The 2026-05-06 handoff was authored on 2026-05-16 from a downstream diagnosis; the filename matches the original incident date because that's what the memory reference cited.) Date drift between filename and authorship is fine — document it in the doc itself if relevant.

## Template

```markdown
# Handoff: <one-line summary>

**Date**: YYYY-MM-DD (note authorship date if different from filename)
**Bridge/Scope**: <path to affected file or "cross-bridge audit" etc.>
**Status**: Diagnosed / Fix proposed / Partial fix applied / Audit only / Resolved
**Severity**: Low / Medium / High — and one sentence why

---

## Symptom
What does the broken behavior look like from the outside? Include error messages, repro steps, and which clients/tools reproduce it.

## Root cause
What's actually wrong, with file:line citations. Why does the symptom follow from this cause?

## Fix (proposed / applied)
Concrete code change. If proposed-but-not-applied, paste the diff or replacement code. If applied, link the commit.

## Verification steps
Numbered, reproducible. "After applying X, run Y, expect Z." Includes any required client restart.

## Downstream impact
Who's affected? Are there workarounds in other repos that should be retired once this lands? Cite paths.

## Notes
Anything else: related audits to do while in the area, why the doc was written, links to memory references.
```

Not every section is mandatory. Pure-audit docs may have no "Symptom" / "Root cause" pair but a list of independent findings. Use judgment.

## Tracking

Tracked in git. These are project artifacts, not personal scratchpads. If something is too personal/ephemeral to commit, it belongs in your local memory store, not here.

## Lifecycle

When a handoff's "Fix" has shipped and "Verification steps" have been observed green:

- Either delete the file (preferred — git history retains it), or
- Edit Status to `Resolved YYYY-MM-DD` and leave it as historical context.

Avoid letting Status drift from reality. A `Status: Diagnosed, fix proposed` doc that's three months old and stale is worse than no doc.
