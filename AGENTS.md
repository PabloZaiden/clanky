# Agent working agreement

Clanky is a Bun application for coding-agent tasks. Start with the
[development guide](docs/development.md). This file owns instructions specific
to coding agents; shared technical policies live in the linked guides.
Read the relevant guide before changing its area, without loading every guide
for unrelated work.

## Plan and track work

- Before implementation, write verifiable goals in `.clanky-planning/plan.md`,
  present the plan, and wait for explicit approval. Reconfirm material changes.
- Use Todo tracking. The last Todo must be "verify that all goals are met
  according to the document, and update the Todo again".
- Keep `.clanky-planning/status.md` current after each task and before ending
  a response: completed/pending work, current state, findings, and next steps
  sufficient to resume after context loss.
- Reproduce bugs locally before fixing them unless the user explicitly waives
  reproduction. Keep disposable reproductions separate from product coverage.
- Use complexity levels when useful, never time estimates.

## Scope and autonomy

- Prefer the simplest change that meets the agreed goals; follow existing
  patterns and preserve unrelated work. Do not add speculative abstractions,
  coordination, or compatibility layers. Compatibility needs explicit approval
  or an established policy such as Mesh protocol evolution.
- Work directly unless another model is essential or independent parallel
  work offers a clear advantage.
- Use isolated data for experiments and validation. 
- If investigation identifies a new product scenario, obtain independent
  approval before adding coverage; approval to fix a bug is not that approval.
  Follow the [coverage decision gate](docs/development/testing.md#decide-whether-a-scenario-belongs).
- Discover APIs and helpers from their definitions and callers instead of
  duplicating them or maintaining prose catalogs.

## Validate and finish

- Follow the [testing and validation policy](docs/development/testing.md).
  Application changes require `bun run build && bun run test`; documentation-only
  changes need content/link review, not application builds.
- Validate UI changes with disposable Bun.WebView tooling and reviewed desktop
  and mobile screenshots; document why if capture is unavailable.
- Before declaring completion, check the plan against observable results,
  resolve required validation failures, and update Todos and status. Do not
  claim completion while a goal or required check remains unmet.

## Pull requests and documentation

- Follow the [review and merge policy](docs/development.md#pull-request-reviews):
  wait for review and address all feedback before merging unless explicitly
  instructed otherwise.
- Document changed behavior in the appropriate guide and update applicable
  skills. Ask before adding root README sections or making major README changes;
  small factual corrections and link fixes do not need separate approval.
- For releases, use `bun run release`. Ask for `major`, `minor`, or `patch`
  if unspecified, and review the proposed version and target before confirming
  publication. Never publish just to validate tooling. Follow the
  [release procedure](docs/development.md#creating-a-github-release) for mechanics.

## Consult by task

These guides are canonical for humans and agents. Keep policies there and
link to them rather than copying them back into this file.

| Task | Read before changing |
| --- | --- |
| Server/domain code, authorization, execution hosts, filesystem/Git, persistence, backends, realtime, or concurrency | [Architecture and domain boundaries](docs/development/architecture.md) |
| Automated tests, fixtures, coverage decisions, or validation | [Testing and validation](docs/development/testing.md) |
| UI, settings, routing, or webapp integration | [UI and webapp development](docs/development/webapp.md) |
| Breaking Mesh protocol changes | [Protocol evolution](docs/mesh-worker.md#protocol-evolution) |
| Deployment, authentication configuration, production access, or reset | [Deployment and configuration](docs/deployment.md) |
| Dependencies, PRs, or releases | [Development](docs/development.md) |
| fframes video creation or review | [Video skill](.agents/skills/fframes-video/SKILL.md) |
