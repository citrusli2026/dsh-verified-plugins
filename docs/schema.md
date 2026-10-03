# `dsh.plugin.report.v1`

The machine-readable report contract. The schema of record is
[`schemas/dsh.plugin.report.v1.schema.json`](../schemas/dsh.plugin.report.v1.schema.json);
this document explains the intent behind its fields.

A report describes **one exact `name@version`** at **one point in time** in
**one environment**. It is validated by `packages/report` before it is ever
published, and CI refuses to build an index over a report that fails.

## Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | Exactly `dsh.plugin.report.v1`. |
| `reportId` | yes | Stable identity, conventionally `npm:<name>@<version>`. |
| `generatedAt` | yes | ISO 8601 UTC. A report is a snapshot, not a living document. |
| `supersedes` | no | `reportId` this one replaces. |
| `verifier` | yes | Name, version, and full commit SHA. Short SHAs are not published. |
| `subject` | yes | The exact artifact, including the **resolved** integrity hash. |
| `runtime` | yes | DSH and Node versions. `not-executed` when no runtime ran. |
| `container` | no | Image and digest. `imageDigest: null` states plainly that the image is unaddressed by digest. |
| `verdict` | yes | See the ladder below. Capped by the dimensions that executed. |
| `dimensions` | yes | All seven, always. A dimension that did not run is `skip`, never omitted. |
| `capabilities` | no | L4 findings. Presence only — never characterised as malicious. |
| `overhead` | no | L5 differential sampling. |
| `bundlePatch` | no | Analysis of the declared `cordis.patch.yml`. |
| `evidence` | yes | At least one entry. Every conclusion maps to one. |
| `redactions` | no | Disclosed removals, so a reader can see something was taken out. |
| `disclaimers` | yes | Must include the canonical not-an-endorsement sentence, verbatim. |
| `limits` | no | What this run could not establish. |
| `changelog` | no | Corrections are additive; findings are superseded, never quietly edited. |

### `subject`

| Field | Meaning |
|---|---|
| `spec`, `name`, `version` | The exact version. Never a range, tag, or branch. |
| `integrity` | The hash **actually resolved at fetch time**, not the one the registry advertises. |
| `tarball`, `registry`, `shasum`, `repository`, `license`, `publishedAt` | Provenance. |
| `dshBundlePatch` | Declared `dsh.bundle.patch`, quoted from `package.json`. |
| `declaredEnginesDsh` | Author-declared `engines.dsh`. **Declarative only** — installers and loaders do not enforce it, so it is never evidence of compatibility. |

## Dimensions

Seven fixed keys, each an object:

```jsonc
"L4_capability": {
  "id": "L4",
  "status": "pass",
  "summary": "2 capability signal(s) present across 9 scanned file(s)",
  "metrics": { "scannedFiles": 9 },
  "evidenceRefs": ["e-l4"],
  "notes": ["static analysis cannot see dynamically constructed code or prove intent"]
}
```

| Key | Question it answers |
|---|---|
| `L0_qualification` | Is this actually an installable bundle? Does `dsh.bundle.patch` exist, and do the declared paths resolve? |
| `L1_install` | Does it install into a clean `DSH_HOME`, and if not, why? |
| `L2_load` | Do the Host and Client halves actually come up — every loader fiber `active`, no error? |
| `L3_run` | Does a minimal session complete **without a credential**? |
| `L4_capability` | What can it reach for statically: runtime patch, subprocess, port, secret env, hooks, out-of-workspace writes? |
| `L5_overhead` | What does it cost at runtime, measured differentially against a baseline? |
| `L6_uninstall` | After removal, are there leftover layers, orphan processes, or files? |

### Status vocabulary

| Status | Meaning |
|---|---|
| `pass` | Executed and succeeded. |
| `fail` | Executed and failed. |
| `skip` | Did not execute. Never an implicit pass. |
| `blocked` | Could not execute, and the reason is recorded. |
| `inconclusive` | Executed, but the result does not settle the question. |
| `timeout` | A hard resource ceiling was hit. **Not** a failure verdict. |

