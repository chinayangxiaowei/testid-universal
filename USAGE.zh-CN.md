# 使用手册

[English](./USAGE.md) | 简体中文

`testid-universal` 的实操手册。概念与原理见 [README](./README.zh-CN.md);本文是手把手
路径 + 完整参考表。教程中的每一步都在真实 Vue 应用 + 真实 Playwright 套件上执行验证过
(见 `docs/findings/`)。

---

## 1. 教程:从零到一套会自我维护的 e2e

以下假设 Vue 3 项目 + Playwright;HTML adapter 用法相同,换 `--ext .html` 即可。

### 1.1 安装

```bash
npm i -D testid-universal @vue/compiler-sfc   # 可选 peer,仅 Vue 项目需要
npm i -D @angular/compiler                    # 可选 peer,仅 Angular 项目需要
npm i -D @babel/parser                        # 可选 peer,仅 React 项目需要
```

### 1.2 首次打标

```bash
npx testid tag src --ext .vue --registry .testids
```

- 每个可打标元素的 `data-testid` 会写进源码(把这些改动和 `.testids/` 目录**都提交进
  git**——它们就是设计为进版本库的)。
- **认真读警告**,它们是卫生待办清单,不是噪音:
  - `unstable-identity` → 该元素的 id 派生自易变文案;若测试要定位它,加 `data-tid`。
  - `loop-multiplicity` → 该元素渲染 N 次共享一个 id;改用按项绑定
    (`:data-testid="'row-' + item.id"`)。tagger 会尊重绑定,绝不在旁边再铸静态 id。
- 重复运行**幂等且 sticky**:已打标文件不重写,已写入的 id 永不重算。

### 1.3 生成常量并编写测试

```bash
npx testid gen-constants --registry .testids --out e2e/testids.generated.ts
```

```ts
// e2e/login.spec.ts
import { test, expect } from '@playwright/test';
import { testIds } from './testids.generated';

test('login form interaction', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId(testIds.loginInputEmail).fill('alice@example.com');
  await expect(page.getByTestId(testIds.loginInputEmail)).toHaveValue('alice@example.com');
  await page.getByTestId(testIds.loginButtonOnsubmit).click();
});
```

让后续闭环成立的几条规则:
- **永远 import 常量,绝不硬编码 id 字符串。**
- 循环内按项定位用绑定 id 拼接:`getByTestId('row-' + user.id)`(动态 id 不在注册表内,
  由周期性全量覆盖)。
- 提交 `testids.generated.ts`;注册表版本前进后重新生成。

### 1.4 维护循环(每次代码变更后)

```bash
npx testid tag src --ext .vue --registry .testids        # 新版本,id sticky 不动
npx testid affected <旧版本> <新版本> --tests e2e --out-list retest.txt --registry .testids
npx playwright test $(cat retest.txt)                    # 选择性重跑
```

报告的含义:

| 动作 | 触发条件 | 你要做的 |
| --- | --- | --- |
| `re-test` | 标记字段变了(`text`、`placeholder`……)**或**引用符号的定义变了(`symbol:onSubmit`) | 重跑清单内用例;只有断言了变更内容时才需要改断言 |
| `retire` | id 消失了 | 该用例反正已编译失败(见 1.5);删除或改指向 |
| `write-new` | 新 id 出现且无用例引用 | 写新用例(或有意识地跳过) |

只改 handler 函数体(模板未动)同样产生 `re-test`,原因标注 `symbol:<name>`——
id 全程冻结,行为变更不漏。

### 1.5 fail-closed 的实际样子

删除元素(或强制重铸)后,重新生成常量并 typecheck:

```bash
npx testid gen-constants --registry .testids --out e2e/testids.generated.ts
npx tsc --noEmit          # e2e/login.spec.ts: TS2339 Property 'loginLinkForgot' does not exist
```

过期引用是**编译错误**,绝不是静默的运行时找不到。下线该用例,套件恢复全绿。

### 1.6 CI 闸门(配方)

```bash
npx testid tag src --ext .vue --check      # 需要打标则 exit 1;什么都不写
```

