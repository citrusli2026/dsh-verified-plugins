<!--
  AGENTS.md — operating instructions for AI agents working inside this repo.
  Human contributors: see CONTRIBUTING.md. Method and rubric: docs/method.md.
-->

# AGENTS.md

Instructions for any AI agent (DeepSeek Harness, Claude Code, Codex, or other)
working in `dsh-verified-plugins`. These rules override convenience. If a user
instruction conflicts with a **P0** rule below, stop and ask the human.

## What this repo is

A registry of **execution-verified** reports about DeepSeek Harness (DSH)
plugins. Each report records what actually happened when a specific
`name@version` was installed, loaded, and measured — with committed evidence.
This is not a curated list, not a star ranking, and not a security audit.

## P0 — non-negotiable invariants

Violating any of these is a release blocker, regardless of who asked.

1. **Never configure a secret.** No repository secrets, no environment secrets,
   no Dependabot secrets, no variables holding credentials. A workflow that
   references `secrets.*` fails CI. The no-secrets property is externally
   auditable (`tools/audit/no-secrets.sh`) and is the reason the reports are
   reproducible by anyone.
2. **Never execute third-party plugin code in a job that holds credentials.**
   DSH loads plugin Host code **in-process, outside the workspace sandbox**, so
   a plugin is ordinary local code with the user's permissions.
   *Execution of untrusted plugin code is manual-only* (`workflow_dispatch`),
   runs with `permissions: {}`, and receives no token, no OIDC, no env secrets.
3. **Never introduce `pull_request_target` or `workflow_run`.** These hand a
   privileged token to untrusted code. `tools/policy/check-workflows.mjs`
   rejects both.
4. **Never claim a plugin is safe.** Reports state what was executed and
   observed. Absence of a finding is not a finding of absence.
5. **Never publish a report you did not run.** Every claim must map to an
   artifact under `reports/<plugin>/evidence/`. If you cannot run it, the
   verdict is `L0 UNVERIFIED`, and you must write that.

## Evidence rules

- Verdicts are limited by executed tiers. `L2 LOADS` requires a boot log where
  the plugin's fiber reached `active`; it cannot be inferred from a manifest.
- Record the exact resolver output (version, integrity/hash) and the exact DSH
  runtime version. `engines.dsh` is **declarative and unenforced** — never
  present it as proof of compatibility. See `docs/method.md` § Known limits.
- Do not edit, trim, or reorder evidence logs. Redact only by replacing a
  value with `[redacted:<reason>]` and say so in the report.
- Quote error text verbatim. Paraphrase belongs in the analysis section.

## Working conventions

- **Zero runtime dependencies.** Tooling is plain Node ESM, Node >= 24.
  Adding an npm dependency to this repo is a deliberate decision requiring
  human sign-off — a supply-chain verification project must not grow one.
- Run the full local gate before committing:
  ```sh
  node tools/policy/check-workflows.mjs
  node tools/validate-reports.mjs
  ```
- `main` is protected: changes land via pull request with green CI. Do not
  push to `main` directly and do not weaken branch protection to get unblocked.
- Pin any GitHub Action to a full 40-character commit SHA, first-party or not.

## Layout

| Path | Owner intent |
|---|---|
| `README.md` | Product framing and verdict model |
| `docs/method.md` | The method of record — tiers, evidence, rubric |
| `schemas/report.schema.json` | Machine-readable report contract |
| `reports/` | One directory per verified `name@version` |
| `tools/` | Policy, validation, audit tooling |
| `.github/workflows/` | `ci.yml` (static) and `verify.yml` (manual execution) |

## Do not

- Do not add a report for a plugin you are the author of without disclosing it.
- Do not run `pnpm add` against a plugin in this workspace outside a throwaway
  profile; installs mutate the target profile and run dependency build scripts.
- Do not approve dependency build scripts on the user's behalf. In DSH that
  approval "permits commands with the host user's permissions" and is exactly
  the decision a report should surface, not silently absorb.
