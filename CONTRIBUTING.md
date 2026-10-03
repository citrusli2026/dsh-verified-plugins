# Contributing

Thanks for helping make plugin claims checkable. This repo publishes a small
number of **execution-verified** reports; the bar is evidence, not volume.

Before contributing, read [docs/method.md](docs/method.md) — it is the norm.
Agents should also read [AGENTS.md](AGENTS.md).

## Ways to contribute

| Contribution | Notes |
|---|---|
| **A verification report** | The main event. Add `reports/<plugin-name>/`. |
| **Reproduce an existing report** | Comment on its PR or open a PR adding your environment to `report.md`. This is how reports get merged. |
| **Author reply** | If you maintain a plugin, append a dated `## Author reply` section. Findings are never deleted. |
| **Tooling** | Fix or extend `tools/`. Zero new dependencies, please. |
| **Method critique** | Open an issue. If the method is wrong, that outranks any report. |

## What gets accepted

A report is merged when **all** of these hold:

1. It covers an exact `name@version` — never a floating range or a branch.
2. Its verdict matches the tiers that actually executed
   ([rubric](docs/method.md#4-verdict-rubric)). Overclaiming is the one
   unrecoverable error.
3. Every claim maps to a file under `reports/<plugin>/evidence/`.
4. `repro.sh` regenerates that evidence from a clean checkout, with no
   credentials, using a throwaway profile.
5. `node tools/validate-reports.mjs` and `node tools/policy/check-workflows.mjs`
   pass.
6. **A second party has reproduced it.** A maintainer re-runs `repro.sh` and
   records the result on the PR. Self-reported evidence alone is not enough.
7. Any conflict of interest is disclosed (`author_disclosure: "true"`).

Rejected or downgraded, usually: verdicts above the executed tier, unedited
claims with no artifact, "looks fine to me" analysis, or reports that needed a
version exemption without saying so.

## Submitting a new report

```sh
git clone https://github.com/citrusli2026/dsh-verified-plugins
cd dsh-verified-plugins
git switch -c report/<plugin-name>

mkdir -p reports/<plugin-name>/evidence
cp reports/_TEMPLATE.md reports/<plugin-name>/report.md
# run the tiers you intend to claim, saving raw output into evidence/
# write repro.sh so the evidence can be regenerated

node tools/validate-reports.mjs
node tools/policy/check-workflows.mjs
git add reports/<plugin-name> && git commit -m "report: <plugin>@<version> (<verdict>)"
gh pr create --fill
```

### Running tiers safely

T1–T3 run package code and configuration patches. Two rules:

- **Use a throwaway profile.** Point `DSH_HOME` at a temp directory and never
  run the tiers against your live profile — installs mutate the profile,
  rewrite `package.json` and the lockfile, and may run dependency build scripts.
- **Never approve dependency build scripts to make an install "succeed".**
  Approval permits commands with your own permissions. Record the requested
  scripts as a finding instead, and mark the tier accordingly.

T4 calls a model. Run it yourself, with your own credential, and commit the
output — never the key. T4 never runs in this repo's CI.

## Report format

Front-matter is a **flat** YAML mapping — no nesting — and is validated against
[`schemas/report.schema.json`](schemas/report.schema.json):

```yaml
---
plugin: "@scope/name"
version: "1.2.3"
source: "https://www.npmjs.com/package/@scope/name"
integrity: "sha512-..."
dsh_runtime: "0.2.0-rc.2"
node: "24.15.0"
os: "macos-15-arm64"
date: "2026-10-03"
verdict: "L2"
t0_static: "pass"
t1_install: "pass"
t2_load: "pass"
t3_measure: "skip"
t4_behaviour: "skip"
reporter: "your-github-handle"
author_disclosure: "false"
---
```

Tier fields take `pass`, `fail`, `skip`, or `blocked`. See the
[template](reports/_TEMPLATE.md) for the body sections.

## Review process

`main` is protected: **pull request required, CI must pass, no direct pushes,
no force pushes, linear history**. Expect review to ask for the raw log behind a
claim. That is the point of the repo.

Branch protection is enforced for administrators too. If CI is itself broken, a
maintainer temporarily relaxes protection, fixes it in a PR, and restores it;
the interruption is recorded in the PR description rather than done silently.

## Tooling standards

- Plain Node ESM, Node >= 24, **zero runtime dependencies**. A supply-chain
  verification repo that grows a dependency tree has lost the argument.
- New policy rules need a **bad fixture** in `tools/policy/fixtures/` proving
  the rule fires. A guardrail that cannot be shown to trigger is theatre.
- GitHub Actions are pinned to full 40-character commit SHAs. CI enforces this.

Run the full gate before pushing:

```sh
node tools/policy/check-workflows.mjs
node tools/validate-reports.mjs
```

## Right of reply and corrections

Plugin authors may always append a reply, and a disputed finding is corrected in
public: a new dated section, a bumped verdict, and the reason. Findings are
never quietly deleted or rewritten. If you believe a report about your plugin is
wrong, open an issue with the counter-evidence — that is a contribution.

## Conduct

Be straight about uncertainty and generous about mistakes. Attack methods, not
people. Bad-faith verdict inflation, undisclosed conflicts, and misrepresenting
a report as a security audit are grounds for removal.

## License

Contributions are accepted under [MIT](LICENSE). You confirm you have the right
to submit the evidence you commit, and that it contains no credentials.
