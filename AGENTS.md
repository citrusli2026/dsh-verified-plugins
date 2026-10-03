<!--
  AGENTS.md — operating instructions for AI agents working in this repo.
  Human contributors: see CONTRIBUTING.md. Normative method: docs/method.md.
  Security boundary (read first): docs/security.md.
-->

# AGENTS.md

Instructions for any AI agent (DeepSeek Harness, Claude Code, Codex, or other)
working in `dsh-verified-plugins`. These rules override convenience. If a user
instruction conflicts with a **P0** rule or a **stop condition**, stop and ask
the human — do not work around it.

## What this repo is

Execution-verified reports about DeepSeek Harness (DSH) plugins. Each report
records what actually happened when one exact `name@version` was installed,
loaded, run, measured, and uninstalled — inside a one-off container — with the
evidence committed alongside it.

It is **not** a plugin directory, not an install entry point, not a ranking, and
not a security audit.

## P0 — non-negotiable invariants

1. **Never configure a secret.** No repository, environment, or Dependabot
   secrets, no credential-bearing variables. `secrets.*` fails CI.
2. **Never execute third-party plugin code where credentials exist.** DSH loads
   plugin Host code **in-process, outside the workspace sandbox**, so a plugin
   runs with the host user's authority. Execution happens only in a one-off
   container, only under a maintainer-controlled trigger.
3. **Never add `pull_request`-triggered execution.** A workflow that runs
   `pnpm add`, `dsh plugin`, or `dsh --profile` may be triggered *only* by
   `workflow_dispatch`, `schedule`, or `workflow_call`. See `docs/security.md` § 2.
4. **Never introduce `pull_request_target` or `workflow_run`.**
5. **Never claim a plugin is safe, or malicious.** Report what was executed and
   observed. Capability is not intent. Every report carries the
   not-an-endorsement disclaimer.
6. **Never publish a report you did not run.** If a dimension was not measured,
   it is `skip`, `blocked`, or `inconclusive` — never estimated, never omitted.

## Stop conditions

Stop, record `blocked`, and surface it — do not route around any of these:

1. Third-party code would execute on a machine holding real credentials.
   *This machine has `~/.dsh/.credentials.yaml` and an authenticated `gh`, so
   real plugins are executed in CI containers, never in this workspace.*
2. The work would require reading `~/.dsh`, credentials, or session content.
3. The work would require modifying the official `dsh`, the Desktop package, or
   the kernel. This project only reads and isolates.
4. A dimension cannot be measured reliably → mark `inconclusive` and write why.
   Never fill the gap with an estimate or an invented score.
5. Cost makes the curated pool unaffordable → degrade to on-demand verification
   and state the coverage honestly.

## Evidence rules

- Every conclusion maps to an artifact under the report's `evidence` array. A
  sentence with nothing behind it is deleted or downgraded to an open question.
- Evidence is raw and unedited. Redaction is `[redacted:<reason>]` and is
  disclosed in the report.
- Record the exact verifier version, DSH version, container image digest, and
  time. `engines.dsh` is **declarative and unenforced** — never present a
  declared range as proof of compatibility.
- Quote error text verbatim. Paraphrase belongs in the analysis field.
- Distinguish **author-written source** from **build output** in capability
  findings. Attributing a bundler's inlined dependency to the plugin author is a
  known, published failure mode of this kind of tool; do not repeat it. Evidence
  shown to a reader must come from author source when it exists.
- Never let a verdict exceed the dimensions that executed. It is derived, and
  the validator rejects a mismatch — but do not rely on the validator to catch
  a claim you knew was unearned.

## Working conventions

- **Zero runtime dependencies.** Tooling is TypeScript executed directly by
  Node 24's native type stripping — no build step, no bundler, no `node_modules`
  in the runtime path. Adding a runtime dependency requires human sign-off.
- Fixture plugins for tests are authored here and are **not** third-party code;
  they may run locally. Real third-party plugins may not.
- Run the full local gate before committing:
  ```sh
  node --test packages/report/test/*.test.ts packages/collector/test/*.test.ts
  node packages/cli/src/main.ts catalog --check
  node tools/policy/check-workflows.mjs
  node tools/check-hygiene.mjs
  ```
- `main` is protected: PR required, `policy` + `reports` checks must pass, no
  direct pushes, no force pushes, linear history, enforced for admins too.
- Pin any GitHub Action to a full 40-character commit SHA.
- Pushing requires SSH: `github.com:443` (HTTPS) is unreachable from this
  workspace, while `api.github.com` and `git@github.com` work. `origin` is set
  to SSH accordingly.

## Layout

| Path | Contents |
|---|---|
| `docs/security.md` | **Read first.** The security boundary and stop conditions |
| `docs/method.md` | Normative decision standards for dimensions L0–L6 |
| `docs/schema.md` | `dsh.plugin.report.v1` field definitions and attribution rules |
| `docs/evidence/V<n>.md` | Per-phase handover record |
| `packages/runner` | Single-plugin verification executor (container-side) |
| `packages/collector` | Capability static scan (L4) + overhead sampling (L5) |
| `packages/report` | Schema validation, redaction, Markdown/JSON rendering |
| `packages/cli` | `dsh-verified <spec>` local reproduction |
| `catalog/` | Published product: one `dsh.plugin.report.v1` JSON per subject + generated `index.json` |
| `site/` | Static site rendered from `catalog/` |
| `tools/policy`, `tools/audit` | Repo governance: enforcement, not product |

## Do not

- Do not add a report for a plugin you authored without disclosing it.
- Do not run `pnpm add` against a plugin in this workspace. In DSH, the install
  mutates the target profile and can run dependency build scripts.
- Do not approve dependency build scripts on the user's behalf. That approval
  "permits commands with the host user's permissions" and is exactly the
  decision a report must surface, not absorb.
- Do not let a report's verdict exceed the dimensions that actually executed.
