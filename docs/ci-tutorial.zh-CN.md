# CI 教程：把 testid-universal 接进自动化测试

> 本文是**操作层**教程（从 0 到跑通）。设计依据见
> `docs/superpowers/specs/2026-06-11-ci-integration-design.md`，配方与 Agent 协议见
> `USAGE.zh-CN.md` §1.6 / §1.9。本文改编自下游使用者在真实项目（React 18 + Vite + Vitest）
> 上实测写成的教程；§7 的每个场景都在 `fast-team`（Vue）上重新跑过。
>
> 可直接复制的文件：[`examples/ci/ci-testid.mjs`](../examples/ci/ci-testid.mjs)（路由脚本）与
> [`examples/ci/testid.yml`](../examples/ci/testid.yml)（GitHub Actions 外壳）。

## 0. 这套管线做什么

每次改动后，**精确算出哪些 e2e 测试必须跑**——而不是盲目全量或盲目不跑。

- 元素删除 / 改名 → 生成的常量消失 → **编译失败**（fail-closed，不靠人读 diff）。
- handler 函数体，或它直接用到的定义（一层：辅助函数、import 的函数、store/hook 成员、注入
  服务的方法）变了 → 路由到**精确的测试用例**。
- 再往外的代码（第三层及以上、动态分发）→ **点名兜底**，绝不报成「无需重测」。
- 路由无法担保的一切 → **全量**。选择性执行是优化，不是替代。

## 1. 前置：注册表和常量已提交

CI 不是起点，先把本地闭环跑通（`USAGE.zh-CN.md` §1.1–1.5）：

```bash
npx testid tag src --ext .vue --registry .testids             # 打标 + 注册表
npx testid gen-constants --registry .testids --out e2e/testids.generated.ts
```

三条规则：

1. 测试从生成的模块 import `testIds`——**禁止硬编码 id 字符串**（id 被删必须在编译期失败）。
2. **注册表（`.testids/`）和常量模块都提交进 git。** CI 的基线就是 merge-base 处提交的注册表版本。
3. **升级 testid-universal 之后，先跑一次 `tag` 并提交注册表。** 新信号（如一层 `dep_defs`）
   只有在基线里也存在时才会比较——这保证了升级零噪音，也意味着陈旧的基线无法路由它们。
   实测：基线是升级前的版本时，改 store action 什么都没路由；提交一次 `tag` 之后，同样的改动
   精确路由到两个 claim 用例。

常量格式由 `--out` 决定：`.js/.mjs/.cjs/.jsx` 产出纯 JS（JSDoc `@type {const}`），`.ts`
产出 `as const`（`--lang ts|js` 可覆盖）。

## 2. 五段管线

| 段 | 工具 | 闸门 |
| --- | --- | --- |
| ① 打标闸门 | `testid tag … --check` | 有未打标元素 → exit 1；零写盘 |
| ② 常量闸门 | `gen-constants --check` + `tsc` | 常量落后 → exit 1；id 被删 → 编译错 |
| ③ 路由 | `scripts/ci-testid.mjs`（或 `testid affected`） | `mode=selective\|full\|none` + `retest.txt` |
| ④ 选择性执行 | 用 `retest.txt` 驱动 runner | 仅当 `mode=selective` |
| ⑤ 全量兜底 | 合并后 + 夜间 | ③ 看不见的一切由它兜住 |

### 2.1 ① 打标闸门

```bash
npx testid tag src --ext .vue --registry .testids --check
```

使用内存注册表，不写任何文件；已打标的代码重新序列化逐字节一致 → exit 0。PR 新增了元素却
没跑 `tag`，会在这里失败。

### 2.2 ② 常量 fail-closed

```bash
npx testid gen-constants --registry .testids --out e2e/testids.generated.ts --check
npx tsc --noEmit      # 或你的构建：被删 id 的常量消失 -> 测试编译失败
```

### 2.3 ③ 路由

**推荐：参考脚本，merge-base 模式。**