再加一道覆盖率闸门,防止"diff 全绿"掩盖未被测试的表面:`testid coverage --tests e2e
--min 60` 在交互元素覆盖率低于阈值时让 CI 失败(`tag` 也会逐次打印打标统计:
多少解析到的元素根本没拿到 id)。
五段管线(check → 常量+tsc → affected → 选择性执行 → 全量兜底)按
`docs/superpowers/specs/2026-06-11-ci-integration-design.md` 搭建。两条诚实规则:
git diff 超出被打标组件文件范围时放弃选择性、升级全量;保留夜间/合并后全量
(传递性代码变更对注册表不可见,这是设计边界)。

### 1.7 覆盖率驱动循环(经实战验证的方法论)

不要凭直觉决定测什么——让工具输出驱动工作,每响应一个信号提交一次:

1. **基线**:`tag`(读统计:解析面里有多少元素根本没有 id)、`coverage`(⚠表**就是**
   工作单)、带 recorder 真跑一轮 + `coverage --runtime`(被引用的 id 真被行使了吗?
   存在哪些动态 id?)。
2. **响应最高优先级的 ⚠ 簇**:写 spec → 重跑 → 重测量。循环。
3. **棘轮化闸门**:把 `coverage --min <已达成水位>` 冻进 CI,覆盖率只升不降;
   延后的簇要显式记录,绝不静默丢弃。

已在真实应用上端到端验证(三个工作单驱动的 commit 把交互覆盖率从 8.8% 提到 22.8%,
全程 `referenced-but-never-exercised` 保持 0)——完整轨迹见
`docs/findings/2026-06-12-coverage-poc-survey.md` 与演示项目的 `COVERAGE-LOG.md`。

### 1.8 完整测试金字塔(视觉 / 响应式 / 可访问性)

testid 循环只是**其中一层**:它保证定位符稳定并路由重测,但**不**告诉你 UI 好不好看、
能否扛住手机视口、是否可访问。完整的前端测试在同一次 Playwright 运行上再加三层——而且
它们复用本工具生成的 testid 作为稳定锚点:

1. **视觉回归** —— Playwright `toHaveScreenshot()` baseline 入库。两种粒度:整页(逮
   布局崩坏)+ 通过 `getByTestId(testIds.x)` 的**组件级**(逮局部样式变化)。生成的常量
   锚定组件截图,功能测试与视觉测试瞄准同一批元素。
2. **响应式** —— `desktop` 与 `mobile` 两个 Playwright project(覆写 `viewport`),每个
   功能 spec 在两个视口都跑,断点崩了 CI 就红。
3. **可访问性** —— `@axe-core/playwright`,WCAG 2A/2AA,`serious`/`critical` 即失败。

```ts
// playwright.config.ts
expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
projects: [
  { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  { name: 'mobile',  use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true } },
],
```
```ts
// visual.spec.ts —— 布局 + 样式保真两种粒度
await expect(page).toHaveScreenshot('login.png', { fullPage: true });               // 布局
await expect(page.getByTestId(testIds.loginSubmit)).toHaveScreenshot('cta.png');    // 样式
// a11y.spec.ts
const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
expect(r.violations.filter((v) => ['serious','critical'].includes(v.impact!))).toEqual([]);
```

在真实 Vue 应用(Fast Team,见其 `DEV-LOG.md`)上 dogfooding 时验证的两条标定教训:

- **整页 `maxDiffPixelRatio` 会稀释局部变化。** 一次主强调色变更只占整页不到 2%,被
  0.02 阈值漏掉;**组件级**截图(强调色占该图约 96%)逮住了它。整页务必与组件截图配对
  ——而瞄准组件靠的正是 testid。
- **a11y 抓肉眼抓不到的。** axe 扫出一处对比度不达标的分隔线(WCAG AA 失败),评审时看
  着没问题——要自动化,别靠肉眼。

互补性正是要点:**testid 定位符对变化"有抗性"(换皮不能移动它们——已验证:整套重设计
后每个 id 都 sticky,零漂移);视觉 baseline 对变化"敏感"(换皮就该点亮它们供评审)。**
两个轴都需要,且共享同一批锚点。

### 1.9 标准测试流程(有顺序 + 有触发条件)

§1.1–1.8 讲的是**能力**。这里给的是 Agent(或 CI)**每次改动都要遵循的协议**。两条总
规矩:**门按"快→慢"排序,让失败尽早暴露;由改动的"类型"决定哪些门是强制的。** 任何一个
强制门被跳过,这次改动就不算完——id 变化是**必要但不充分**的信号。

**流水线——永远这个顺序:**

