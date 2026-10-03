# dsh-verified-plugins

**Execution-verified plugin reports for DeepSeek Harness** — install it, load it, run it, measure it.
Evidence-linked, reproducible, not another star list.

[Method](docs/method.md) · [Reports](#reports) · [Submit a plugin](#submit-a-plugin) · [Security policy](#p0--security-policy) · [Contributing](CONTRIBUTING.md)

> **Status: V0 complete, 0 reports published.**
> The security boundary and the verification container are in place and measured
> in CI — see [docs/evidence/V0.md](docs/evidence/V0.md). The report contract
> described below is being replaced by `dsh.plugin.report.v1`
> ([docs/schema.md](docs/schema.md)) in V1; until then, treat the
> `reports/` layout in this README as the interim shape and
> [docs/method.md](docs/method.md) as the method of record.
> Read [docs/security.md](docs/security.md) first.

---

## Why this exists

Plugin directories tell you a plugin exists, roughly how popular it is, and how
its author describes it. None of that is a measurement. A DSH plugin is not a
sandboxed decoration: its Host code runs **in-process, outside the workspace
sandbox**, and dependency build scripts it triggers run **with your
permissions**. "Trust the author" is therefore a real decision with real
consequences, and a star count is not evidence for it.

This repo publishes the opposite: a small number of reports, each one stating
exactly which `name@version` was executed, in what environment, what was
observed, and where the raw output lives.

## Verdict model

A verdict names the **highest tier that actually executed**. It is not a score
and not a quality judgement. Tiers are cumulative and gated: you cannot claim a
tier you did not run.

| Tier | Gate | What is executed | Needs a model key? |
|---|---|---|---|
| `L0` | **UNVERIFIED** | Nothing extracted; metadata read only | no |
| `L1` | **INSTALLS** | T0 static audit + T1 install into a throwaway profile | no |
| `L2` | **LOADS** | T2 profile boot; plugin fiber reaches `active` | no |
| `L3` | **MEASURED** | T3 metrics captured and reproducible from committed evidence | no |
| `L4` | **BEHAVES** | T4 model-driven probes | **yes** |

Outcomes that are not tiers: `X-FAILED` (executed, plugin broke), `BLOCKED`
(environment prevented execution — say why), `REFUSED` (declined, e.g. the
plugin requires a credential or host mutation we will not perform).

The important consequence: **`L0`–`L3` require no credential of any kind.** A
plugin that fails to load makes the DSH process exit *before the model runner
mounts*, so load correctness is observable without calling a model at all. That
is why this repo configures zero secrets and still verifies things. `L4` needs a
key, so `L4` never runs in CI, and a report that stops at `L3` is a complete,
useful result rather than an unfinished one.

## What a report contains

- **Subject** — exact `name@version`, source URL, and the resolved integrity
  hash / tarball digest actually installed (not the one the registry advertises).
- **Environment** — DSH runtime version, Node version, OS/arch, profile
  template, and the commit that ran it.
- **Tier results** — one row per tier with pass/fail and a link to its evidence.
- **Observations** — declared-contract audit: does `dsh.bundle.patch` resolve,
  what does the bundle patch change, how many dependency build scripts are
  requested, what `engines.dsh` claims versus what actually ran.
- **Metrics** — install time, dependency count (direct/transitive), unpacked
  size, build scripts requested and whether any were approved, boot to `active`.
- **Verdict and limits** — including what the report does *not* establish.
- **Right of reply** — plugin authors may file a PR appending a response; the
  report body is never edited to remove a finding.

Report shape is enforced by [`schemas/report.schema.json`](schemas/report.schema.json)
and rendered by [the template](reports/_TEMPLATE.md).

## Reports

| Subject | Verdict | DSH runtime | Date | Report |
|---|---|---|---|---|
| _(none yet)_ | — | — | — | — |

Reports are directories, not rows:

```
reports/<plugin-name>/
├── report.md          # the report, front-matter validated by CI
├── evidence/          # raw, unedited command output (committed)
│   ├── t1-install.log
│   ├── t2-boot.log
│   ├── t3-metrics.json
│   └── resolved.json
└── repro.sh           # the exact script that produced the above
```

The point of committing `repro.sh` alongside `evidence/` is that a reader can
re-run it and get the same files. A report whose evidence cannot be regenerated
is marked `BLOCKED`, not published as a finding.

## Reproduce a report

```sh
git clone https://github.com/citrusli2026/dsh-verified-plugins
cd dsh-verified-plugins
reports/<plugin-name>/repro.sh          # writes into .verify/, never into your live profile
```

`repro.sh` uses a **throwaway profile** (`DSH_HOME` pointed at a temp dir) and
never touches your real DSH profile, sessions, or credentials.

## Submit a plugin

Open a PR adding `reports/<plugin-name>/`. Requirements are in
[CONTRIBUTING.md](CONTRIBUTING.md); the short version:

1. Run the tiers you claim, using a throwaway profile.
2. Commit the raw evidence, unedited.
3. Let CI validate front-matter and policy.
4. A maintainer re-runs `repro.sh` before merge. A report is merged only if a
   second party reproduced it.

Nominating someone else's plugin is welcome; you do not need to be the author.
If you *are* the author, disclose it in the report.

## P0 — security policy

These are enforced, not aspirational.

1. **Zero secrets.** No repository, environment, or Dependabot secrets, ever.
   Verify a clone or this repo with:
   ```sh
   gh api repos/citrusli2026/dsh-verified-plugins/actions/secrets   # expect total_count: 0
   gh api repos/citrusli2026/dsh-verified-plugins/actions/variables # expect total_count: 0
   ```
   or run [`tools/audit/no-secrets.sh`](tools/audit/no-secrets.sh).
2. **Third-party plugin code never runs in a job that holds credentials.**
   Plugin execution is manual-only (`workflow_dispatch`), with
   `permissions: {}` and no token in the environment.
3. **Forbidden triggers.** `pull_request_target` and `workflow_run` are
   rejected by CI — they hand privileged tokens to untrusted code.
4. **Pinned actions.** Every action is pinned to a full commit SHA and checked
   by [`tools/policy/check-workflows.mjs`](tools/policy/check-workflows.mjs).

`ci.yml` runs on `pull_request` and is strictly static: it never installs or
executes a plugin. `verify.yml` is the execution tier and is manual-only. The
split is the whole design — see [docs/method.md](docs/method.md) § Threat model.

To report a problem with **this repo's tooling or a published report**, open an
issue. To report a vulnerability in a **plugin**, contact that plugin's author;
this repo is not a security response channel.

## Layout

| Path | Contents |
|---|---|
| [`docs/method.md`](docs/method.md) | The method of record: tiers, evidence rules, threat model, known limits |
| [`AGENTS.md`](AGENTS.md) | Operating rules for AI agents working in this repo |
| [`schemas/`](schemas) | Machine-readable contracts |
| [`reports/`](reports) | One directory per verified `name@version` |
| [`tools/`](tools) | Policy, validation and audit tooling (zero dependencies) |
| [`.github/workflows/`](.github/workflows) | `ci.yml` (static) and `verify.yml` (manual execution) |

## Local gate

```sh
node tools/policy/check-workflows.mjs   # P0 workflow policy + self-test
node tools/validate-reports.mjs         # report front-matter contract
```

Both are zero-dependency Node ESM and run in CI on every pull request.

## License

[MIT](LICENSE). The license covers this repository's method, tooling and
reports. It grants no rights to any third-party plugin, and a report here is
**not** an endorsement, certification, or warranty. DSH itself is a separate
project by DeepSeek; this repo is independent and unaffiliated.
