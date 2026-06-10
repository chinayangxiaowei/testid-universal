# testid-universal

[English](./README.md) | 简体中文

一个框架无关的**构建期 TestID 引擎**,让 `data-testid` 成为自动化测试维护的可靠桥梁:
任何代码变更之后,它都能**精确、确定地**告诉你——**哪些 e2e 测试用例需要重建、修改或删除**。

```
RawSignals(逐元素) → identity + fingerprint → 确定性 id
        → 版本化注册表 → diff → 重测路由(用例映射 + 源码依赖映射)
```

## 要解决的问题

`data-testid` 是 e2e 定位器的标准锚点,但手工管理会在两个方向上失效:

1. **定位器腐化。** 标记一改 id 就漂移(或重复、或缺失),测试静默匹配到错误的元素——
   或者什么都匹配不到。
2. **定位器健康、测试却过期。** id 仍能命中元素,但*元素背后的行为*变了(handler 函数体、
   校验器、绑定的值)。没有任何信号告诉你这条用例需要重跑或重写。

只解决 #1(多数生成器止步于此)是必要但不充分的:**id 变更只是一个信号;
源码依赖变更是与之互补的另一个触发器。**

## 工作原理

### 1. 封闭的信号契约(adapter 无法作弊)

各框架 adapter 把模板解析成携带 **`RawSignals`** 的 `ElementNode[]`——一个封闭、分层的
schema。adapter 只负责把框架词汇映射进命名槽位(`formControlName`/`v-model` →
`form_control`,`@click` → `event_handlers`,……);优先级策略、哈希与 diff 全部在 core,
adapter 无权配置。

| 层级 | 信号 | 角色 |
| --- | --- | --- |
| 0 | `explicit_key`(手写的 `data-tid`) | 绝对身份锚点 |
| 1 | `form_control`、`name`、`route`、`event_handlers`、`bound_identifiers`、`html_id`、`structural` | **identity**(稳定、代码接线) |
| 2 | `child_shape`、`context`、`semantic_css` | 仅用于消歧 |
| 3 | `text`、`aria_label`、`placeholder`、`title`、……、`static_attributes` | **仅进指纹**(易变文案) |

### 2. identity ≠ fingerprint

- **identity** 是稳定的匹配键,**只由稳定信号构成**——显示文案排在最末,一旦沦为 key 会
  触发 `unstable-identity` 警告。identity 是元素*自身*信号的纯函数:新增或修改元素 B
  永远不会挪动元素 A 的 id。
- **fingerprint** 是覆盖**全部**信号的描述性签名。它从不用于匹配——只用来判定
  `modified` 并报告*具体哪些字段变了*。

### 3. sticky id——定位器永不漂移

重打标时,已写入 `data-testid` 的元素**原样保留**(`source: 'sticky'`)。改文案、调样式、
插兄弟——什么都不会挪动已写入的 id。只有 `--regenerate`(或删掉该属性)才会重铸。
新铸 id 保证唯一(组一致消歧;位置后缀通过指纹字节级匹配继承上一版槽位,
重排兄弟不会挪动老元素)。

循环(`v-for` / `*ngFor`)内的元素会收到 `loop-multiplicity` 警告:一个静态 id 被每个渲染
实例共享——应改用按项绑定的 id(`:data-testid="'row-' + item.id"`),而这种绑定写法
tagger 会**尊重并永不覆盖**。

### 4. 确定性 diff——零模糊匹配

快照以 JSON 注册表版本化。`diff(v1, v2)` 对每个 id 做精确分类:
`unchanged` / `added` / `removed` / `modified`(带字段级变更清单)/
`regenerated`(消失后回归的 id,经墓碑溯源识别)。整条链路没有任何相似度阈值——
每个信号都是精确比较。

### 5. testID → 用例映射(fail-closed)

`generateConstants(snapshot)` 产出 `testIds` 常量模块。测试 import 常量而非硬编码字符串,
于是 id 被删除或改名时**编译直接失败**——绝不会发生静默的运行时错配。
`buildTestMap(testFiles, snapshot)` 扫描测试源码(常量引用 + 裸 id 字符串)得到
`id → [测试文件]`;`affectedTests(diff, map)` 把 diff 变成已路由的动作清单:
**`write-new` / `retire` / `re-test`**。

