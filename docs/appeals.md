# Appeals and corrections

A verification report is a claim about someone else's work, published under their
name. This document is how such a claim changes — in public, with the change
left visible.

The rule, from [docs/method.md](method.md) § 4: **corrections are additive.** A
wrong finding is superseded by a new dated entry and a changed verdict. Nothing
is quietly edited, and nothing is deleted.

## If you are a plugin author and a report is wrong

Open an issue using the **Report appeal** template. It asks for four things:

1. the report (`reportId`) you are disputing;
2. which dimension you believe is wrong;
3. what you observed instead, with a command that shows it;
4. whether you are a maintainer of the package.

You do not need to be the author. Anyone may dispute a report.

### What happens next

| Step | What it produces |
|---|---|
| 1. Triage | A maintainer determines whether the dispute is about the **method**, the **evidence**, or the **verdict** |
| 2. Re-run | The subject is verified again on the current runtime, in a fresh container, with no credential |
| 3. Amend | If the conclusion changes, the new report is published with `supersedes` set and a `changelog` entry recording what changed and why |
| 4. Close | The issue is linked from the changelog entry |

If the conclusion does **not** change, the issue is closed with the re-run
evidence attached. A refuted appeal is still recorded — "we re-ran it and the
finding held" is information.

### What a maintainer may not do

- Edit a published report in place. Ever. A report is the record of what was run.
- Publish a correction that **drops evidence**. The `amend` command refuses this:
  a new report with fewer evidence entries than the one it supersedes is a
  retraction of the record, not a correction.
- Publish a changelog that misdescribes the change. The `changeDescription` is
  **computed from both reports**, so it cannot disagree with them.
- Soften a verdict without a re-run. A verdict is derived from the dimensions,
  and the validator rejects one that disagrees with them.

## Appealable and not appealable

| Appealable | Not appealable |
|---|---|
| A dimension status that a re-run contradicts | A verdict you dislike that the dimensions support |
| A capability finding that is a false positive | A capability finding you consider harmless — capability is not intent, and the report says so |
| A missing or malformed `file:line` | Being listed as `partial` when a dimension was `blocked` for a reason outside your control |
| An install failure caused by a runtime mismatch we misreported | Our choice of runtime, or the fact that peers are enforced by DSH |
| A `stale` marking that is wrong | A `stale` marking that is right |

The distinction is whether the **method** was misapplied. This project publishes
what was executed and observed; "you ran it wrong" is appealable, "I don't like
what you observed" is not.

## Doing it yourself

Everything is reproducible, and a dispute is stronger with a reproduction:

```sh
git clone https://github.com/citrusli2026/dsh-verified-plugins
cd dsh-verified-plugins

# re-run the static dimensions (L0 + L4) — no container, no credential
node packages/cli/src/main.ts static <name>@<version> --out /tmp/recheck.json

# see exactly what a published report rested on
node packages/cli/src/main.ts validate catalog/npm/<slug>.json
```

The execution dimensions (L1/L2/L3/L5/L6) run in a one-off container:

```sh
gh workflow run verify.yml -f verify_specs='<name>@<version>'
gh run download <run-id> -n exec-reports
```

Every report carries, for each conclusion, the command, its exit code, its
duration and a redacted excerpt — so a reader can disagree with the
**conclusion** while checking the **evidence** it came from.

## Superseding a report

```sh
node packages/cli/src/main.ts amend <new-report.json> \
  --previous <old-report.json> \
  --change "why the conclusion changed" \
  --out catalog/npm/<slug>.json
```

The command refuses when the change is not an amendment (different package,
same report, no reason, fewer evidence entries), and otherwise writes
`supersedes` and appends a changelog entry carrying both your reason and the
computed diff.

## When this project is the thing that was wrong

It has happened. `docs/evidence/L3.md` records a published conclusion that was
**retracted** — L3 was declared blocked on evidence about the wrong version of a
package — and the retraction annotates the original text rather than replacing
it. The same rules apply to this project's own mistakes.

Every phase record under `docs/evidence/` also lists what it did **not** verify
and what it got wrong.
