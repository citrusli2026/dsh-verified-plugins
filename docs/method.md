# Method of record

How a report is produced, what each dimension proves, and what none of it
proves. This document is normative: a report that contradicts it is wrong even
if its numbers are right.

Read [security.md](security.md) first — the boundary outranks every feature
here — and [schema.md](schema.md) for the field contract.

**Verified against** DSH `0.2.0-rc.2` (`@deepseek-ai/dsh`), with
`dsh-package-manifest`, `dsh-plugin-manager`, `dsh-host-plugin-inventory`,
`dsh-headless` and `dsh-llm-replay` as shipped in that release. DSH is pre-1.0
and its behaviour moves between release candidates, so every report records the
runtime it ran against and its findings are scoped to that version.

---

## 1. What a DSH plugin is

An npm package that declares DSH metadata in `package.json` under `dsh`. There
is no separate plugin format and no registry of its own.

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
| `dsh.manifestVersion` | Manifest format identifier; the declared format is `1`. |
| `dsh.bundle.patch` | One patch path, or an ordered list, each relative to the package root. Applied in order as **one bundle layer**. |
| `dsh.client.platform` | Declares a client (UI) half, e.g. `web`. |
| `engines.dsh` | Author-declared compatible versions as a SemVer range. **Declarative only — not enforced.** |
| `peerDependencies` on `@deepseek-ai/dsh*` | **Enforced.** DSH checks every declared range against the runtime version and *refuses the install* when one does not match. |

`engines.dsh` and `peerDependencies` are different mechanisms with opposite
force, and conflating them is a mistake this document made once. A plugin can
declare an `engines.dsh` range freely; a `peerDependencies` range on a
`@deepseek-ai/dsh*` package is checked and an incompatible one is refused
outright, before anything is downloaded.

A plugin becomes active by *selecting its bundle* in a profile: the profile's
`package.json` carries an ordered `dsh.profile.bundles` list, and the bundle's
patch is applied on top of the profile's configuration layers.

## 2. The seven dimensions

Each dimension is one question. A report answers all seven, and a dimension
that did not run is `skip` — never omitted, never inferred.

### L0 — Qualification

**Question:** is this actually an installable DSH bundle?

Pass requires: `dsh.bundle.patch` is declared, and **every** path it names
exists in the published tarball. Absent `dsh.bundle.patch`, the verdict is
`not-installable` and the subject does not enter the main catalogue.

Not a failure: a missing `dsh.manifestVersion`, or an `engines.dsh` that looks
implausible. Those are notes. Qualification is about installability, not
quality.

### L1 — Install

**Question:** does it install into a clean `DSH_HOME`, and if not, why?

Run `dsh plugin --profile <p> add <spec>` in a throwaway profile inside the
container. Record the exit code, the wall time, and a failure attribution:
registry unreachable, package absent, network failure, pending build scripts,
or peer incompatibility.

**Pending build scripts are a finding, not a chore.** pnpm blocks dependency
build scripts by default and DSH asks the user to approve them; approval
"permits commands with the host user's permissions". The report lists the
requested scripts verbatim and states whether any were approved. A run that
approves them says so explicitly. Third-party subjects are never approved
silently.

DSH's own compatibility check runs *before* pnpm for named packages (a local
path is read from its own `package.json`; a registry spec is resolved and its
declared peers checked), refusing with a compatibility error before anything is
downloaded. Git and tarball specs cannot be pre-checked this way and are judged
after installation.

**Observed in the container**, and the most decision-relevant fact a static scan
cannot produce:

```
dsh: installation rejected: Plugin dsh-find-plugin@0.4.0 is incompatible with
dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-tools":"^0.1.0-rc.6 || ..."}.
dsh: nothing was installed.
```

A subject that qualifies as a bundle and inspects cleanly (L0 pass, L4 pass) can
still be **uninstallable on the pinned runtime** for this reason alone. L1 is
where that surfaces. Granting the exact-version exemption DSH offers would
bypass the check; it is a user decision and the verifier never takes it.

### L2 — Load

**Question:** do the Host and Client halves actually come up?

Pass requires the loader entries declared by the subject's bundle to reach the
`active` fiber phase with no error **and** no unobserved browser half. The verifier mounts its own read-only
inventory fixture alongside the subject. Once the Loader settles, that fixture
reads `pluginManager.listBundles()` for the subject's declared rows and
`pluginManager.listPlugins()` for each row's live `fiberPhase`. The report links
both the boot command and the inventory snapshot. A missing inventory is
`inconclusive`; process lifetime by itself cannot earn a pass.

`pluginInventory/list` gives the phase (`pending`, `loading`, `active`,
`failed`, `unloading`, `null`). It is a point-in-time projection with **no
history**, so an absent row is not evidence of a clean load.