### 6. testID → 源码依赖映射(id 没变也知道该重测)

core 为每个元素挑选它直接引用的符号(handler 名、绑定标识符的根、`v-model` 目标);
adapter 把这些符号解析为**定义的源码文本**(Vue:经 `@vue/compiler-sfc` 取
`<script setup>` 顶层声明);core 对文本做空白不敏感的哈希,存入 `symbol_defs`。
当某个定义体发生变化——哪怕 id 冻结、标记一字未动——diff 也会报告 `modified` 并标明
`symbol:<name>`,关联用例被路由为 `re-test`。

**诚实边界:** 只跟踪*直接引用*的定义。import 的符号只解析到 import 语句本身;
符号→符号的调用(handler 调 service)**不**追踪。无此能力的框架/adapter 降级为
仅名字跟踪。symbol 跟踪之前创建的注册表升级时零噪音(首次运行只记录基线)。

## 快速上手

```bash
npm install            # core 零运行时依赖
npm i -D @vue/compiler-sfc   # 仅在使用 Vue adapter 时需要(可选 peer 依赖)
```

### 给 Vue 项目打标(库方式)

```ts
import {
  VueAdapter, LocalTransport, JsonFileStorage, runPipeline, diffToMarkdown,
} from 'testid-universal';
import { readFileSync, writeFileSync } from 'node:fs';

const transport = new LocalTransport(new JsonFileStorage('.testids'));
const adapter = new VueAdapter(); // 或 new VueAdapter(VUETIFY_TAG_MAP)

const files = ['src/pages/LoginPage.vue'].map((file) => ({
  file,
  component: file.split('/').pop()!.replace('.vue', ''),
  source: readFileSync(file, 'utf8'),
}));

const result = await runPipeline(adapter, transport, files);
for (const t of result.tagged) if (t.after !== t.before) writeFileSync(t.file, t.after);

console.log(`registry version ${result.version}`);
for (const w of result.warnings) console.warn(w.message); // unstable-identity / loop-multiplicity

// 之后:编辑代码、再次 runPipeline,然后——
const d = await transport.diff(1, 2);
console.log(diffToMarkdown(d!));
```

重复运行是**幂等且 sticky** 的:已打标文件不会被重写,已写入的 id 永不重算。
传 `runPipeline(..., { regenerate: true })` 可强制重铸。

### 把 diff 路由到你的测试

```ts
import { generateConstants, buildTestMap, affectedTests, affectedTestsToMarkdown } from 'testid-universal';

// 1. 产出常量文件并提交;测试从中 import { testIds }
writeFileSync('e2e/testids.generated.ts', generateConstants(snapshot));

// 2. 建立 id → 引用它的测试 的映射
const map = buildTestMap(testFiles /* {file, source}[] */, snapshot);

// 3. diff 之后:哪些测试要新写 / 下线 / 重测
console.log(affectedTestsToMarkdown(affectedTests(diff, map)));
```

`modified` 的 id(标记字段或 `symbol:<name>` 变更)→ 其测试路由为 `re-test`;
`removed` → `retire`(且消失的常量直接让编译失败);`added` → `write-new`。

### CLI(嵌入式)

```bash
npm run cli -- tag src/app --registry ./reg                  # HTML 类模板(默认 --ext .html)
npm run cli -- tag src --ext .vue --registry ./reg           # Vue SFC(自动选用 VueAdapter)
npm run cli -- diff 1 2 --registry ./reg
npm run cli -- gen-locators --target playwright --out tests/locators --registry ./reg
npm run serve            # 可选:在 :7337 启动 node:http 后端;任意命令加 --server <url> 即切远程
```

adapter 会根据匹配到的文件自动选择(`.vue` → `VueAdapter`,否则 HTML);
`--adapter <html|vue>` 可覆盖;混合两类文件的运行会被明确报错拒绝。嵌入式与远程可互换:
同一个 `TestIdService` 背后,`LocalTransport`(进程内)或 `HttpTransport`(REST)
任选其一,调用代码完全一致。

### 定位器生成