0. **基线**:记下上次绿的注册表版本(`mark-green` 锚点 / `--since` 文件)。
1. **静态、快**:`typecheck` → `vitest run --coverage`(单元 + 代码覆盖率)→ lint。
2. **`tag`**(sticky)。**继续之前先消化每条警告**:`unstable-identity` → 加 `data-tid`;
   `loop-multiplicity` / `component-multiplicity` → 绑定 per-item `:data-testid`。(这里
   忽略的警告,就是日后会抖的定位符。)
3. **`affected --since`(或 `diff`)** → 用例级的重测工作单。
4. **`gen-constants --check`** → 落后就重生成并提交;消失的 id 必须在 `tsc` 处 fail-closed,
   绝不静默。
5. **跑路由出来的测试**:`affected` 的 e2e spec,**外加**改动表面的**视觉回归**(整页+组件)
   与 **a11y**。任何 UI 改动还要**渲染并亲眼看**(截图)——自动门不评判审美。
6. **覆盖率**:`coverage --runtime`(testid)+ 单元 `--coverage`(代码)。两个门都上棘轮
   (`--min` / `coverage.thresholds`);延后的簇要显式记录,绝不静默丢弃。
7. **`mark-green`**:选择性套件转绿后执行——新的重测锚点。
8. **CI / 夜间**:跑**全量**(所有 spec、所有视口)。传递性代码改动**按设计**对注册表不可见,
   全量跑是兜底。

**触发矩阵——每种改动"类型"必须跑什么**(✓ = 强制):

| 你改了… | 单元+代码覆盖 | tag → affected | 功能 e2e | 视觉回归 | a11y | 全量 |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| 标记 / DOM / 属性 | 若也改了逻辑 | ✓(id、路由) | 仅 affected | ✓ 整页+组件 | ✓ | — |
| 仅 CSS / 样式 | — | ✓(预期 **0 漂移**) | 冒烟 | ✓ **(就靠它把关)** | ✓(对比度) | — |
| 仅文案 / 文本 | — | ✓(`modified{text}`,id 冻结) | 仅当有测试断言该文案 | 若在被测元素内则组件截图 | — | — |
| handler / 校验器 / 逻辑体 | ✓ | ✓(`symbol:` 重测) | affected(L2 路由) | — | — | — |
| store / 状态 / 数据模型 | ✓ | — | 涉及它的流程 | — | — | — |
| 新组件 / 新屏 | ✓(新) | ✓(新 id + 警告) | **写新的** | **新 baseline** | ✓ | — |
| 路由 | — | ✓(route 信号) | 导航 spec | 新路由 | — | — |
| 依赖升级 / 构建 / 框架升级 | ✓ | `tag --check`(预期 0 漂移) | — | — | — | ✓ |

每一行读作"id 信号看不见这个,所以这些别的门必须上":只改 CSS 不动任何 id,但必须过
**视觉 + a11y**;改 handler 体不动 id,但 `symbol:` 会路由它的测试;升依赖什么可见的都没碰,
所以要**全量跑**。每一行的存在,都是因为在 dogfooding 时少跑一次就放过了一个真 bug
(原生校验 bug、WCAG 对比度失败、被整页 diff 稀释的局部视觉变化)——见演示项目的
`DEV-LOG.md`。

---

## 2. CLI 参考

