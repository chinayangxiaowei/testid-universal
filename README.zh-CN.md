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

**再追一层(`dep_defs`,默认开启;`tag --no-deps` 关闭)。** 被引用 handler *直接使用*的
定义也会被哈希:同文件辅助函数、import 的函数(相对路径、tsconfig/jsconfig `paths` 别名、
re-export barrel 一直跟到真实声明)、通过实例别名访问的 hook / store
(`const tasks = useTaskStore(); tasks.claimTask()` → 只切 `claimTask` 这个成员),以及
Angular 注入服务的方法(`this.svc.create()`)。这些定义变化时 diff 报 `modified`,字段为
`dep:<handler>><ref>`(如 `dep:submit>createOrder`),关联用例路由为 `re-test`。只切被引用的
声明/成员,改同模块的其他导出不会误报。

**诚实边界:** 追踪止于 handler 之后一层——`createOrder` 自己再调用的(第三层)、裸包
(node_modules)、动态分发都**不**追踪。看起来是本地模块却解析不了的 import,`tag` 会明确
打印 UNRESOLVED(绝不静默当作没变)。超出一层的部分不做哈希,但会被**点名**:`tag` 打印
BEYOND-depth 依赖(`submit>createOrder>validate`、同对象的 `this.persist()`、
`(dynamic) handlers[mode]`),注册表以 `dep_limited` 保存,`affected` 末尾附「⚠ Beyond tracking
depth」小节,列出这类代码变更时应兜底重跑的测试(或直接跑全量)——追两层不等于安全。跨文件变更只有在依赖方文件也在本次 `tag` 范围内时才能
被看到(对整个源码树打标,不要只对改动文件打标)。无此能力的框架/adapter 降级为仅名字跟踪。
symbol / dep 跟踪之前创建的注册表升级时零噪音(首次运行只记录基线;dep 的 key 只在两侧都存在
时才比较)。

## 快速上手

> 手把手教程、CLI/配置/警告完整参考与 FAQ:**[USAGE.zh-CN.md](./USAGE.zh-CN.md)**。

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
for (const w of result.warnings) console.warn(`[${w.code}] ${w.message}`); // w.code: unstable-identity / loop-multiplicity / ...

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
npm run cli -- tag src --ext .vue --check                    # CI 闸门:不写盘,需要打标则 exit 1
npm run cli -- diff 1 2 --registry ./reg
npm run cli -- gen-locators --target playwright --out tests/locators --registry ./reg
npm run cli -- gen-constants --out e2e/testids.generated.ts --registry ./reg
npm run cli -- affected 1 2 --tests e2e --out-list retest.txt --registry ./reg
npm run serve            # 可选:在 :7337 启动 node:http 后端;任意命令加 --server <url> 即切远程
                         # (JsonFileStorage 仅限单机;设 DATABASE_URL 切 PostgresStorage)
```

`affected` 打印 `write-new` / `retire` / `re-test` 报告;加 `--out-list` 会产出可直接喂给
测试运行器的文件清单(`--include-limited` 会加入超深度兜底测试;注意防住空清单——不带过滤参数的
`playwright test` 会跑全部)。**CI 逐步搭建见 [`docs/ci-tutorial.zh-CN.md`](docs/ci-tutorial.zh-CN.md)**
(`examples/ci/` 下有可直接复制的路由脚本与 GitHub Actions workflow);设计依据见
`docs/superpowers/specs/2026-06-11-ci-integration-design.md`。

adapter 会根据匹配到的文件自动选择(`.vue` → `VueAdapter`,否则 HTML);
`--adapter <html|vue|angular>` 可覆盖;混合两类文件的运行会被明确报错拒绝。嵌入式与远程可互换:
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
| Adapters | `src/adapters/{contract,html,vue,angular,react}.ts` | **是——仅此层** |
| Core 引擎 | `src/core/{types,signals,identity,fingerprint,classify,format,sourcedeps,engine}.ts` | 否(纯函数) |
| Registry | `src/registry/{storage,registry,diff}.ts` | 否 |
| 定位器与常量 | `src/locators/` | 否 |
| 测试映射 | `src/testmap/` | 否 |
| 后端 | `src/server/`(`TestIdService` + `node:http` 外壳) | 否 |
| 客户端 | `src/client/{transport,pipeline}.ts` | 否 |
| CLI | `src/cli.ts` | 否 |

依赖只向下;core 除 `node:crypto` 外零依赖。新增一个框架 = 实现一个 adapter
(`parse`、`write`,以及可选的 `resolveSymbolDefs`,即 L2 能力)。现有 adapter:
**Vue**、**Angular**(AST 驱动;Angular 模板与普通 HTML 同为 `.html` 扩展名,CLI 按内容特征自动识别)与 **React**(JSX/TSX,`@babel/parser`;一个 JSX 源节点对应 N 个运行时实例,故 identity 仅由 props 构建、各实例共享同一 id),另有 **HTML**(正则扫描器,演示级)。

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
- 源码依赖追踪直接引用**再加一层**(`dep_defs`,不做调用图);Vue options API / 普通
  `<script>` 降级为仅名字。
- 并发写入不会丢数据:所有存储的 `save` 都对基线版本做 compare-and-swap(过期的写入方
  收到 `RegistryConflictError`;`tag` 会自动 rebase 重试,并发打标落为连续版本)。
  `JsonFileStorage` 用 `<registry>/.lock` 锁文件串行化写入方,并原子写入(临时文件 + rename)
  ——**单机 / 本地文件系统**上多进程并行安全(不支持网络文件系统),无鉴权。超过 30 秒的锁视为
  崩溃写入方遗留,会被回收。多机共享服务请用 `PostgresStorage`(行锁;传入 `pg.Pool` 才有真
  事务)。
- HTML adapter 是手写的、识别引号的扫描器,不是规范解析器。
- 写回由带种子的属性测试守护(`test/adapters/write-fuzz.test.ts`):随机合法 JSX——嵌套、prop
  里的 JSX、三元、展开、满是引号/花括号的注释与字符串、预先存在的 id——写回后必须仍可解析、
  去掉新增 id 后逐字节还原、单个元素绝不带两个 id、重打是不动点(`FUZZ_N` / `FUZZ_SEED` 可放大
  或固定一次运行)。React/Vue/Angular adapter 把标签自身已有 testid 的精确 AST 范围交给写回器;
  只有 HTML 仍靠词法扫描。

## 开发

```bash
npm test            # vitest(152 个测试)
npm run typecheck   # tsc --noEmit
npm run build       # tsc
npm run demo        # HTML 端到端演示
npm run demo:vue    # .vue → 打标 → diff → Playwright 定位器
```

设计文档在 `docs/superpowers/specs/`(身份模型;sticky id + 双映射);实证发现在
`docs/findings/`。项目始于对构建期 Angular tagger 思路
(`spachtholz/TestID-Generator`)的洁净室提炼,此后已自成一体:sticky id、精确身份
diff、fail-closed 用例映射、定义级源码追踪均为本代码库原创。