A `pass` or `fail` **must** cite at least one piece of evidence. A claim with
nothing behind it is not publishable.

## Verdict ladder

Derived from the dimensions, never authored independently — the validator
rejects a declared verdict that disagrees with its dimensions.

```
L0 = fail                                  -> not-installable
every dimension = pass                     -> verified
at least one pass, not all                 -> partial
no dimension is pass                       -> inconclusive
```

One `blocked` dimension is enough to lose `verified`. That is the rule that
makes the word mean something: a static-only run reaches `partial` at best,
because nothing was installed, loaded or run.

## Capability findings

`capabilities[]` entries carry `id`, `present`, `confidence`, `attribution`,
and `evidence[{file, line, snippet}]`.

`id` is one of: `runtime_patch`, `spawns_process`, `listens_on_port`,
`reads_secret_env`, `hooks_system_prompt`, `hooks_api_gate`,
`writes_outside_workspace`, `watches_filesystem`, `network_egress`,
`eval_or_dynamic_code`.

Two ids are narrower than their name suggests, and every finding carries a
`notes` string saying precisely what was matched:

- `writes_outside_workspace` matches path **resolution** outside the workspace
  (`os.homedir()`, `DSH_HOME`, `/etc`, `/usr`). A regex cannot tell resolution
  from a write, and resolving `~/.dsh` is normal and expected in a DSH plugin,
  so the finding does not read as an accusation of writing somewhere it should
  not.
- `eval_or_dynamic_code` matches `eval`, `new Function` and `vm.runIn*`, which
  are frequently bundler output. See attribution below.

### Attribution is the load-bearing field

`attribution` is one of `author-source`, `build-output`, `dependency`,
`unknown`.

A bundler inlines its dependencies, so an `eval` inside a webpack chunk is
usually **not** the plugin author's code. Conflating the two is a published
failure mode of this class of tool (observed deviation ≈ 1/7). Accordingly:

- findings seen only in build output or vendored code are re-attributed, and
  confidence is capped (`high` → `medium`, otherwise `low`);
- when a package ships both `src/` and compiled `lib/`, evidence is shown from
  the **author's source first**, so the sample a reader opens matches the
  attribution;
- `lib/` is **not** treated as build output. It holds compiled output in some
  packages and hand-written JavaScript in others, so it is reported as
  `unknown` rather than guessed at. `dist/`, `build/`, `out/`, `bundled/`,
  `esm/` and `cjs/` are treated as output;
- when the artifact ships **no source at all**, every finding describes build
  output, and the report says so in `limits[]`;
- standalone comment lines are not scanned, so prose mentioning `~/.dsh`
  cannot produce a `writes_outside_workspace` finding. This was a real
  false positive on the first live run.

## Evidence

| Field | Meaning |
|---|---|
| `id` | Referenced by `dimensions[*].evidenceRefs`. Must be unique and must resolve. |
| `kind` | `command`, `log`, `sample`, `static`, or `artifact`. |
| `command`, `exitCode`, `durationMs` | Reproducible invocation and outcome. |
| `excerpt` | **At most 2 KiB**, redacted. Never a full output dump. |
| `excerptBytes`, `truncated` | Declared byte count must match, so a hand-edited excerpt is caught. |
| `sha256` | Content hash where the artifact is published. |

Nothing reaches an excerpt without passing through `packages/report/src/redact.ts`:
credential-shaped strings become `[redacted:<reason>]`, secret environment
*values* are removed while their *names* survive (the name is the finding),
and absolute host paths are rewritten.

## Versioning

`v1` is the field set above. A breaking change to field meaning takes a new
`dsh.plugin.report.v2` identifier; additive optional fields do not. The
validator reports any schema keyword it does not implement, so the schema
cannot silently outgrow the code that checks it.