`gen-locators` / `generateLocators(snapshot, target)` 为 **Robot Framework**、
**Playwright**、**Cypress** 产出可直接使用的定位器文件(选择器约定
`[data-testid="<id>"]`)。

## 真实生命周期长什么样

| 编辑 | 结果 |
| --- | --- |
| 首次打标 | 由稳定信号铸出 id(`login__input--email`、`login__button--onsubmit`) |
| 按钮文案 "Sign in" → "Log in" | id 冻结;diff:`modified { text }`——只有断言了文案的用例才需要看 |
| 新增一个字段 | diff:`1 added`,其余一切不动 |
| 只改 `onSubmit` 的**函数体**(模板未动) | id 全冻结、0 文件重写;diff:恰好接线到它的 form + button 报 `modified { symbol:onSubmit }` → 其用例路由为重测 |
| 删除一个元素 | diff:`removed`;其常量消失 → 引用它的测试编译失败;报告给出 `retire` |
| 无稳定信号的交互元素(`<button>OK</button>`) | 照常打标,但警告:如需稳定请加 `data-tid` |
| 纯文案展示标签(`h1`–`h6`、`th`、`label`) | 默认跳过(`skipTags`)——加 `data-tid` 可选入;已写入的 id 仍 sticky 保留 |
| `v-for` 内的元素 | `loop-multiplicity` 警告 + 修复建议;绑定式 `:data-testid` 会被尊重、永不覆盖 |

## 架构

| 层 | 文件 | 框架相关? |
| --- | --- | --- |
| Adapters | `src/adapters/{contract,html,vue,sketches}.ts` | **是——仅此层** |
| Core 引擎 | `src/core/{types,signals,identity,fingerprint,classify,format,sourcedeps,engine}.ts` | 否(纯函数) |
| Registry | `src/registry/{storage,registry,diff}.ts` | 否 |
| 定位器与常量 | `src/locators/` | 否 |
| 测试映射 | `src/testmap/` | 否 |
| 后端 | `src/server/`(`TestIdService` + `node:http` 外壳) | 否 |
| 客户端 | `src/client/{transport,pipeline}.ts` | 否 |
| CLI | `src/cli.ts` | 否 |

依赖只向下;core 除 `node:crypto` 外零依赖。新增一个框架 = 实现一个 adapter
(`parse`、`write`,以及可选的 `resolveSymbolDefs`,即 L2 能力)。现有 adapter:
**Vue**(AST 驱动,全能力)与 **HTML**(正则扫描器,演示级);Angular/React 仅有草图。

## 不变量

1. identity 不含显示文案;文案做 key 是会被警告的最后兜底。
2. `static_attributes` 只进指纹——永不进 identity。
3. id 是元素自身信号的纯函数;无随机数、无计数器。
4. 单次解析内每个产出的 id 都唯一。
5. 写回幂等(先剥离旧 testid 再写入)。
6. 已写入的 id 即 sticky;只有 `--regenerate` 会重铸。
7. adapter 只填信号槽位、只解析定义*文本*;策略、哈希与 diff 由 core 持有。

## 已知限制

- 完全相同且无信号的兄弟元素按文档序消歧(信息论上不可避免)——警告会建议加显式
  `data-tid`。
- 源码依赖只追踪**直接引用**(不做调用图);Vue options API / 普通 `<script>` 降级为
  仅名字。
- `JsonFileStorage` 是 last-write-wins(无锁、无鉴权)——嵌入式够用,共享服务请换
  事务性存储。
- HTML adapter 是正则扫描器;Angular/React adapter 尚未实现。

## 开发

```bash
npm test            # vitest(107 个测试)
npm run typecheck   # tsc --noEmit
npm run build       # tsc
npm run demo        # HTML 端到端演示
npm run demo:vue    # .vue → 打标 → diff → Playwright 定位器
```

设计文档在 `docs/superpowers/specs/`(身份模型;sticky id + 双映射);实证发现在
`docs/findings/`。项目始于对构建期 Angular tagger 思路
(`spachtholz/TestID-Generator`)的洁净室提炼,此后已自成一体:sticky id、精确身份
diff、fail-closed 用例映射、定义级源码追踪均为本代码库原创。
