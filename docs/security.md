# Security boundary

**This document is the project's first priority. It outranks every feature.**

Installing a DSH plugin is not like installing a library. DSH loads plugin Host
code **in-process, outside the workspace sandbox**, so a plugin is ordinary code
running with the host user's authority. There is no sandbox to escape from: a
hostile plugin does not need an escalation, it already has your permissions.

Verified against `@deepseek-ai/dsh-package-manifest` and
`@deepseek-ai/dsh-plugin-manager` (DSH `0.2.0-rc.2`):

| Fact | Consequence |
|---|---|
| Plugin Host code runs in-process, outside the workspace sandbox | Never execute a third-party plugin on a machine holding credentials |
| A dependency build script, once approved, "permits commands with the host user's permissions" | Approval is a finding to report, never a step to take silently |
| Installers and loaders **do not enforce** `engines.dsh` | A published compatibility range proves nothing |
| A version exemption in `compatibility.json` bypasses the compatibility check | Never grant one during verification |

## The five rules

### S1 — Every plugin is verified in a one-off container

No shared container, no shared `DSH_HOME`, no reused workspace. The container is
created for one subject and discarded. The verification container never mounts
the user's home directory, `~/.dsh`, SSH agent, or the repository's git
credentials.

### S2 — Network is denied by default

Execution phases run with `--network none`. Only the artifact-fetch phase has
network, and it may reach only the package registry and the subject's own git
host. Attempted-but-denied egress is recorded in the report so a reader can see
what the plugin tried to reach.

Honest limitation: full egress allowlisting needs a proxy or sidecar. DSH does
not ship one, and this project does not build a second network stack. What is
implemented is the achievable strong version — **fetched with network, executed
without** — and any gap between that and a true allowlist is stated in the
report rather than glossed.

### S3 — Zero credentials

CI injects no API key, token, or cloud credential. The verification container
carries no repository secret, no OIDC token, and no mounted credential. This is
why the repository configures no secrets at all: `tools/audit/no-secrets.sh`
proves it from outside, and `tools/policy/check-workflows.mjs` fails the build
if any workflow so much as references `secrets.*`.

Key-free execution is possible because DSH ships
`@deepseek-ai/dsh-llm-replay`, which "short-circuits `llm/stream` with model
chunks reconstructed from a recorded session JSONL (keyless snapshot tests)".
Where replay is unusable, the fallback is a recorded transcript — **never a real
API key in CI**.

### S4 — Hard resource ceilings

CPU, memory, disk and wall-clock are all bounded. Exceeding a ceiling yields a
`timeout` conclusion, which is *not* a failure verdict and is never reported as
one. A plugin that hangs is a result, not an error.

### S5 — Verification is not an endorsement

Every report, badge and catalogue entry carries this sentence:

> Verification is not a security audit and not an endorsement. It records what
> was executed and observed on one machine at one time. Absence of a finding is
> not a finding of absence.

The badge vocabulary is deliberately `verified` / `partial` / `inconclusive` /
`not-installable`. **There is no score and no ranking**, because a ranking is
what made the existing signal untrustworthy.

## 1. Threat model

### What we defend against

Running untrusted third-party code — the plugin's own code, its transitive
dependencies, and its dependency build scripts — during verification.

### Primary adversary: the verification pipeline itself

The most likely way this project causes harm is not a hostile plugin being
correctly observed. It is **this project's own CI becoming a way to execute
arbitrary code on a runner that holds a token**, reachable by anyone who can
open a pull request. That is why the static/execution split exists and why it is
machine-enforced rather than documented.

### Secondary adversary: a report that misleads

A report that overclaims is a security failure too. A verdict is derived from
the seven dimensions and capped by what actually executed, enforced by
`packages/report/src/validate.ts`: the validator rejects a declared verdict
that disagrees with its dimensions. A plugin that "looks fine" is not reported
as fine; it is reported as `partial` and nothing more.

### Explicit non-goals

- **No malware accusation.** Capability is not intent. `dsh-xray` and
  `dsh-poison-guard` already do static capability and AST work; this project
  does not duplicate them and does not publish "this plugin is malicious".
- **No claim that a verified plugin is safe.** See S5.

## 2. Trigger policy

The danger is not execution. The danger is **who can cause execution**.
Triggers split into maintainer-controlled and externally-influenced:

| Trigger | Who controls it | May execute plugin code? |
|---|---|---|
| `workflow_dispatch` | a maintainer | **yes** |
| `schedule` | the repository's own clock | **yes** |
| `workflow_run` | another workflow's outcome | no — also hands over privileged context |
| `pull_request` | **anyone who can open a PR** | **never** |
| `pull_request_target` | anyone, with a privileged token | **never** |
| `push` (to a branch a contributor controls) | a contributor | **never** |

