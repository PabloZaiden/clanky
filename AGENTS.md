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
- Use development hosts recorded in private local guidance for ordinary
  task-scoped development, investigation, builds, tests, and native UI
  validation, not only iOS work, signing, or deployment. Existing approval,
  isolation, credential, and publication requirements still apply.
- Before declaring platform work blocked by the current execution host, check
  the relevant configured development host and its availability. Running on
  Linux alone is not a reason to leave native Mac validation pending when a
  development Mac is configured and available.

## Validate and finish

- Follow the [testing policy](docs/development/testing.md) for investigations,
  coverage and validation.
- Isolate development servers, tests, and manual experiments from any installed
  Clanky instance. Follow the [isolation requirements](docs/development/testing.md#isolation-synchronization-and-cleanup)
  before running application commands; never use the installed instance as a fixture.
- Before declaring completion, check the plan against observable results,
  resolve required validation failures, and update Todos and status. Do not
  claim completion while a goal or required check remains unmet.
- For UI work, apply the [product presentation policy](docs/development/webapp.md#product-presentation)
  before writing copy. Before finishing, inspect the rendered changes and
  justify every added subtitle, paragraph and hint against that policy;
  remove text that does not qualify instead of shortening or hiding it.
  Treat this inspection as a completion requirement, not an optional polish pass.

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
