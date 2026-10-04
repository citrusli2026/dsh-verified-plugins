# dsh-verified-plugins

**Execution-verified plugin reports for DeepSeek Harness** — install it, load it, run it, measure it.
Evidence-linked, reproducible, not another star list.

[Site](https://citrusli2026.github.io/dsh-verified-plugins/) · [Method](docs/method.md) · [Report schema](docs/schema.md) · [Security](docs/security.md) · [Appeals](docs/appeals.md) · [Catalog](catalog/index.json)

> **Status: V0–V6 implemented; network isolation correction awaiting CI acceptance.**
> All seven dimensions have run end to end, batches are supported, reports are published and freshness is tracked —
> **[browse the site](https://citrusli2026.github.io/dsh-verified-plugins/)**.
> 24 reports: 19 `verified`, 4 `partial`, 1 `not-installable`, 4 now **stale**.
> Sessions run against a replayed transcript, never a credential. Dispute a
> report via [docs/appeals.md](docs/appeals.md). Read
> [docs/security.md](docs/security.md) first.

**Security correction:** the 24 historical execution reports were produced in
containers with network access. They remain evidence of the measured dimensions,
but do not satisfy the no-egress condition. The executor now separates package
fetch from network-denied execution; that revised path still needs a Docker CI
acceptance run before new reports are published. See [the incident](docs/security.md#7-historical-network-incident).

---

## Why this exists

Plugin directories tell you a plugin exists, roughly how popular it is, and how
its author describes it. None of that is a measurement. A DSH plugin is not a
sandboxed decoration: its Host code runs **in-process, outside the workspace
sandbox**, and dependency build scripts it triggers run **with your
permissions**. "Trust the author" is therefore a real decision with real
consequences, and a star count is not evidence for it.

**The difference in one sentence: everyone else reads the code; this project
installs it, runs it, and leaves the evidence in the repository.**

## What a report answers

Seven dimensions, each a question. A dimension that did not run is `skip` —
never omitted, never inferred.

| | Question | Needs the container? |
|---|---|---|
| **L0** qualification | Is this actually an installable bundle? | no |
| **L1** install | Does it install into a clean `DSH_HOME`, and if not, why? | yes |
| **L2** load | Do the Host and Client halves actually come up? | yes |
| **L3** run | Does a minimal session complete **without a credential**? | in the container, via the official replay adapter |
| **L4** capability | What can it reach for: runtime patch, subprocess, port, secret env, hooks, out-of-workspace writes? | no |
| **L5** overhead | What does it cost, measured differentially against a baseline? | yes — reports `no-significant-delta` when nothing clears the bar |
| **L6** uninstall | After removal, is anything left? | yes |

### The verdict ladder

```
L0 = fail                    -> not-installable
all seven = pass             -> verified
some pass, not all           -> partial
none pass                    -> inconclusive
```

The verdict is **derived from the dimensions**, and the validator rejects a
declared verdict that disagrees with them. One blocked dimension is enough to
lose `verified`. There is **no score and no ranking** — that is the whole point.

## What is published

`catalog/` holds one JSON report per verified subject plus a generated
`index.json`:

```
catalog/
├── index.json     # generated, never hand-edited; CI fails if it is stale
└── npm/           # one dsh.plugin.report.v1 per verified subject
```

`index.json` carries the current counts and the per-subject dimension statuses.
At the time of writing: **19 `verified`, 4 `partial`, 1 `not-installable`**.


Layout note: the contract proposed `catalog/<owner>/<repo>.json`. The subject is
an npm package, not a git repository — one repository can publish several
packages — so paths are keyed by registry and package name. Reports carry the
repository URL when the package declares one.

## Reproduce a report

```sh
git clone https://github.com/citrusli2026/dsh-verified-plugins && cd dsh-verified-plugins
node packages/cli/src/main.ts static dsh-find-plugin@0.4.0   # re-run one subject
node packages/cli/src/main.ts catalog --check                # validate + index freshness
```

Numbers may differ between runs — a report is a snapshot. **Conclusions must
not.** That is the reproducibility standard this project holds itself to.

## CLI

```sh
node packages/cli/src/main.ts static <spec> [--out <file>]   # L0 + L4; runs no plugin code
node packages/cli/src/main.ts validate <report.json> [...]   # schema + verdict rules
node packages/cli/src/main.ts catalog [--check]              # rebuild / check index freshness
```

Specs are exact: `name@1.2.3`, or a bare name (resolves to latest). Static-only
runs execute no plugin code, which is why they are safe to run anywhere — and
why their verdict is capped at `partial`.

## P0 — security policy

Enforced, not aspirational. Full detail in [docs/security.md](docs/security.md).

1. **Zero secrets.** No repository, environment, or Dependabot secrets, ever.
   ```sh
   bash tools/audit/no-secrets.sh    # expect: 5 checks passed, zero secrets
   ```
2. **Third-party plugin code never runs where credentials exist.** Execution
   happens only in a one-off container, under a maintainer-controlled trigger.
3. **No PR-triggered execution.** A workflow that runs `pnpm add`, `dsh plugin`,
   `docker run`, or the runner package may be triggered *only* by
   `workflow_dispatch`, `schedule`, or `workflow_call` — never by a pull
   request anyone can open. `pull_request_target` and `workflow_run` are banned.
4. **Hard resource ceilings.** Exceeding one yields `timeout`, not a failure.
5. **Verification is not an endorsement.** Every report carries that sentence
   verbatim, and CI rejects a report without it.

`ci.yml` runs on `pull_request` and is strictly static: it builds no container
and executes no plugin. `verify.yml` is the execution tier and is
maintainer-triggered only.

## Local gate

```sh
node --test packages/report/test/*.test.ts packages/collector/test/*.test.ts
node packages/cli/src/main.ts catalog --check
node tools/policy/check-workflows.mjs
node tools/check-hygiene.mjs
bash tools/audit/no-secrets.sh
```

All are dependency-free and run in CI. TypeScript is executed directly by Node
24's type stripping: no build step, no bundler, no runtime dependencies.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agents should read
[AGENTS.md](AGENTS.md) — it carries binding stop conditions.

## Badges

```markdown
[![dsh verified](https://citrusli2026.github.io/dsh-verified-plugins/badge/dsh-cost-meter.svg)](https://citrusli2026.github.io/dsh-verified-plugins/dsh-cost-meter.html)
```

Four states — `verified`, `partial`, `inconclusive`, `not-installable` — and
**no score**. The state says how much ran, not how good a plugin is. Each badge
links to the report, where every conclusion links to the evidence behind it.

## What a batch costs

Measured, not assumed: **~94 s per subject**, and the distribution is flat
because the cost is fixed setup (six sampled boots for L5, a headless profile
and two installs for L3) rather than anything about the subject. A 20-subject
batch is about 31 minutes of CI. `verify_specs` takes a comma-separated list.

## The subject survey

`docs/survey/` answers a question the reports cannot: how many packages claiming
to be DSH plugins actually are. Of the first 250 packages under the npm
`dsh-plugin` keyword, **240 declare an installable bundle but only 130 are
peer-compatible with the pinned runtime** — so 110 would be refused at install.
Registry metadata only; no container, no credential, 26 seconds.

## Freshness and corrections

A report is a snapshot. `catalog/staleness.json` checks each report's version,
runtime and exact package integrity against the registry. The site marks stale
or unknown results. A changed latest tag does not make an older report wrong;
a same-version integrity mismatch needs investigation.

Corrections are additive and mechanically guarded: `supersedes` plus a
`changelog` entry whose description is **computed from both reports**, so a
correction cannot misdescribe itself, and an amendment that drops evidence is
refused. See [docs/appeals.md](docs/appeals.md).

Every failure this verifier has actually had is listed by incident in
[docs/method.md](docs/method.md) § 6 — eight false positives, four false
negatives, and three false passes, two of them fixed.

## Known limitations

`engines.dsh` is **declarative and unenforced**, while `peerDependencies` on
`@deepseek-ai/dsh*` **are** enforced and an incompatible install is refused.
Resolving a plugin by bare name is unsafe — the official replay adapter's
`latest` tag points at an unusable version. Static analysis cannot prove intent
or see dynamically constructed code, and bundle attribution is best-effort. The
full list is in [docs/method.md](docs/method.md) § 5.

## License

[MIT](LICENSE). The license covers this repository's method, tooling and
reports. It grants no rights to any third-party plugin, and a report here is
**not** an endorsement, certification, or warranty. DSH itself is a separate
project by DeepSeek; this repo is independent and unaffiliated.
