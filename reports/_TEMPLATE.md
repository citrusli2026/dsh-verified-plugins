---
# Flat YAML front-matter. Keys and allowed values are enforced by
# schemas/report.schema.json via `node tools/validate-reports.mjs`.
# Replace every placeholder. Delete tiers you did not run by setting them to
# "skip" — and then make sure the verdict does not exceed the tiers that ran.
plugin: "@scope/name"
version: "0.0.0"
source: "https://www.npmjs.com/package/@scope/name"
integrity: "sha512-REPLACE_WITH_RESOLVED_INTEGRITY"
dsh_runtime: "0.2.0-rc.2"
node: "24.15.0"
os: "macos-15-arm64"
date: "YYYY-MM-DD"
verdict: "L0"
t0_static: "skip"
t1_install: "skip"
t2_load: "skip"
t3_measure: "skip"
t4_behaviour: "skip"
reporter: "your-handle"
author_disclosure: "false"
---

# `@scope/name@0.0.0`

One-paragraph plain summary of what this plugin claims to do, and what was
actually executed to check it. State the verdict and the tier it rests on.

## Subject

| | |
|---|---|
| Package | `@scope/name` |
| Version | `0.0.0` |
| Source | <https://www.npmjs.com/package/@scope/name> |
| Resolved integrity | `sha512-…` (`evidence/resolved.json`) |
| Repository | <https://github.com/owner/repo> |
| License | e.g. MIT |

## Environment

| | |
|---|---|
| DSH runtime | `0.2.0-rc.2` |
| Node | `24.15.0` |
| OS / arch | `macos-15-arm64` |
| Profile template used | `headless` in a throwaway `DSH_HOME` |
| Report commit | `<sha>` |

## Declared contract (T0)

What the package declares, quoted from its `package.json` — not paraphrased.

- `dsh.manifestVersion`:
- `dsh.bundle.patch`: (list each path in order; confirm each exists)
- `dsh.client.platform`:
- `engines.dsh`: *(a declaration only — see docs/method.md § Known limits)*

What the bundle patch changes: which entries it adds, overrides, or disables.

## Tier results

| Tier | Result | Evidence |
|---|---|---|
| T0 static | skip | — |
| T1 install | skip | — |
| T2 load | skip | — |
| T3 measure | skip | — |
| T4 behaviour | skip | — |

## Install (T1)

Install wall time, direct and transitive dependency counts, unpacked size.
Quote resolver output from `evidence/t1-install.log`.

### Dependency build scripts

List every lifecycle script the package and its dependency tree requested,
verbatim. State explicitly whether any were approved. **If any were approved,
say so here in bold** — approval runs commands with the reporter's permissions.

## Load (T2)

Exit status of the boot, and the loader output showing the entry's fiber
reaching `active`. Quote the diagnostics verbatim. Do not substitute a
`pluginInventory/list` snapshot for the boot log: that projection has no
history, so an absent row is not evidence of a clean load.

```
<paste the decisive loader output — unedited>
```

## Measurements (T3)

| Metric | Value |
|---|---|
| Install wall time | |
| Dependencies (direct / transitive) | |
| Unpacked size | |
| Build scripts requested | |
| Boot to `active` | |

Method notes: number of repetitions, and whether figures are a single run or a
distribution. Duration claims require repetitions.

## Behaviour (T4)

Only if run, and only ever with the reporter's own credential, locally — never
in this repo's CI. Give each probe task verbatim, the model, the exit code, the
`turn_end` reason, and the relevant slice of the `--json` stream. State that
model output is not bit-reproducible.

## Verdict

`L?_?` because …

## What this report does not establish

Mandatory. Be specific and honest — e.g. behaviour outside the probed paths,
other platforms, other DSH versions, safety, absence of malicious intent.

## Conflicts of interest

`author_disclosure` above is `false`. If you are an author or contributor of
this plugin, set it to `true` and describe the relationship here.

## Author reply

*(Reserved for the plugin's maintainers. Append a dated section; findings are
corrected in public, never deleted.)*