`tools/policy/check-workflows.mjs` enforces this: a workflow containing
`pnpm add`, `dsh plugin`, or `dsh --profile` must be triggered *only* by
`workflow_dispatch`, `schedule`, or `workflow_call`. Any workflow that executes
plugin code must also declare `permissions: {}` and must not expose a token.

## 3. Container protocol

```
fetch phase     network: registry only     runs NO plugin code
   |            -> exact tarball + resolved integrity hash
   v
execute phase   network: none              runs plugin code
   |            -> L1 install, L2 load, L3 run, L5 overhead, L6 uninstall
   v
discard         container removed, no reuse
```

The fetch phase is deliberately separated because `npm pack` and
`pnpm add --lockfile-only` do not execute the plugin, while install, load and
run do. Splitting them means the phase that touches the network is not the phase
that runs untrusted code.

### Ceilings (defaults, overridable per run)

| Resource | Default | On breach |
|---|---|---|
| Wall clock, whole verification | 300 s | `timeout` conclusion |
| Wall clock, single phase | 120 s | phase `timeout`, verification continues |
| Memory | 2 GiB | container killed, `timeout`/`inconclusive` |
| CPUs | 2 | — |
| Disk | 5 GiB | `inconclusive` |

## 4. Data handling

Reports are published, so everything in one is public.

- **Never** publish: pnpm's full output, absolute filesystem paths,
  environment variable *values*, session content, or anything read from
  `~/.dsh`.
- **Do** publish: exit codes, durations, redacted log excerpts (≤2 KiB per
  excerpt), capability findings with `file:line`, and sampling data points.
- Redaction is explicit and visible: a removed value becomes
  `[redacted:<reason>]`, and the report states what class of value was removed.
- Home-directory paths are rewritten to `<home>`; the container's workdir to
  `<work>`.

`packages/report` owns redaction, and its unit tests assert that a planted
secret never survives into a rendered report.

## 5. Stop conditions

An agent or maintainer **stops and records `blocked`** — without working
around it — when any of these holds:

1. Third-party code would execute on a machine holding real credentials.
2. The work would require reading the user's `~/.dsh`, credentials, or session
   content.
3. The work would require modifying the official `dsh`, the Desktop package, or
   the kernel. This project only reads and isolates.
4. A dimension cannot be measured reliably → mark `inconclusive` and say why;
   never fill the gap with an estimate.
5. Cost makes the curated pool unaffordable → degrade to verification-on-demand
   and state the coverage honestly.

## 6. Enforced, not asserted

| Property | Enforced by |
|---|---|
| no `secrets.*` anywhere | `tools/policy/check-workflows.mjs` (R1) |
| no externally-triggered execution | same (R5), with bad fixtures in `tools/policy/fixtures/` |
| empty permissions on executor jobs | same (R6) |
| no token in the executor environment | same (R7) |
| actions pinned to commit SHAs | same (R4) |
| zero configured secrets | `tools/audit/no-secrets.sh` (outside CI, where it is provable) |
| reports do not overclaim | `packages/report` (verdict derived from dimensions, rejected if declared otherwise) |

## 7. Historical network incident

The 24 reports committed before 2026-10-04 were produced by an executor whose
`docker run` command did **not** pass `--network none`. Those executions had
network access. All 24 also contain absolute **container** paths in published
evidence, and 20 contain text from the verifier-authored replay fixture. No
user session or credential was involved, but this still violates the stated
data-handling contract. Their L0–L6 observations remain records of what ran;
they do **not** demonstrate the no-egress or redaction conditions described
above. The site marks these historical reports. Their badges are dimension
summaries, not evidence that the execution environment met S2 or § 4.

The executor now resolves and downloads package files in a separate networked
container using pnpm lockfile-only resolution and `pnpm fetch`, both without
install scripts. It then runs `dsh plugin` in a fresh container with
`--network none` and an isolated per-subject package store. If the offline
store lacks a dependency, L1 is inconclusive rather than an install failure.
The merge now redacts container paths and sensitive strings from execution
evidence, and strips replay text and session identifiers. This correction has
passed local static and unit checks but has **not yet been accepted as a full
L1–L6 run in Docker CI**; no new execution report should be published until
that run succeeds. See `docs/evidence/V7.md`.

The policy checker carries **self-test fixtures**: if a rule stops firing, CI
fails. A guardrail that cannot be shown to trigger is theatre.