所有命令均接受 `--registry DIR`(默认 `test-artifacts/testids`)或 `--server URL`
(远程后端,行为完全一致)。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `tag <paths...>` | `--ext .html\|.vue\|.jsx,.tsx[,…]`(默认 `.html`)· `--adapter html\|vue\|angular\|react` · `--attr NAME` · `--regenerate` · `--dry` · `--check` | adapter 自动选择:`.vue`→Vue;`.jsx`/`.tsx`→React(老式 `.js` JSX 用 `--ext .js --adapter react`);含 Angular 特征(`(event)=`、`*ngIf`……)的 `.html`→Angular;其余→HTML。`--check`:CI 闸门,零写盘,需打标则 exit 1。`--regenerate`:丢弃已写 id,按当前信号重铸 |
| `diff <from> <to>` | — | markdown diff 到 stdout(字段级 + `symbol:` 变更) |
| `gen-locators` | `--target robot\|playwright\|cypress\|webdriverio\|selenium-python\|testcafe`(默认 `robot`)· `--out DIR`(默认 `tests/locators`)· `--attr` | 选择器约定 `[data-testid="<id>"]` |
| `gen-constants` | `--out FILE` · `--check`(CI 闸:已提交的常量模块缺失或落后于注册表最新版时 exit 1)(默认 stdout) | 常量名冲突时抛错(守住 fail-closed) |
| `mark-green` | `--since FILE`(默认 `.testids-green.json`)| 把注册表最新版本记为重测锚点;选择性重测通过后执行。之后 `affected --since FILE` 恒为 上次绿 -> 最新 的 diff |
| `rollback` |(仅嵌入式)| 把 `latest` 指回上一版本(非破坏性:被回滚的 `v<N>.json` 保留,重新 tag 会覆盖它)。用于一次错误打标后回退 |
| `activity` |(仅嵌入式)| 打印注册表活动日志(每次 save 与 rollback,从旧到新)|
| `coverage` | `--tests DIR[,DIR]`(默认 `e2e`)· `--min N` · `--runtime FILE` | 已打标 id 被测试引用的覆盖率(总体 + 交互元素);`--min` 以交互覆盖率为闸门(低于则 exit 1);`--runtime` 合并运行时"行使"工件(引用 vs 行使 + 动态 id) |
| `affected <from> <to>`(或 `--since FILE`)| `--tests DIR[,DIR]` · `--out-list FILE`(给 runner 的文件清单)· `--grep-out FILE`(供 `-g`/`-t` 的用例标题正则)· `--files-only`(旧的文件级报告)| 默认用例级:指出每个变更 id 所在的具体 `test(...)` 块 `--tests DIR[,DIR]`(默认 `e2e`)· `--out-list FILE` | 扫描 `.ts/.tsx/.js/.jsx/.mjs/.cjs`;生成的常量文件自动排除;`--out-list` 输出换行分隔的 `re-test` 文件清单 |

后端:`npm run serve` 启动 REST 外壳(`PORT`、`REGISTRY_DIR` 环境变量)。

## 3. 配置参考(`CoreConfig`)

CLI 只暴露 `--attr`;完整配置走库
(`runPipeline(adapter, transport, files, config)`)或服务。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `idFormat` | `{component}__{element}--{key}{disambiguator:--}` | token:`{component}` `{element}` `{key}` `{tag}` `{disambiguator}`;`:--` 形式仅在有值时渲染为 `--<value>` |
| `attributeName` | `data-testid` | 写入/读取的属性 |
| `explicitKeyAttribute` | `data-tid` | 手写稳定 key(Tier 0),直接赢得 identity |
| `customTagMap` | `{}` | 组件库分类映射,如 `{ 'v-btn': { short: 'button', long: 'vuetify_btn' } }`(参见 `VUETIFY_TAG_MAP`) |
| `ignoreTags` | `[]` | 永不打标 |
| `skipTags` | `h1…h6, th, label` | 纯文案标签:不铸新 id,**除非**带 `data-tid` 或已有写入的 id(sticky 永远尊重) |

identity key 优先级(core 持有,不可配置):
`explicit_key → form_control → name → route → event_handlers → bound_identifiers →
html_id → structural → child_shape → text → aria_label → placeholder → tag`。

## 4. 警告参考

| 警告码 | 触发条件 | 处置 |
| --- | --- | --- |
| `unstable-identity` | 新铸 id 的 key 落到了文案(`text`/`aria_label`/`placeholder`)或裸 tag | 测试要定位它就加 `data-tid`;否则可忽略(写入后 id 即 sticky) |
| `loop-multiplicity` | 元素在 `v-for`/`*ngFor` 内——一个静态 id,N 个渲染实例 | 改绑定式按项 id(`:data-testid="'x-' + item.id"`);tagger 之后会整体跳过它 |
| `positional-disambiguator` | 同 identity 兄弟无可区分稳定 token,按位置分配槽位(registry 稳定,但对*完全相同*的元素重排敏感) | 给其中一个加显式 `data-tid` |
| `component-multiplicity` | 内含已打标元素的组件在本次 run 中被实例化 ≥2 次(`<ArticlePreview>`×N、`app-list-errors`×N……)——其内部每个 id 在 DOM 中出现 N 份(`loop-multiplicity` 的跨文件版) | 查询时限定实例容器作用域,或在组件内部绑定按实例区分的 id;内部没有 id 的组件不报(不会产生重复) |

## 5. 注册表文件

`--registry` 目录内容(请提交):