The executor also checks failure-shaped diagnostics — DSH's own *failed to
load*, skipped-bundle and entry-failure reports, `ERR_` codes, stack frames:

- every enabled declared row has a live entry whose fiber is `active`, with no
  failure diagnostic, and the package declares no browser client → pass;
- an absent subject bundle, failed fiber, missing declared row, failure
  diagnostic, or non-zero early exit → fail;
- missing inventory, no directly observable enabled rows, a row still loading
  when the Loader settles, or a declared `dsh.client` whose browser fiber was
  not executed → `inconclusive`.

Two traps this had to learn from real runs, both of which produced **false
failures** before they were fixed: DSH installs a SIGTERM handler that shuts
down gracefully with exit **0**, so hitting the bound is not an early exit; and
plugins log on success (`[dsh-cost-meter] 已加载…`), so the presence of output
is not an error. The 24 historical reports were produced by the older
exit-and-diagnostics inference; see `docs/security.md` § 7. Rows contributed
only through a later agent-preset composition are outside this boot snapshot,
so a subject with no directly observable rows remains `inconclusive`. A browser
client needs a separate isolated browser run; a Host row becoming active does
not prove that its JavaScript registered in a browser.

### L3 — Run

**Question:** does a minimal session complete **without a credential**?

The key-free path is `@deepseek-ai/dsh-llm-replay`, which "short-circuits
`llm/stream` with model chunks reconstructed from a recorded session JSONL
(keyless snapshot tests)".

**The adapter version is derived from the runtime, never resolved by name.**
`@deepseek-ai/dsh-llm-replay` publishes 32 versions and its `latest` tag points
at `0.0.1-rc.1`, whose peers no current runtime can satisfy; the matching
version is on `next`. The verifier installs
`@deepseek-ai/dsh-llm-replay@<discovered runtime>`, so the pairing cannot drift.

The plugin declares no `dsh.bundle`, so installing it does not compose it — DSH
says so explicitly ("installed as a plain dependency, not a profile layer"). It
is mounted as a loader entry through a `--patch` overlay, and the recorded
script is a `ReplayEntry[]` sidecar. Naming the same path for `file` and
`overrideFile` is what lets the sidecar replace a session log entirely, which
matters because obtaining a real recording would need a provider credential.

A report states the probe task **verbatim**, and every L3 pass carries the limit
that it ran against a replayed transcript rather than a provider: it establishes
that a session completes without a credential, not that the subject behaves
correctly against a live model. A real API key is **never** used in CI and never
appears in a report.

### L4 — Capability (static)

**Question:** what can it reach for?

Findings cover: runtime patching, subprocess creation, port listening, reading
credential-shaped environment variables, hooking system-prompt assembly or the
API gate, writing outside the workspace, filesystem watching, network egress,
and eval/dynamic code. Every finding carries `file:line`.

**Capability is not intent.** A finding is never characterised as malicious.
`dsh-xray` and `dsh-poison-guard` do static capability and AST work; this
project does not duplicate them and does not accuse.

The **bundle patch is analysed separately** and is the most DSH-specific
surface here. A `cordis.patch.yml` is not merely configuration: it can disable
host entries the plugin does not own, rewrite their configuration, and carry
`!!js` expressions, which are code evaluated from a configuration file. None of
that appears in a `lib/**` scan.