```bash
node scripts/ci-testid.mjs --src src --ext .vue --registry .testids --tests e2e --base origin/main
```

它做的事（全程不写你的源码，也不写已提交的注册表）：

1. 把 `.testids/` 复制到临时目录，把当前源码打标进这份副本 → `to`；
2. `from` = `git merge-base origin/main HEAD` 处提交的注册表版本；
3. 对 `from → to` 做 diff 并路由到测试用例（报告里会点出锚点漂移与 UNRESOLVED import）；
4. **诚实规则**——git diff 触及打标集合之外的源码文件时，切换为 `mode=full`（见 §3）；
5. 仅在未追踪代码**可能**变了的地方加入**超深度兜底**测试（元素自身文件改了，或在
   `--trust-deps` 下打标集合外的代码改了）；
6. 写出 `retest.txt`、`testid-report.md` 和 `mode=…`（也写入 `$GITHUB_OUTPUT` 与 job summary）。

退出码：0 已路由，1 源码需要打标 / 没有注册表，2 参数错误。选项：`--since FILE`（用 green
锚点代替 `--base`）、`--adapter`、`--trust-deps`、`--no-limited`、`--full`。

因为 `to` 是在 CI 里由 PR 的源码算出来的，PR **不需要**为了路由正确而提交注册表推进——只需要
提交 `tag --check` 要求的那些 id。

**备选：只用 CLI（green 锚点模式）。** 无脚本、无 git 逻辑：

```bash
npx testid mark-green --registry .testids --since .testids-green.json   # 一次全绿之后
npx testid tag src --ext .vue --registry .testids                         # 改动之后
npx testid affected --since .testids-green.json --tests e2e --registry .testids \
  --out-list retest.txt --include-limited
```

`--out-list` 只写 `re-test` 的文件；`--include-limited` 会加入**全部**超深度兜底测试（CLI
没有 git diff 可以缩小范围）。CLI **不**执行「打标集合之外」规则——需要你的 CI 来做（§3）。
如果 CI 依赖 `.testids-green.json`，要把它提交进仓库；不提交的锚点会随 runner 一起消失。

### 2.4 ④ 选择性执行——防住空列表

```bash
npx playwright test $(cat retest.txt)    # retest.txt 为空时有坑
```

列表为空时，`playwright test` / `vitest run` 拿不到过滤参数，会跑**整个套件**。方向上安全，
但它悄悄让路由失效，也掩盖了「没有受影响的测试」这个答案。应该按 mode 分支（workflow 里就是这样做的）：

```bash
case "$MODE" in
  selective) npx playwright test $(cat retest.txt) ;;
  full)      npx playwright test ;;
  none)      echo "no test affected" ;;
esac
```

### 2.5 ⑤ 全量兜底

main 合并后和夜间，永远要跑。它兜住路由按设计看不见的部分：第三层及以上、裸包、动态分发、
不在 `tag` 范围内的文件、环境漂移。

## 3. 诚实规则（别漏）

依赖追踪止于 handler 之后一层。两条可机器检查的规则让选择性执行保持诚实（spec §4）：

1. **git diff 触及打标集合之外的源码文件 → 全量。** 引擎不实现这条，由你的 CI 实现；参考
   脚本默认就会这样做。
2. **可能变了的未追踪依赖 → 跑它们的测试。** `tag` 会把它们打印为「BEYOND tracking depth」，
   注册表以 `dep_limited` 保存，`affected` 末尾附「⚠ Beyond tracking depth」小节，例如
   `| taskdetailview__button--detail-claim | claim>tasks.claimTask>this.persist | task-detail.spec.ts |`。

`--trust-deps` 放宽第 1 条：打标集合外的改动（store、service）不再升级全量，而是经一层
`dep_defs` 路由，再加上**全部**超深度兜底测试。等兜底列表相对整个套件足够小时再用；在小应用上
它反正会趋近全量。误差方向永远是多测。

## 4. 分支上的注册表纪律

