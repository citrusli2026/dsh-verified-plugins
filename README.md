# dsh-verified-plugins

**Execution-verified plugin reports for DeepSeek Harness** — install it, load it, run it, measure it.
Evidence-linked, reproducible, not another star list.

[Method](docs/method.md) · [Report schema](docs/schema.md) · [Security](docs/security.md) · [Catalog](catalog/index.json)

> **Status: V1 in progress.** L0 (qualification) and L4 (capability) run end to
> end and produce validated `dsh.plugin.report.v1` reports — 3 published so far.
> L1–L3, L5 and L6 require the verification container and are reported as `skip`
> until they run, so a static-only verdict is capped at **`partial`** — by
> design, not by omission. Read [docs/security.md](docs/security.md) first.

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
| **L3** run | Does a minimal session complete **without a credential**? | yes — currently blocked, see below |
| **L4** capability | What can it reach for: runtime patch, subprocess, port, secret env, hooks, out-of-workspace writes? | no |
| **L5** overhead | What does it cost, measured differentially against a baseline? | yes |
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
├── index.json                      # generated, never hand-edited; CI fails if stale
└── npm/
    ├── dsh-find-plugin.json        # partial         — L0 pass, L4: network egress
    ├── morlay__session-branch.json # not-installable — declares no dsh.bundle.patch
    └── dsh-pet.json                # partial         — 62 MB artifact, 98 s to fetch
```

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

## Known limitations

`engines.dsh` is **declarative and unenforced**. The official keyless replay
plugin is **not installable as published**, so L3 is blocked. Static analysis
cannot prove intent or see dynamically constructed code, and bundle attribution
is best-effort. The full list is in [docs/method.md](docs/method.md) § 5.

## License

[MIT](LICENSE). The license covers this repository's method, tooling and
reports. It grants no rights to any third-party plugin, and a report here is
**not** an endorsement, certification, or warranty. DSH itself is a separate
project by DeepSeek; this repo is independent and unaffiliated.
