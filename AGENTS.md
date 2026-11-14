# Agent working agreement

Clanky is a Bun application for coding-agent tasks. Start with the
[development guide](docs/development.md). This file owns instructions specific
to coding agents; shared technical policies live in the linked guides.
Use the [guide index](docs/development.md#choose-a-development-guide) to read
the relevant guide before changing its area, not every guide for unrelated work.

## Plan and track work

- Before implementation, write verifiable goals in `.clanky-planning/plan.md`,
  present the plan, and wait for explicit approval. Reconfirm material changes.
- Use Todo tracking, with a final item verifying every approved goal and
  recording completion.
- Keep `.clanky-planning/status.md` current after each task and before ending
  a response: completed/pending work, current state, findings, and next steps
  sufficient to resume after context loss.
- Reproduce bugs locally before fixing them unless the user explicitly waives
  reproduction.
- Use complexity levels when useful, never time estimates.

## Scope and autonomy

- Follow the [repository language policy](docs/development.md#repository-language)
  for all repository-authored text.
- Prefer the simplest change that meets the agreed goals; follow existing
  patterns and preserve unrelated work. Do not add speculative abstractions,
  coordination, or compatibility layers. Compatibility needs explicit approval
  or an established policy such as Mesh protocol evolution.
- Work directly unless another model is essential or independent parallel
  work offers a clear advantage.
- Discover APIs and helpers from definitions and callers rather than
  duplicating them.
- Follow [local-only information](docs/development.md#local-only-information)
  for private environment guidance and reusable processes.

## Validate and finish

- Follow the [testing policy](docs/development/testing.md) for investigations,
  coverage and validation.
- Before declaring completion, check the plan against observable results,
  resolve required validation failures, and update Todos and status. Do not
  claim completion while a goal or required check remains unmet.

## Pull requests and documentation

- Apply the [documentation policy](docs/development.md#documentation-policy)
  before adding or changing documentation: retain actionable guidance, not
  code catalogs or task history.
- Follow the [review and merge policy](docs/development.md#pull-request-reviews).
- Ask before adding root README sections or making major README changes;
  small factual corrections and link fixes do not need separate approval.
- Follow the [release procedure](docs/development.md#creating-a-github-release).
  Ask for `major`, `minor`, or `patch` if unspecified and obtain user approval
  of the proposed version and target before confirming publication.
