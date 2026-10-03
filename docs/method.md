# Method of record

How a report in this repository is produced, what each tier proves, and what
none of it proves. This document is normative: a report that contradicts it is
wrong even if its numbers are right.

**Verified against** DSH `0.2.0-rc.2` as shipped in DeepSeek Harness Desktop
(packages `@deepseek-ai/dsh`, `dsh-package-manifest`, `dsh-plugin-manager`,
`dsh-host-plugin-inventory`, `dsh-headless`). Claims below about DSH behaviour
are drawn from those packages' published contracts and observed locally; DSH
pre-1.0 changes, so a report records the runtime version it ran against and its
findings are scoped to that version.

---

## 1. What a DSH plugin is

A plugin is an **npm package** that declares DSH metadata in `package.json`
under `dsh`. There is no separate plugin format and no registry of its own.

```jsonc
{
  "name": "example-dsh-plugin",
  "version": "1.0.0",
  "engines": { "node": ">=24", "dsh": "0.2.0-rc.2" },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

| Field | Meaning |
|---|---|
| `dsh.manifestVersion` | Manifest format identifier. The declared format is `1`. Independent of the npm version and of the session format version. |
| `dsh.bundle.patch` | One patch-file path, or an ordered list of them, each relative to the package root. The launcher applies a list **in order as one bundle layer**. |
| `dsh.client.platform` | Declares a client (UI) half, e.g. `web`. |
| `engines.dsh` | Author-declared compatible DSH versions as a SemVer range. **Declarative only.** |

A plugin becomes active by *selecting its bundle* in a profile: the profile's
`package.json` carries an ordered `dsh.profile.bundles` list, and the bundle's
patch is applied on top of the profile's configuration layers.

## 2. What "running" a plugin means here

DSH composes plugins through the Cordis Loader. The observable fact we build
tiers on is the **root fiber phase** of a loader entry, read via the
read-only `pluginInventory/list` projection:

`pending` → waits to load · `loading` → being read · **`active` → running** ·
`failed` → its fiber rejected · `unloading` → tearing down · `null` → no live
root fiber.

`pluginInventory/list` is a point-in-time snapshot with **no history**: a fiber
that failed and was removed is simply absent. That has a direct methodological
consequence — *the absence of a row is not evidence that a plugin loaded
cleanly*; a report must show the boot log and the phase, not merely a listing
that lacks an error.

## 3. Tiers

Each tier is a gate. A report claims only the highest tier that executed, and
all lower tiers must also have passed.

### T0 — Static audit (no execution)

Read-only inspection of the resolved package. Nothing is installed and nothing
is executed.

- Resolve the spec and record the exact version and integrity hash.
- Validate `dsh.manifestVersion` is present and supported.
- Confirm every path in `dsh.bundle.patch` exists in the tarball.
- Read the bundle patch and list which configuration entries it adds, overrides,
  or disables.
- Record `engines.dsh`, **as a declaration by the author**.
- Count dependencies and enumerate lifecycle scripts (`preinstall`,
  `install`, `postinstall`, `prepare`) requested by the package and its
  dependency tree.

`pnpm view` (or the DSH `inspect` path) is used for registry specs. Note what
`inspect` cannot do: for a git address or tarball it reports only the *form* and
the *host* it would be fetched from — it does not inspect the contents before
installation, and a git or tarball spec is compatibility-checked only *after*
installation.

### T1 — Install

Install into a **throwaway profile** — never the reporter's live profile. The
profile directory is disposable and `DSH_HOME` is redirected to a temp path.

Record: resolver output, lockfile entry including integrity, install wall time,
unpacked size, dependency count (direct and transitive), the list of dependency
build scripts requested, and whether any were approved.

DSH's own compatibility check runs before pnpm for *named* packages (a local
path is read from its own `package.json`; a registry spec is resolved and its
declared peers checked), refusing with a `compatible` failure before anything is
downloaded. Git and tarball specs cannot be pre-checked this way.

> **Build scripts are a finding, not a chore.** pnpm blocks dependency build
> scripts by default and DSH asks the user to approve them. Approval "permits
> commands with the host user's permissions". A report records the requested
> scripts verbatim and **never approves them on the user's behalf**. Running an
> install *with* scripts approved, where a report does so, is stated explicitly.

### T2 — Load (no model key required)

Boot a profile with the bundle selected and observe the fiber phase. The
mechanism that makes this tier free of credentials is documented by DSH itself:
**a profile whose own plugins fail to load exits before the agent runner
mounts**, and such a run "keeps only the loader's stderr diagnostics". Load
failure is therefore observable in the exit status and the loader's diagnostics
*without any model call* — no key, no network, no cost. That is the technical
basis for this repository's zero-secrets property.

Record: exit status, loader diagnostics verbatim, and the boot log showing the
entry's phase reaching `active`. A snapshot from `pluginInventory/list` may
accompany it, but the boot log is the evidence — that projection has no history,
so an absent row proves nothing.

**Open item, stated rather than glossed.** The exact invocation that composes a
profile, loads it, and returns without reaching a model is version-dependent and
is *not* pinned down here. Observed on DSH `0.1.0-rc.6`:

```sh
export DSH_HOME="$(mktemp -d)/dsh-home"          # never a real profile
dsh plugin --profile <name> version-exemptions   # initialises the profile
```

That writes `package.json` (carrying `dsh.profile.bundles`), `cordis.patch.yml`
and `pnpm-workspace.yaml`; booting afterwards composes `cordis.yml` from those
bundle layers. But `dsh --profile <name> --help` in that version **composes the
profile and then keeps running** — it is not a one-shot boot and must not be
used as the T2 evidence command. The first published report must establish and
record its own boot command for its runtime version; until a report shows one
working, `L2` claims are pending by default.

A related trap this repository exists to catch: the observed runtime matters.
The globally installed CLI on the machine used to draft this method was
`0.1.0-rc.6`, which does not implement the `version-exemptions` subcommand at
all — it forwards the unknown argument to pnpm and fails. The same command
exists in the `0.2.0-rc.2` runtime shipped in the desktop app. A report that
omits its runtime version is unreadable.

### T3 — Measure

Aggregate T1–T2 into comparable, reproducible numbers, written to
`evidence/t3-metrics.json`, plus a `repro.sh` that regenerates every evidence
file from a clean checkout.

Record at minimum: install wall time, direct and transitive dependency counts,
unpacked size, count of requested build scripts, boot-to-`active` wall time,
exit statuses, and the exact DSH runtime version and Node version. Repeat runs
are reported as a distribution, not a single number, where duration is claimed.

### T4 — Behaviour (requires a model key)

Model-driven probes of what the plugin actually does. These call a model and
therefore require credentials.

```sh
dsh --profile <throwaway> --json "<probe task>"
```

`--json` emits a newline-delimited event stream: `session` first, `final` last,
with `status`, `text`, `thinking`, `tool_call` and `tool_result` between. Exit
code `0` means the task completed and `1` means it aborted or errored; a
well-formed stream can still describe a failed run, so the exit code and the
`turn_end` reason are the failure signals, not the stream's shape.

Constraints on T4, all mandatory:

- **Never runs in this repo's CI.** T4 is run by the reporter, locally, with
  their own credential. The result is committed as evidence; the key is not.
- Probe tasks must be deterministic and stated verbatim in the report so a
  reader can re-run them. Probes with non-deterministic output are recorded as
  such and cannot support a claim of reproducibility.
- If a probe's output contains anything credential-shaped, it is redacted as
  `[redacted:<reason>]` with the reason stated, and the redaction is disclosed.

## 4. Verdict rubric

| Verdict | Requires | Meaning |
|---|---|---|
| `L0 UNVERIFIED` | T0 only (or nothing) | Metadata read; no execution. |
| `L1 INSTALLS` | T0 + T1 | Installs cleanly into a throwaway profile. |
| `L2 LOADS` | + T2 | Profile boots; the plugin's fiber reaches `active`. |
| `L3 MEASURED` | + T3 | Metrics captured and regenerable from committed evidence. |
| `L4 BEHAVES` | + T4 | Model-driven probes executed and recorded. |
| `X-FAILED` | any tier that executed and failed | State the failing tier and quote the error. |
| `BLOCKED` | execution prevented | State the concrete blocker. |
| `REFUSED` | declined | State why; e.g. requires a credential or host mutation. |

`L2` is the headline tier. It is the strongest claim obtainable **without a
credential**, and it is the one a star list can never make.

## 5. Evidence rules

1. **Every claim maps to a file** under `reports/<plugin>/evidence/`. A sentence
   with no artifact behind it is deleted or downgraded to an open question.
2. **Evidence is raw and unedited.** No trimming, reordering, or reflowing.
   Redaction uses `[redacted:<reason>]` and is disclosed in the report.
3. **The environment is recorded exactly**: DSH runtime version, Node version,
   OS and architecture, profile template, and the commit SHA of the report.
4. **`repro.sh` must regenerate the evidence** from a clean checkout with no
   credentials. If it cannot, the report is `BLOCKED`.
5. **A report is merged only after a second party reproduces it.** The
   maintainer re-runs `repro.sh` and records that in the PR.
6. **Corrections are additive.** A wrong finding is corrected by a new dated
   section and a bumped verdict, not by quietly editing the original. Plugin
   authors have a standing right of reply.

## 6. Threat model

### What we are defending against

Running third-party code in a CI system that holds credentials. The
consequences here are unusually direct: DSH loads plugin Host code *in-process,
outside the workspace sandbox*, so "the plugin" is ordinary code running with
the user's permissions. There is no sandbox to break out of; a malicious plugin
is not an escalation, it is simply the user's own authority, exercised.

### The split

| | `ci.yml` — static | `verify.yml` — execution |
|---|---|---|
| Trigger | `pull_request`, `push` to `main` | `workflow_dispatch` only |
| Runs plugin code? | **never** | yes, in an ephemeral throwaway profile |
| Credentials present | none | none |
| `permissions` | `contents: read` | `{}` |
| OIDC | disabled | disabled |
| Secrets referenced | none | none |
| Network | not required | not required for T1–T2 |

Static CI validates front-matter, layout and workflow policy, and never
installs or executes a plugin. The execution tier is manual, so no pull request
— from a fork or otherwise — can cause third-party code to run in this
repository's CI.

### Enforced controls

[`tools/policy/check-workflows.mjs`](../tools/policy/check-workflows.mjs) fails
CI when a workflow:

- references `secrets.*` (any secret, any job);
- uses `pull_request_target` or `workflow_run`;
- grants write permissions or `id-token: write`;
- runs a plugin-executing step (`pnpm add`, `dsh plugin add`, `dsh plugin …`)
  outside a `workflow_dispatch`-only workflow, or in a workflow that is not
  `permissions: {}`;
- uses an unpinned or non-SHA-pinned action, or a non-first-party action
  without an explicit pin;
- exports a token into the environment (`GITHUB_TOKEN`, `ACTIONS_RUNTIME_TOKEN`)
  for a step that executes plugin code.

The checker has a **self-test with bad fixtures**: if the rules stop firing, CI
fails. A guardrail that cannot be shown to trigger is theatre.

### Residual risk, stated honestly

- A GitHub-hosted runner has ambient credentials that are not repository
  secrets. The manual execution tier therefore also drops `GITHUB_TOKEN` from
  the environment of the plugin-executing step and disables OIDC; it does not
  pretend the runner is a security boundary.
- **We cannot cryptographically prove "zero secrets" from inside CI.** The
  no-secrets claim is auditable from outside via the GitHub API
  (`tools/audit/no-secrets.sh`) and is asserted as a reviewable repo property.
- T1–T3 fetch a package. The registry and its TLS are trusted implicitly, which
  is exactly why the resolved integrity hash — not the registry's advertised
  one — is recorded.
- This is not a security audit and no report is a safety guarantee. A report
  says what was run and what was seen. A plugin can be malicious in ways no
  smoke test detects.

## 7. Known limits

Stated plainly, because the credibility of the reports depends on not
overclaiming.

1. **`engines.dsh` is not enforced.** The manifest package's own documentation
   says compatibility "is declarative" and that "current installers and loaders
   do not enforce `dsh.manifestVersion` or `engines.dsh`; declaring a range does
   not reject incompatible hosts or validate SemVer syntax." A plugin can claim
   any range. Reports therefore record the *observed* runtime and never treat a
   declared range as evidence of compatibility.
2. **Version exemptions bypass the compatibility check entirely.** A profile's
   `compatibility.json` maps an exact `package@version` to exact DSH runtime
   versions. Granting one is an explicit accept-risk operation (the CLI warns
   that incompatible plugins may break the application or corrupt data). No
   report relies on an exemption, and a report that needed one says so.
3. **"Loaded" is not "correct".** A fiber reaching `active` proves the plugin
   mounted, not that its behaviour is right, safe, or useful. Reaching `active`
   is a floor, not a certificate.
4. **No history in the inventory.** `pluginInventory/list` provides no change
   subscription and no history, so a transient failure that is later removed is
   invisible to a snapshot. Only the boot log is evidence.
5. **T4 is not reproducible in the strict sense.** Model output varies between
   runs and providers. T4 evidence is bounded by the recorded runtime, model
   and prompt, and is reported as an observation, not a measurement.
6. **Single-environment reports.** A report is scoped to the OS, architecture
   and DSH version recorded in it. Cross-platform behaviour is not established
   by a single report.
7. **Quantity is not coverage.** This repo will always hold a small fraction of
   published DSH plugins. An unreported plugin is unreported, not suspicious.
