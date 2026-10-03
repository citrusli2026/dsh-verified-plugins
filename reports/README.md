# reports/

One directory per verified `name@version`. Nothing here yet — see the
[root README](../README.md) for how to add the first one.

```
reports/<plugin-name>/
├── report.md      # front-matter validated by CI against schemas/report.schema.json
├── evidence/      # raw, unedited command output — committed
└── repro.sh       # regenerates every file in evidence/, with no credentials
```

## Rules

- **`report.md` is required**; the directory name is a slug of the package name
  (scopes flattened, e.g. `@scope/name` → `scope__name`). The authoritative
  identity is the `plugin` and `version` fields in the front-matter.
- **`evidence/` is raw.** No trimming, reordering, or reflowing. Redact with
  `[redacted:<reason>]` and disclose it in the report.
- **`repro.sh` must regenerate the evidence** from a clean checkout with no
  credentials, using a throwaway `DSH_HOME`. A report whose evidence cannot be
  regenerated is `BLOCKED`.
- **One report per plugin directory**, updated in place as new versions are
  verified; superseded verdicts move to an "Earlier versions" section rather
  than being deleted.
- `_TEMPLATE.md` and this README are not reports and are skipped by the
  validator.

Validate locally before opening a PR:

```sh
node tools/validate-reports.mjs
```