- `v<N>.json` —— 每次 tag 一个不可变快照;`latest.json` —— 最新副本。以
  **canonical JSON**(键排序)写入,git diff 只显示真实变更。
- 快照:`{ version, generated_at, entries, retired }`。
  - `entries[id]`:`component`、`tag`、`element_type`、`identity`(稳定匹配键)、
    `fingerprint`(描述签名)、`disambiguator`、`symbol_defs`(引用符号定义哈希)、
    `signals`(归一化快照)、`source`(`generated` | `sticky` | `manual`)、
    `first_seen_version`、`last_seen_version`、`last_generated_at`、`generation_history`。
  - `retired`:已消失 id 的墓碑——溯源跨越"消失又回归"(支撑 `regenerated` 分类)。

## 6. FAQ 与排障

**改了文案 id 却没变——bug?**
不是,这正是核心保证。diff 会报 `modified { text }`;定位器照常工作。只有断言了该文案的
用例才需要看。

**我就是想要新 id。**
删掉该属性(该元素下次运行重铸),或 `tag --regenerate`(全部重铸)。注意:只靠遗留 id
才可打标、自身无任何信号的元素,`--regenerate` 后会被跳过并残留旧属性——请先给这类元素
加 `data-tid`(已记录的限制)。

**`data-tid` 和 `data-testid` 什么关系?**
`data-tid` 是*输入*:手写的稳定 key,直接决定 identity。`data-testid` 是*输出*:工具
写入、测试查询的属性。同一元素上两者并存。

**我想打标的 `th`/`label`/标题被跳过了。**
`skipTags` 只跳过纯文案标签的*新铸*。给该元素加 `data-tid`(或通过库配置收窄
`skipTags`)。

**表格里每行的按钮共享同一个 id。**
这就是 `loop-multiplicity` 警告。改绑定式按项 id;在那之前只有 count 级断言可靠
(`expect(getByTestId(...)).toHaveCount(n)`)。

**`gen-constants` 抛 "collides"。**
两个 id 归约成了同一个 camelCase 常量名。给其中一个元素加显式 `data-tid`。抛错是
故意的——静默的重复键会让 fail-closed 闸门变成 fail-open。

**两个分支都 tag 了,注册表冲突。**
特性分支只跑 `tag --check`;注册表在 main 上推进(合并后 CI 执行)。分支已经 tag 的:
rebase 后重跑 `tag`——sticky 保证 id 本身不变,只是版本号重排。

**符号跟踪没有标记我的变更。**
覆盖范围:元素直接引用的 Vue `<script setup>` 顶层声明(handler 名、绑定根、`v-model`
目标)。设计上不覆盖:传递调用(service/util 函数体)、options API / 普通 `<script>`、
import 符号的实现体(只哈希 import 语句)。这正是周期性全量存在的原因。

**对 `.vue` 跑 `tag` 报 `@vue/compiler-sfc` 错误。**
安装可选 peer:`npm i -D @vue/compiler-sfc`。

**测试覆盖率达到多少算"标准"?**
没有通用标准数。强制数字只存在于安全关键行业的**单元级**覆盖标准(DO-178C:A 级软件
100% MC/DC;ISO 26262 按 ASIL 分级);普通代码覆盖率的业界惯例是 80% CI 门禁(Google
的分档:60% 及格 / 75% 良好 / 90% 优秀——并强调覆盖率只能告诉你哪里**肯定没测**)。
而本工具度量的可交互 e2e 覆盖率**没有任何行业基准**。正确用法不是对标某个数,而是
经过验证的三步:(1)关键用户旅程(登录、支付、核心 CRUD)上的交互元素全部被引用——
按业务路径划定,不按百分比;(2)长尾用棘轮:测基线 → 处理 ⚠ 表最大簇 → 把 `--min`
锁到新实测值,只许升不许降;(3)先信分母再信比例——让分母更诚实的修复会**降低**
百分比(本项目实例:挂 handler 的组件纳入分母后 59.6% → 54.7%),这是进步不是回归。
升级后应重新校准 `--min`,而不是回退。

**我只打标了一个子目录,其它条目会不会全被退役?**
不会(作用域 reconcile 修复后):缺席的 id 只有在其源文件确实被本次解析时才退役;
本次范围之外的条目原样携带,CLI 会打印携带数量。唯一注意:修复前写入的存量注册表
没有记录文件作用域——先全量跑一次 tag 完成升级,之后部分打标即安全。
