# dsh-verified-plugins

**Execution-verified plugin reports for DeepSeek Harness** — install it, load it, run it, measure it.
Evidence-linked, reproducible, not another star list.

[中文](#中文) · [English](#english)

[Site](https://citrusli2026.github.io/dsh-verified-plugins/) · [Method](docs/method.md) · [Report schema](docs/schema.md) · [Security](docs/security.md) · [Appeals](docs/appeals.md) · [Catalog](catalog/index.json)

> **Status: isolated execution accepted in CI; browser-client execution is measured in the approved Chromium harness.**
> All seven dimensions are represented, batches are supported, reports are published and freshness is tracked —
> **[browse the site](https://citrusli2026.github.io/dsh-verified-plugins/)**.
> The published catalogue has 25 reports: 19 `verified`, 5 `partial`, 1 `not-installable`; 12 are now **stale**.
> The site was republished from merged `main` and end-to-end checked: report,
> JSON, badge and catalog endpoints all expose the browser-verified result.
> Sessions run against a replayed transcript, never a credential. Dispute a
> report via [docs/appeals.md](docs/appeals.md). Read
> [docs/security.md](docs/security.md) first.

## 中文

### 这是什么

`dsh-verified-plugins` 是 DeepSeek Harness（DSH）插件的执行级验证报告项目。
它不只是读取 `package.json`，也不按 star 排名；它针对一个精确的
`name@version`，记录插件在受限环境中实际发生了什么：能否安装、Host/Client
是否加载、无凭证会话是否完成、代码具备哪些能力、运行开销如何，以及卸载后是否残留。

一句话：插件目录告诉你“有这个包”，本项目告诉你“这个精确版本实际跑出了什么证据”。

### 为什么有价值

DSH 的 Host 代码会在宿主进程内运行，依赖构建脚本也可能获得宿主权限。因此，
“作者说能用”或“项目 star 很多”不能替代安装前的事实核验。本项目帮助使用者回答：

- 这是可组合的 DSH bundle，还是只被安装成普通依赖？
- 在指定 DSH 版本上能否安装、加载，声明的 Client 是否真的出现在 Web surface？
- 代码能触达子进程、端口、凭证形状的环境变量、运行时 patch 或工作区外路径吗？
- 激活后 watcher、timer、文件描述符、RSS 或启动时间增加了多少？
- `dsh plugin remove` 后是否还留下 profile 层、文件或孤儿进程？

报告发布的是事实、证据和限制，不是安全背书、恶意软件判断、评分或排行榜。

### 报告包含什么

每份报告包含七个维度（L0–L6）、退出码和耗时、脱敏证据、运行环境、精确包完整性、
容器镜像标识，以及可由站点链接到的 evidence。声明 `dsh.client` 的插件只有在真实
浏览器 surface 中看到插件自有 marker 且浏览器错误为零时，L2 才能 `pass`。

当前公开目录是按需验证的切片，不是全集：25 份报告中有 19 份 `verified`、5 份
`partial`、1 份 `not-installable`；13 份 `current`、12 份 `stale`。未报告的插件
就是未报告，不代表可疑。精选 600 插件的夜间全量执行已因成本停止，覆盖范围如实公开。

### 如何使用

1. 在[公开站点](https://citrusli2026.github.io/dsh-verified-plugins/)浏览报告，打开具体
   subject 查看每个结论对应的 evidence；机器读取入口是 [`catalog/index.json`](catalog/index.json)。
2. 本地做安全的静态复核。它只读取 registry 元数据和发布 tarball，不安装或执行插件：

   ```sh
   git clone https://github.com/citrusli2026/dsh-verified-plugins
   cd dsh-verified-plugins
   node packages/cli/src/main.ts static dsh-find-plugin@0.4.0 --out /tmp/dsh-find-plugin.json
   node packages/cli/src/main.ts validate /tmp/dsh-find-plugin.json
   node packages/cli/src/main.ts catalog --check
   ```

   插件 spec 必须是精确的 `name@version`；不要使用裸包名、tag 或 range。
3. 申请真实执行验证时，提交精确版本，由维护者通过 `verify.yml` 的
   `workflow_dispatch` 触发。第三方代码只在一次性、禁网、无凭证、限资源容器中运行；
   不能可靠测量的维度会保持 `inconclusive`、`blocked` 或 `skip`。
4. 重新生成站点或 badge：

   ```sh
   node packages/cli/src/main.ts catalog
   node packages/cli/src/main.ts stale --out catalog/staleness.json
   node packages/cli/src/main.ts site --out /tmp/dsh-site
   node packages/cli/src/main.ts badge catalog/npm/dsh-cost-meter.json
   ```

### 结论怎么读

```text
L0 fail              -> not-installable
七个维度全部 pass    -> verified
部分维度 pass        -> partial
没有可判定的 pass     -> inconclusive
```

`verified` 只表示报告记录的维度在指定环境、指定 DSH 版本和指定时间点得到观察；
它不表示插件安全、正确、兼容所有平台，或适合你的工作区。

### 安全边界

- 执行阶段使用 `--network none`；取包与运行插件分离，禁网执行也不会声称能列出所有被拒绝的目标 host。
- CI 不配置 repository、environment、Dependabot 或云凭证；依赖构建脚本不会被静默批准。
- CPU、内存、进程、磁盘和 wall-clock 均有限；超限是 `timeout`/`inconclusive`，不是插件失败。
- `engines.dsh` 只是声明；`@deepseek-ai/dsh*` peer 兼容性才由 DSH 实际检查。
- L3 使用无凭证 replay transcript，不等于真实 provider 行为测试；L4 的能力信号也不等于意图判断。

详细判定标准见 [docs/method.md](docs/method.md)，安全规则见 [docs/security.md](docs/security.md)，
申诉和加法式修正见 [docs/appeals.md](docs/appeals.md)。

## English

**Security correction:** the 24 historical execution reports were produced in
containers with network access and include container paths; 20 include replay
fixture text. They remain evidence of the measured dimensions, but do not
satisfy the stated no-egress and redaction conditions. The executor now separates package
fetch from network-denied execution and passed Docker CI acceptance. Declared
browser clients are executed only in the approved Chromium harness inside that
same isolated container; a report remains `inconclusive` when the browser
cannot be measured reliably. See [the incident](docs/security.md#7-historical-network-incident)
and [V7 evidence](docs/evidence/V7.md).

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

`catalog/` holds one JSON report per measured subject plus a generated
`index.json`:

```
catalog/
├── index.json     # generated, never hand-edited; CI fails if it is stale
└── npm/           # one dsh.plugin.report.v1 per verified subject
```

`index.json` carries the current counts and the per-subject dimension statuses.
At the time of writing: **19 `verified`, 5 `partial`, 1 `not-installable`**.


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

Specs must be exact: `name@1.2.3`; bare names, tags and ranges are refused. Static-only
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
[docs/method.md](docs/method.md) § 6 — nine false positives, four false
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