Attribution rules are in [schema.md](schema.md#attribution-is-the-load-bearing-field).

### L5 — Overhead (dynamic)

**Question:** what does it cost at runtime?

**Differential attribution**: measure a baseline, activate the subject, measure
again. Same container, same order, 3 runs, median. Sample libuv handle count,
watcher count, timer count, file descriptors, RSS, host start-up time, and CPU
time over 60 s idle.

Report only **repeatable, significant** deltas — for example an order-of-
magnitude change in watcher count, RSS growth beyond 100 MB, or start-up
increased by more than 2 s. Otherwise the result is `no-significant-delta`.

**No scores.** Where a difference is not significant, say so. An invented
number is worse than an absent one.

### L6 — Uninstall

**Question:** after removal, is anything left?

Run `dsh plugin remove`, then check the profile for residual patch layers,
orphan child processes, and left-behind files.

## 3. Verdict aggregation

Derived from the dimensions, never authored independently:

```
L0 = fail                    -> not-installable
all seven = pass             -> verified
some pass, not all           -> partial
none pass                    -> inconclusive
```

`tools/`-side enforcement lives in `packages/report/src/validate.ts`, and the
validator **rejects a declared verdict that disagrees with its dimensions**.
One blocked dimension loses `verified`. A static-only run reaches `partial` at
best, because nothing was installed, loaded, or run.

## 4. Evidence and redaction

1. Every conclusion maps to an entry in `evidence[]`. A sentence with nothing
   behind it is deleted or downgraded to `limits`.
2. Evidence is raw and unedited. Redaction is `[redacted:<reason>]` and is
   disclosed. Excerpts are capped at 2 KiB and the declared byte count is
   checked, so a hand-edited excerpt is caught.
3. The environment is recorded exactly: verifier version and commit, DSH
   version, Node version, OS/arch, container image, and time.
4. Never published: full command output, absolute host paths, environment
   variable values, session content, anything from `~/.dsh`.
5. A report is merged only after a **second party reproduces it**.
6. Corrections are **additive**. A wrong finding is superseded by a new dated
   entry and a bumped verdict, never quietly edited. Plugin authors have a
   standing right of reply.
7. `verifier.commit` records the commit that **produced** the report, which is
   the honest thing to record — but note that `main` is squash-merged, so that
   commit is a pull-request head and is **not** an ancestor of `main`. It
   resolves on GitHub and can be checked out, so a reader can still re-run the
   exact code. Pinning reports to a `main` commit requires generating them on
   `main` after the merge; that is an open item, recorded rather than assumed
   away.

## 5. Known limits and open findings

Stated plainly, because the credibility of these reports depends on not
overclaiming.

**F1 — `engines.dsh` is not enforced; `peerDependencies` are.** The manifest
package's own documentation says compatibility "is declarative" and that
installers and loaders "do not enforce `dsh.manifestVersion` or `engines.dsh`".
A plugin can claim any `engines.dsh` range. But a `peerDependencies` range on a
`@deepseek-ai/dsh*` package **is** checked and an incompatible install is
refused. Reports record the *observed* runtime, never treat a declared
`engines.dsh` range as evidence of compatibility, and report the peer verdict
separately because it is enforced.

**F2 — CORRECTED: the official replay plugin is installable; the *default*
resolution is not.** This was recorded as a capability limit and was wrong. See
[docs/evidence/L3.md](evidence/L3.md). `@deepseek-ai/dsh-llm-replay` publishes 32
versions and its `latest` tag points at `0.0.1-rc.1`, whose peers no current
runtime satisfies; `0.2.0-rc.2`, which matches the pinned runtime exactly, is on
the `next` tag and installs cleanly. The lesson generalises into a rule for this
project: **never resolve a plugin by bare name** — read the full version list and
the dist-tags. Retained below as the original (incorrect) reasoning.

`@deepseek-ai/dsh-llm-replay@0.0.1-rc.1` declares
`@deepseek-ai/dsh-compact@^0.0.1-rc.1`, and that package returns 404 on npm.
Its other peers are `^0.0.1-rc.1`, and a caret range on `0.0.x` pins below
`0.0.2`, so `0.2.0-rc.2` cannot satisfy them under any resolution. Consequence:
**L3 is blocked** unless a pinned older runtime is used or a transcript adapter
is written. Relaxing peer resolution was rejected — papering over a mismatch
would make the report lie about installability.

**F3 — static analysis cannot see intent.** Dynamically constructed code is
invisible, and a regex match is not a behaviour. `limits[]` records this in
every report that carries L4 findings.

**F4 — bundle attribution is best-effort.** Code inside a bundle cannot be
reliably split into the author's own code and inlined dependencies. Findings
whose only sightings are build output are labelled as such and downgraded.

**F5 — "loaded" is not "correct".** A fiber reaching `active` proves the plugin
mounted, not that it behaves well. It is a floor, not a certificate.

**F6 — T4/L5 environments are single-point.** A report is scoped to the OS,
architecture, and DSH version recorded in it. Cross-platform behaviour is not
established by one report.

**F7 — no static type gate.** Node 24 strips TypeScript types without checking
them, and installing a compiler in PR CI would either trip the execution policy
or require weakening it. Three defects in this codebase were caught by runtime
schema validation instead of by a type checker. The trade-off is recorded, not
hidden.

**F8 — coverage is a slice.** An unreported plugin is unreported, not
suspicious. There is no ranking, because a ranking is what made the existing
signal untrustworthy.

## 6. False positives and false negatives, by incident

Not hypothetical failure modes — every row is something this verifier actually
did, with how it was found and whether it is fixed. A generic list of "static
analysis has limits" would be worth nothing; this list is the argument that the
tooling is checked against reality rather than against its own fixtures.

### The dangerous class: false passes

A false failure is annoying. A **false pass** is the thing that makes a
verification product worse than useless, because it launders an absence of
evidence into a claim.

| # | What was claimed | Why it was wrong | Found by | Status |
|---|---|---|---|---|
| FP-1 | L6 "removed without residue" | the profile was read from `$DSH_HOME/<name>` instead of `$DSH_HOME/profiles/<name>`, so the directory it cleared was never the one it inspected | first execution run | **fixed** — L6 reports `inconclusive` when the profile cannot be read |
| FP-2 | L1–L6 all `pass` on `@morlay/session-branch` | the package declares no bundle, installs as a plain dependency, is never composed; every dimension measured the subject's absence and called it success | first 4-subject batch | **fixed** — the L0 pre-filter forces `skip` in the merge *and* before a container starts |
| FP-3 | L2 "booted, mounted and stayed alive" | inferred from the *absence* of failure diagnostics, not from a read fiber phase; a plugin can load and misbehave | by construction, on review | **corrected for new Host measurements** — the running plugin manager supplies fiber phases; declared browser clients remain `inconclusive` until an isolated browser observes them. Historical reports are unchanged. |

The pattern in FP-1 and FP-2 is identical: **a pass derived from the absence of
a failure rather than the presence of the subject.** Both were found by running
on real subjects, and neither could have been found by a fixture that the author
also wrote.

### False positives

| # | What was claimed | Why it was wrong | Found by | Status |
|---|---|---|---|---|
| FP-4 | `writes_outside_workspace` in `dsh-find-plugin` | the match was a **doc comment** mentioning `~/.dsh` | first live subject | **fixed** — comment lines are skipped before matching, line numbers preserved |
| FP-5 | L2 failure on `dsh-cost-meter` | the "failure" was the plugin's own success line: `[dsh-cost-meter] 已加载,账本:…` | first execution run | **fixed** — classification keys on failure-shaped diagnostics, never on the presence of output |
| FP-6 | `writes_outside_workspace` as "writes" | the detector matches path **resolution** (`os.homedir()`, `DSH_HOME`), which a regex cannot distinguish from a write; resolving `~/.dsh` is normal | probing six real packages | **fixed** — the label and note now state what actually matched |
| FP-7 | "package manager error" | pnpm's `Ignored build scripts:` list was not parsed, discarding the finding the method says to report | the 20-subject batch | **fixed** — the block is rejoined (pnpm wraps inside a package name) and the four packages are named |
| FP-8 | `dist/` files as build output | the branch existed but returned `unknown`, so the documented behaviour was dead code | probing real packages | **fixed** — the code now matches the documentation |
| FP-9 | L2 failure on `dsh-cost-meter` in the network-denied container | an optional OpenRouter price refresh logged `fetch failed` under the subject's prefix; the classifier treated any subject line with “failed” as a loader failure even though the process stayed alive to the boot bound | isolated CI run 37168938885 | **fixed** — only loader-shaped diagnostics can fail L2; direct fiber-phase observation remains open |

### False negatives

| # | What was missed | Why | Found by | Status |
|---|---|---|---|---|
| FN-1 | every filesystem watcher | `getActiveResourcesInfo()` names the handle `FSEventWrap`, not `FSEvent`; the counter reported **0 watchers on a host holding 7**, missing the exact failure the specification cites | publishing the resource *kinds* rather than only counts | **fixed**, with a mutation-tested acceptance test |
| FN-2 | every libuv handle count | `process.report.getReport().libuv` is an **array**, not an object with `.handle.count`; the metric read as measured while carrying nothing | reading a published report's own numbers | **fixed** |
| FN-3 | every package's `dsh` field | npm's abbreviated metadata strips it, so a survey reported that no package declares a bundle | cross-checking one package against its full document | **avoided by design** — the full packument or the per-version manifest is required |
| FN-4 | any signal in an oversize file | a per-file ceiling skips them | by construction | **disclosed** — skipped files are counted in `limits[]` |

### Limits that are not defects

These cannot be fixed by better tooling, only stated:

1. **Dynamically constructed code is invisible.** `eval` of a string built at
   runtime has no signature to match.
2. **Static analysis cannot prove intent.** A capability finding records what
   code can reach for.
3. **`engines.dsh` is unenforced**, so a declared range is never evidence of
   compatibility — while `peerDependencies` on `@deepseek-ai/dsh*` are enforced
   and produce an install refusal.
4. **L3 runs against a replayed transcript.** It establishes that a session
   completes without a credential, not that the subject behaves correctly
   against a live model.
5. **A subject that loads is not a subject that is correct.** Reaching `active`
   is a floor.
6. **Bundle attribution is best-effort.** Code inside a bundle cannot be
   reliably split between the author and inlined dependencies.

## 7. Cost control

Verification is bounded (see [security.md](security.md) § S4). Exceeding a
ceiling yields `timeout`/`inconclusive`, never a failure verdict — a plugin
that is merely large is not broken. Observed in practice: one subject's 62 MB
artifact took 174 s at 358 KB/s, which would have stalled a run indefinitely
without a fetch budget. Defaults: 120 s and 128 MiB per artifact, overridable
per run, and the **effective** budget is recorded in evidence so a timeout
report is reproducible.
