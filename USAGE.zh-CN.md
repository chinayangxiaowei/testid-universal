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
npm i -D testid-universal @vue/compiler-sfc   # compiler-sfc:可选 peer,仅 Vue 项目需要
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

五段管线(check → 常量+tsc → affected → 选择性执行 → 全量兜底)按
`docs/superpowers/specs/2026-06-11-ci-integration-design.md` 搭建。两条诚实规则:
git diff 超出被打标组件文件范围时放弃选择性、升级全量;保留夜间/合并后全量
(传递性代码变更对注册表不可见,这是设计边界)。

---

## 2. CLI 参考

所有命令均接受 `--registry DIR`(默认 `test-artifacts/testids`)或 `--server URL`
(远程后端,行为完全一致)。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `tag <paths...>` | `--ext .html\|.vue[,…]`(默认 `.html`)· `--adapter html\|vue` · `--attr NAME` · `--regenerate` · `--dry` · `--check` | adapter 按匹配文件自动选择;混合集合报错。`--check`:CI 闸门,零写盘,需打标则 exit 1。`--regenerate`:丢弃已写 id,按当前信号重铸 |
| `diff <from> <to>` | — | markdown diff 到 stdout(字段级 + `symbol:` 变更) |
| `gen-locators` | `--target robot\|playwright\|cypress`(默认 `robot`)· `--out DIR`(默认 `tests/locators`)· `--attr` | 选择器约定 `[data-testid="<id>"]` |
| `gen-constants` | `--out FILE`(默认 stdout) | 常量名冲突时抛错(守住 fail-closed) |
| `affected <from> <to>` | `--tests DIR[,DIR]`(默认 `e2e`)· `--out-list FILE` | 扫描 `.ts/.tsx/.js/.jsx/.mjs/.cjs`;生成的常量文件自动排除;`--out-list` 输出换行分隔的 `re-test` 文件清单 |

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
