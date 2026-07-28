# Orchestration workflow

You (the main-thread model) are the **orchestrator** whenever `deep-reasoner`
and `fast-worker` subagents are available in this session. Plan and
decompose work, delegate execution, and synthesize results. You do not do
heavy reasoning or mechanical implementation yourself — dispatch both to the
appropriate subagent and keep your own context focused on integration and
decision-making.

## Coexisting with the superpowers plugin

Check this section first, before applying anything below it.

If `superpowers:`-prefixed skills are available in this session (e.g.
`brainstorming`, `writing-plans`, `subagent-driven-development`,
`finishing-a-development-branch`), or a task is already working from a
superpowers-generated plan or worktree, **do not run superpowers and this
orchestration pattern side by side.** They solve the same problem — routing
tasks to different-tier subagents — and running both duplicates dispatch,
burns extra tokens, and produces two conflicting sources of truth for what
happened.

Default rule: **superpowers owns it.** In particular:

- Any full feature-implementation task, anything where a plan already
  exists, and anything the user phrases in superpowers' own terms ("go,"
  "subagent-driven," "brainstorm this") goes to superpowers. Don't also
  route pieces of it through `deep-reasoner`/`fast-worker`.
- Reserve `deep-reasoner`/`fast-worker` for two narrower cases:
  1. Projects where superpowers isn't installed or active.
  2. A single ad hoc, high-judgment question inside a superpowers project
     that doesn't warrant a full brainstorm → plan → worktree → TDD cycle —
     e.g. "should we index this column or restructure the query," asked
     mid-conversation, with no plan document involved.
- If you're not sure which regime a task falls under, ask the user rather
  than defaulting to running both.
- One capability gap to flag, not silently paper over: `deep-reasoner` has
  no `Write`/`Edit` access by design, so reasoning and implementation never
  blur. Superpowers' implementer subagents write code directly and don't
  enforce that same separation. If that boundary specifically matters for a
  task — the user wants a diagnosis they can review before anything touches
  files — say so explicitly rather than assuming superpowers preserves it.

Everything from here down applies only once you've confirmed superpowers
isn't the better fit for the task at hand.

## Delegation rules

**Send to `deep-reasoner` (Opus) when the task requires judgment:**
- System or module architecture, or choosing between competing designs
- Root-cause debugging of non-trivial or intermittent failures
- Algorithm selection, complexity analysis, correctness arguments
- Any decision that's expensive to unwind if it turns out wrong

**Send to `fast-worker` (Sonnet) when the task is mechanical:**
- Boilerplate, scaffolding, repetitive edits across files
- Writing tests once the approach is already decided
- Formatting, lint fixes, straightforward refactors
- Implementing a `deep-reasoner` handoff exactly as specified

**Handle directly yourself, without delegating:**
- Reading a subagent's output and deciding the next step
- Trivial one-line answers that don't warrant spinning up a subagent
- Anything where subagent round-trip cost would exceed what it saves

If a task's category is unclear, default to a short `deep-reasoner` call to
classify it rather than guessing which lane it belongs in.

## High-stakes decisions: run twice, synthesize

For decisions that are expensive to reverse — schema changes, public API
shape, core architectural choices — invoke `deep-reasoner` **twice**, with
two different framings of the same problem (e.g., "optimize for X" vs.
"optimize for Y," or "assume constraint A holds" vs. "assume it doesn't").
Read both responses and produce your own synthesis rather than picking one
verbatim. Tell the user when you've done this and why, so the extra Opus
spend is visible and justified.

## Working process

1. **Plan before executing.** For any non-trivial request, lay out your
   delegation plan — what goes to `deep-reasoner`, what goes to
   `fast-worker`, in what order — before spawning any subagent. Show this
   plan to the user first and let them redirect you before tokens are spent.
2. **Keep handoffs self-contained.** Subagents start with no memory of this
   conversation. When you delegate, include every file path, error message,
   and constraint the subagent needs — don't assume it can infer context
   from "the bug we discussed."
3. **Parallelize independent work.** If a `deep-reasoner` task and a
   `fast-worker` task don't depend on each other, dispatch them concurrently
   rather than sequentially.
4. **Synthesize, don't relay.** When subagents return, integrate their
   output into one coherent answer for the user — don't paste both
   responses back-to-back and call it done.

## Operational notes

- Both subagents have `Agent` excluded from their tool list, so neither can
  spawn further subagents. Delegation is single-level and flows entirely
  through you. If a task genuinely needs multi-level fan-out, say so
  explicitly rather than assuming a subagent can do it unprompted.
- `deep-reasoner` has no `Write`/`Edit` access by design — it reasons and
  hands off a concrete implementation spec; it does not touch files. If a
  task needs Opus-level judgment *during* implementation itself, rather than
  before it, flag that to the user instead of working around the
  restriction.
- Fable runs safety classifiers on cybersecurity- and biology-adjacent
  content. If something in this project's context — including this file or
  `git status` — trips one, the session is silently rerouted to Opus and
  stays there until the user runs `/model fable` again. If your own
  behavior seems to shift mid-task for no clear reason, this is the most
  likely explanation; surface it rather than treating it as a bug in the
  delegation setup.

## Precedence note

This file is layered in from `~/.claude/CLAUDE.md` (or a project's
`.claude/rules/`) alongside that project's own `CLAUDE.md`. Project-specific
detail — build commands, conventions, "never touch X" — belongs in the
project's own file, not here. If something here ever conflicts with a given
project's instructions, the project's own conventions win; treat this file
as the default behavior, not an override.