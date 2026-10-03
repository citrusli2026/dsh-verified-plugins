<!--
  Pull request template. The evidence checklist is the point: a report is only
  as good as the artifacts behind its claims. See docs/method.md.
-->

## What this PR does

<!-- One or two sentences. -->

## Type

- [ ] New verification report (`reports/<plugin>/`)
- [ ] Reproduced / added an environment to an existing report
- [ ] Author reply
- [ ] Tooling or policy change
- [ ] Method or documentation change

## If this is a verification report

- [ ] Subject is an **exact `name@version`**, not a range, tag, or branch.
- [ ] Verdict matches the tiers that actually executed (`docs/method.md` § 4).
- [ ] Every claim maps to a file under `reports/<plugin>/evidence/`.
- [ ] Evidence is raw and unedited; any redaction uses `[redacted:<reason>]` and is disclosed.
- [ ] `repro.sh` regenerates the evidence from a clean checkout with **no credentials**.
- [ ] `repro.sh` redirects `DSH_HOME` to a throwaway profile — nothing touched the reporter's live profile.
- [ ] DSH runtime version, Node version, OS/arch, and report commit are recorded.
- [ ] Dependency build scripts requested are listed verbatim, and **whether any were approved** is stated.
- [ ] `engines.dsh` is reported as an author declaration, not as proof of compatibility.
- [ ] "What this report does not establish" is filled in and specific.
- [ ] Conflicts of interest disclosed (`author_disclosure`).

## P0 confirmation

- [ ] This PR adds **no secrets**, variables, or credentials of any kind.
- [ ] This PR does not make any workflow execute third-party plugin code outside `verify.yml`.
- [ ] Any action added is pinned to a full 40-character commit SHA.
- [ ] I have not weakened or bypassed `tools/policy/check-workflows.mjs`.

## Checks

```sh
node tools/policy/check-workflows.mjs
node tools/check-hygiene.mjs
node tools/validate-reports.mjs
```

- [ ] All three pass locally.

## Reviewer note

A report is merged only after a **second party reproduces it**. Reviewer: state
the command you ran and what you observed, or ask for it.
