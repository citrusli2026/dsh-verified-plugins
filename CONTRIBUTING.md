# Contributing

Thanks for helping make plugin claims checkable. This repo publishes a small
number of **execution-verified** reports; the bar is evidence, not volume.

Before contributing, read [security.md](docs/security.md) — the boundary
outranks every feature — then [method.md](docs/method.md) and
[schema.md](docs/schema.md). Agents should also read [AGENTS.md](AGENTS.md).

## Ways to contribute

| Contribution | Notes |
|---|---|
| **A verification report** | The main event. Add one JSON under `catalog/`. |
| **Reproduce an existing report** | Re-run its static command on your machine and report what you got. This is how reports get merged. |
| **Author reply** | Maintainers may append to `changelog[]` and reply in the PR. Findings are never deleted. |
| **Tooling** | Fix or extend `packages/`. Zero new runtime dependencies, please. |
| **Method critique** | Open an issue. If the method is wrong, that outranks any report. |
| **Dispute a report** | Use the *Report appeal* issue template. See [docs/appeals.md](docs/appeals.md) — no need to be the author. |

## What gets accepted

A report is merged when **all** of these hold:

1. It covers an exact `name@version` — never a floating range or a branch.
2. Its verdict matches the dimensions that actually executed. The validator
   rejects a declared verdict that disagrees with its dimensions, so this is
   checked mechanically, not by eye.
3. Every conclusion maps to an entry in the report's `evidence[]`.
4. `node packages/cli/src/main.ts catalog --check` passes, and the index is
   current rather than stale.
5. The unit suite passes: `node --test packages/report/test/*.test.ts
   packages/collector/test/*.test.ts`.
6. **A second party has reproduced it.** A maintainer re-runs the static command
   and records the result on the PR. Self-reported evidence alone is not enough.
7. Any conflict of interest is disclosed.

Rejected or downgraded, usually: verdicts above the executed dimensions,
evidence with nothing behind it, "looks fine to me" analysis, and invented
scores. Where a dimension did not run, it stays `skip`.

## Producing a report

```sh
git clone https://github.com/citrusli2026/dsh-verified-plugins
cd dsh-verified-plugins
git switch -c report/<plugin-name>

node packages/cli/src/main.ts static <name>@<version> --out catalog/npm/<file>.json
node packages/cli/src/main.ts catalog          # rebuild index.json
node --test packages/report/test/*.test.ts packages/collector/test/*.test.ts
```

`static` performs L0 and L4 and executes no plugin code, so it is safe to run
anywhere. It cannot produce a verdict better than `partial`, and it should not
pretend to: L1, L2, L3, L5 and L6 stay `skip` until the verification container
runs them.

### Running the execution dimensions

L1–L3, L5 and L6 run third-party code and therefore only inside the one-off
container, never on your machine if it holds credentials. Two rules:

- **Never run a third-party plugin locally** if the machine has real
  credentials. This workspace does; see [security.md](docs/security.md) § 5.
- **Never approve dependency build scripts to make an install "succeed."**
  Approval permits commands with your own permissions. Record the requested
  scripts as a finding instead.

Recording the container run is what `verify.yml` is for
(`workflow_dispatch`-only). A report that has not run a dimension must say so.

## Report format

Reports are JSON validated against
[`schemas/dsh.plugin.report.v1.schema.json`](schemas/dsh.plugin.report.v1.schema.json).
Field-by-field intent is in [docs/schema.md](docs/schema.md).

The two rules that matter most:

- **The verdict is derived, not authored.** `packages/report` computes it from
  the seven dimensions and rejects a mismatch.
- **`pass` and `fail` must cite evidence.** A decisive status with an empty
  `evidenceRefs` is rejected.

File naming: `catalog/<registry>/<name>.json`, with a scope's `/` written as
`__` (so `@scope/name` becomes `scope__name.json`).

## Review process

`main` is protected: **pull request required, CI must pass, no direct pushes,
no force pushes, linear history**, enforced for administrators too.

If CI is itself broken, a maintainer temporarily relaxes protection, fixes it in
a PR, and restores it; the interruption is recorded in the PR description rather
than done silently.

## Tooling standards

- TypeScript executed directly by **Node 24's type stripping**: no build step,
  no bundler, **zero runtime dependencies**. A supply-chain verification repo
  that grows a dependency tree has lost the argument.
  Constraint worth knowing: strip-only mode rejects TypeScript *parameter
  properties* and `enum`, so declare class fields explicitly.
- New policy rules need a **bad fixture** in `tools/policy/fixtures/` proving
  the rule fires. A guardrail that cannot be shown to trigger is theatre.
- GitHub Actions are pinned to full 40-character commit SHAs; CI enforces it.

Run the whole gate before pushing — the list is in the [README](README.md#local-gate).

## Right of reply and corrections

Plugin authors may always reply, and a disputed finding is corrected in public:
a new entry in `changelog[]`, a changed verdict, and the reason. Findings are
never quietly deleted or rewritten, and the `amend` command **refuses** an
amendment that drops evidence or that cannot be validated.

If you believe a report about your plugin is wrong, open an appeal with
counter-evidence — that is a contribution. The full process, including what is
*not* appealable, is in [docs/appeals.md](docs/appeals.md).

## Conduct

Be straight about uncertainty and generous about mistakes. Attack methods, not
people. Bad-faith verdict inflation, undisclosed conflicts, and presenting a
report as a security audit are grounds for removal.

## License

Contributions are accepted under [MIT](LICENSE). You confirm you have the right
to submit the evidence you commit, and that it contains no credentials.
