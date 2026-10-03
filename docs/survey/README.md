# Survey: how many "DSH plugins" are actually installable?

The batch work has a by-product the specification asks for: publish how many of
the packages claiming to be DSH plugins actually are. This directory holds the
raw output; this file explains what it does and does not establish.

## Method

Registry metadata only. **No container, no plugin execution, no credential.**

For each package the survey reads `GET /{name}/latest` — one version's manifest —
and records whether it declares `dsh.bundle.patch`, what `dsh.client.platform` it
claims, and its `peerDependencies` on `@deepseek-ai/dsh*`. Peer ranges are then
evaluated against a pinned runtime version, because DSH **refuses an install**
whose declared peers the runtime does not satisfy.

### Two traps this endpoint choice avoids

| Source | Size for one subject | Carries `dsh`? |
|---|---|---|
| `GET /{name}` (full packument) | 85 KB | yes — took **>12 minutes** for 250 packages |
| `GET /{name}/latest` (one manifest) | 3.7 KB | yes — takes **26 seconds** for 250 |
| abbreviated metadata | smallest | **no** — strips `dsh` entirely |

The abbreviated form is the dangerous one: it makes every package look like it
declares no bundle. That trap produced a wrong survey in this project once
already (`docs/evidence/V1.md` § F-V1-4), and the survey code calls it out where
someone might reach for it.

## Results

`npm-dsh-plugin-250.json` — the first 250 packages returned by the npm search
API for `keywords:dsh-plugin`, evaluated against DSH `0.2.0-rc.2`, generated
2026-10-04.

| | Count | Of reachable |
|---|---|---|
| Reachable | 250 | 100% |
| **Declares an installable bundle** | **240** | **96%** |
| Declares no bundle | 10 | 4% |
| — of the 240 — declares no `dsh-*` peers at all | 65 | 27% |
| — **peer-compatible with `0.2.0-rc.2`** | **130** | **54%** |
| — **would be refused at install** | **110** | **46%** |

All 110 incompatibilities are **genuinely unsatisfied** ranges. Zero were
"range grammar this evaluator does not understand", which matters: if that
number had been large, the figure would have been an artefact of the tool rather
than a fact about the ecosystem.

### What this says

The interesting number is not 96%. It is the gap between 240 and 130.

**A package that declares a bundle is not a package you can install.** Nearly
half of this sample declares an installable bundle and is still refused by the
runtime pinned here, because its `peerDependencies` were written against an
older generation of DSH.

This also corrects an assumption carried in from elsewhere. The GitHub
`dsh-plugin` topic is described as very noisy — mostly repositories that are not
plugins. The **npm keyword set is the opposite**: 96% of packages that adopt the
keyword really do declare a bundle. The noise is in the topic, not in the
registry. The two are not interchangeable sources, and a subject list built from
one is not a subject list built from the other.

## What this does NOT establish

1. **Declaring is not shipping.** The survey cannot confirm that the declared
   patch files exist in the published tarball; that needs L0 proper, which reads
   the artifact. A package here is "declares an installable bundle", not
   "is verified".
2. **Peer compatibility is not loadability.** Satisfying every peer range means
   DSH will not *refuse* the install. Whether it then loads is L1/L2's question.
3. **The sample is the first page, ranked by npm's own relevance** — not the
   whole ecosystem (6,730 packages matched the keyword) and not a quality
   ordering.
4. **One runtime, one moment.** Every peer verdict is relative to `0.2.0-rc.2`.
   A package refused here may be perfectly installable on the runtime it was
   written for, and the survey records the declared ranges so a reader can check.

## Reproduce

```sh
node packages/cli/src/main.ts survey \
  --query 'keywords:dsh-plugin' --limit 250 --runtime 0.2.0-rc.2 \
  --out docs/survey/npm-dsh-plugin-250.json
```

Numbers will move as packages are republished; the method is the stable part.