注册表版本是线性整数；两个分支都铸出 `v8` 会在 git 里冲突。

- PR 在 CI 里只跑 `tag --check`（不写）。只在必要时（新元素）本地跑 `tag`，id 和注册表一起提交。
- 版本冲突时：rebase 后重跑 `tag`（sticky id 保证 id 不变，只重做版本号）。
- 在 main 合并后推进权威注册表（`examples/ci/testid.yml` 里的可选步骤，需要 `contents: write`）。
  不做也安全：陈旧的基线会把之前合并的改动再报一次（多路由），绝不会漏掉 PR 自己的改动。
- 并发：`JsonFileStorage` 对同一台机器上的并行进程安全（锁文件 + 原子写 + CAS）；多机共享的
  服务用 `PostgresStorage`（`serve` 从 `DATABASE_URL` 自动切换）。

## 5. GitHub Actions

把 [`examples/ci/testid.yml`](../examples/ci/testid.yml) 复制到 `.github/workflows/`，
`examples/ci/ci-testid.mjs` 复制到 `scripts/`，再调整 `env:`（`SRC`、`EXT`、`TESTS`、
`CONSTANTS`）和测试命令。结构：

- `selective`（pull_request）：`fetch-depth: 0` checkout → ① → ② → ③ 路由（`id: route`）→
  ④ 按 `steps.route.outputs.mode` 分支。
- `full`（push 到 main + 夜间 cron）：闸门 + 全量（+ 可选的注册表推进）。

GitLab / CircleCI / pre-push hook：同一个脚本，换一个触发外壳即可。

## 6. 库 API 路线（自定义路由）

脚本用到的都是 `testid-universal` 的公开 API：各 adapter、`LocalTransport`、`JsonFileStorage`、
`runPipeline`、`affectedTestCases`、`buildTestCaseMapForIds`、`depthLimitedTests`、`retestFiles`。
注意：transport 只暴露 `latest()` / `diff()`，`loadVersion()` 在 storage 上。`affected` 从 diff
自身的 id 集合建映射（`buildTestMapForIds`），所以经 `HttpTransport` 也能用。

## 7. 实测场景（fast-team，参考脚本，`--base main`）

| 改动 | 结果 |
| --- | --- |
| 无改动 | `mode=none` |
| `TaskDetailView.vue` 里 `claim()` 的函数体 | `selective`：只有 `task-detail.spec.ts` |
| store action `claimTask`（打标集合外的文件） | `full`（诚实规则） |
| 同上，`--trust-deps --no-limited` | `selective`：两个 claim 用例 + `search filters the board`（该输入框绑定了整个 store——已记录的多报） |
| 第三层 `persist()`，`--trust-deps` | 加入兜底测试 |
| 新增未打标的 `<button>` | exit 1："1 file(s) need tagging" |

每次运行后工作区都保持干净。

## 8. 验收清单

- [ ] `tag --check` 在已打标仓库 exit 0，新增未打标元素后 exit 1。
- [ ] `gen-constants --check` 在常量落后时 exit 1；删除一个 id 后 `tsc` 失败。
- [ ] 改 handler 函数体会路由到对应用例（`testid diff` 显示 `symbol:<name>`）。
- [ ] 改一层依赖，`testid diff` 显示 `dep:<handler>><ref>`（需先完成 §1 的基线）。
- [ ] 改第三层代码不产生 diff 条目，但其测试出现在兜底小节。
- [ ] sticky id 所在元素的 identity 变了，报告锚点漂移。
- [ ] `retest.txt` 为空时不会意外跑全量（按 mode 分支）。
- [ ] 合并后与夜间的全量运行为绿。

## 9. 参考

- 设计：`docs/superpowers/specs/2026-06-11-ci-integration-design.md`
- 一层依赖追踪：`docs/superpowers/specs/2026-11-17-one-hop-dep-tracking.md`
- 配方 / Agent 协议：`USAGE.zh-CN.md` §1.6、§1.9
