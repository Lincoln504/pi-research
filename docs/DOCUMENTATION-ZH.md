# pi-research 研究文档（中文）

本文档将 **pi-research** —— 面向智能体的免费无限网络研究引擎与知识存储 —— 的全部官方
文档合并为一份中文长文档，便于连续阅读。以下六份官方文档在英文版中各自独立成篇，这里
按顺序汇总为一份：

1. [Pi 扩展](#pi-extension)
2. [智能体技能](#agent-skill)
3. [SDK](#sdk)
4. [知识存储](#knowledge-store)
5. [配置](#configuration)
6. [架构](#architecture)

英文原文档位于仓库的 [`docs/`](https://github.com/Lincoln504/pi-research/tree/main/docs)
目录。所有技术标识符 —— 环境变量、命令、路径、函数名、配置字面值 —— 均保留英文原文，
因为它们是软件中的真实名称，必须原样书写。翻译以概念的准确传达为准，力求让中文读者获得
与英文读者一致的理解。

---

## Pi 扩展 {#pi-extension}

pi-research 以 [pi](https://github.com/earendil-works/pi) 的**扩展**形式集成
（`src/index.ts`）：一个多智能体网络研究引擎，带有一个直接注册在 pi 进程内的实时终端
界面（TUI）。

### 用法

`research` 工具会自动注册，模型可以用自然语言直接调用它；工具会根据查询内容自行判断
所需的深度（1–3）。

```bash
pi -p "研究 WebAssembly 的最新进展"
pi -p "对 AI 推理硬件格局做一次深入的全面调研"
```

另外还注册了三个斜杠命令：

| 命令 | 说明 |
|---------|-------------|
| `/research <查询>` | 直接以配置的默认深度（`PI_RESEARCH_DEFAULT_RESEARCH_DEPTH`，默认 1）调用 `research` 工具 —— 一次普通的实时研究，不经过 LLM 环节。它不解析查询中的深度字样，也**不会**查询知识存储；只想查知识存储请用 `/knowledge-store <查询>`。 |
| `/research-config` | 打开交互式 TUI 设置面板。在无 TUI 的主机（RPC、web hub、print、JSON、SDK）上，菜单无法渲染，命令会说明原因，并改用这些主机上可用的无头诊断：`/research-config health`（系统健康状态）和 `/research-config knowledge-status`（知识存储状态）。 |
| `/knowledge-store <查询>` | 在本地知识存储中搜索查询，返回基于既往研究发现的综合回答。知识模式为 `none` 时不可用。知识存储的压缩由系统自动管理，因此没有维护子命令。 |

![用 /research 斜杠命令执行实时调查](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/01-slash-research.gif)

### 工具

扩展注册了三个工具：

| 工具 | 注册时机 |
|------|-----------|
| `research` | 始终 |
| `health` | 始终 |
| `research_knowledge_search` | 始终（见下方说明） |

`research_knowledge_search` 无条件注册，是为了让知识模式变更无需重启 pi 即可生效（pi
没有注销工具（unregister）的 API）。当 `PI_RESEARCH_KNOWLEDGE_STORE_MODE` 为 `none` 时，
该工具不会向智能体公开 —— 其提示词指引会被移除，任何调用都返回"知识存储已禁用"的结果；
`/knowledge-store` 命令同样不可用。是否公开，以及知识存储的读写路径，取决于当前的实时
模式，而不是注册状态。

工具排除：`research` 工具遵循 `excludeTools` 列表，该列表在宿主转发时取自 pi 会话上下文。

### TUI

研究运行期间，pi-research 会渲染一个实时进度面板：

- 研究员分条 —— 每个智能体一条：状态、已抓取 URL、已执行的操作。
- 波形动画 —— 活动抓取指示器。
- Token 用量 —— 模型 token 与估算成本（带非递减保护）。
- 状态闪烁 —— 成功为绿色，失败为红色。
- 转向消息 —— 运行中途用户给出的引导，包括排队中的和正在生效的。

| 按键 | 操作 |
|-----|--------|
| `Escape` | 取消当前研究 |
| `Ctrl+C` | 编辑器中有文本时：仅清空编辑器。编辑器为空时：取消运行（等同于 `Escape`）。 |
| 方向键 | 在 `/research-config` 菜单中导航 |
| `Enter` / `Space` | 循环切换某个设置项的值 |

### 配置

设置通过 `/research-config` 管理，它写入两个层级：

- 全局 —— 基础文件 `~/.pi/research/config.env`（适用于所有前端）。
- 项目 —— 集中式注册表（`~/.pi/research/state/project-settings.json`），按工作目录
  限定作用域。只有深度和知识存储模式是项目级作用域，因此某个仓库可以携带自己的研究
  深度，而不影响全局默认值。

如果想独立于其他前端配置 pi 扩展，可以在 `~/.pi/research/pi.env` 添加一个可选的叠加
文件（它只对 pi 扩展叠加在 `config.env` 之上）。完整的配置模型、优先级以及全部环境
变量清单见[配置](#configuration)。

### 编码智能体技能安装器

`/research-config` 菜单可以把 `pi-research` 技能安装到本机检测到的其他编码智能体中，
让它们通过 CLI 执行网络研究，也可以再将其移除 —— 移除时依据清单精确到创建的每个链接。
完整安装流程见[智能体技能](#agent-skill)。

### 生命周期

- `activate` —— 注册命令、工具、TUI 控制器，并初始化各项服务。
- `deactivate` —— 排空写入队列、关闭 LanceDB、终止浏览器进程池、释放嵌入模型。
- `session_shutdown` —— 按 `event.reason` 分流：`quit` 触发进程退出清理；reload / new /
  resume / fork 则在进程不退出的情况下完成清理。

扩展状态按 pi 会话隔离，因此 `/reload` 是安全的。
## 智能体技能 {#agent-skill}

pi-research 也以可移植的[智能体技能](https://agentskills.io/specification)（Agent Skill）
形式发布，因此任何遵循同一 `SKILL.md` 目录模型、兼容技能机制的编码智能体 —— Claude、
OpenAI Codex CLI 等 —— 都可以用 pi-research 执行网络研究。

### 安装

如果你已经在运行 `pi` 扩展（`pi install npm:@lincoln504/pi-research`），那你已经有引擎
了 —— 只需通过 `/research-config` → 安装到外部智能体（见[安装流程](#安装流程)）把技能
装上，下面的安装命令都可以跳过。模型设置那一步对你仍然适用：技能使用自己配置的
`PI_RESEARCH_MODEL` 运行，而不是 pi 会话的模型。

脱离 pi 独立使用时，先全局安装引擎，再把技能链接到本机检测到的每个编码智能体：

```bash
npm install -g @lincoln504/pi-research   # 引擎（把 `pi-research` 加入 PATH）
pi-research skill install                # 把技能链接到每个已检测到的智能体
```

在 npm ≥11.19（以及 npm 12）上，依赖安装脚本默认被跳过 —— 本包也不需要它们：
better-sqlite3 13 在自己的 tarball 中携带预编译绑定，隐身浏览器则在首次使用时自行准备
（第一次抓取需要几分钟）。整个过程无需任何审批（见
[README](https://github.com/Lincoln504/pi-research/blob/main/README.md#install)）。

`skill install` 只针对 `$HOME` 下已经搭建好的智能体，绝不会覆盖插槽中的其他技能，并把
自己创建的内容记入清单，让 `pi-research skill uninstall` 能精确移除。运行 `pi-research
skill status` 可以查看安装到了哪里。

接下来配置研究运行的模型 —— 技能和独立 CLI 只使用这个显式配置的模型（绝不跟随 pi 扩展
内选中的模型），没有模型就拒绝启动：

```sh
# ~/.pi/research/config.env  （或作为环境变量导出）
PI_RESEARCH_MODEL=provider/model-id
```

如果使用 `pi`，API 密钥会自动来自 pi 的配置（`~/.pi/agent/auth.json`）；否则还需要设置
`PI_RESEARCH_API_KEY`（写进同一个文件，或作为环境变量）。见[配置](#configuration)。

Windows 上请从 `cmd` 运行 `pi-research`，或使用 `pi-research.cmd`：PowerShell 的默认执行
策略（`Restricted`）会阻止 npm 的 `.ps1` 垫片（提示 "running scripts is disabled"）；也
可以一次性执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

![把研究技能安装到外部智能体](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/05-agent-skill.gif)

### 工作原理

```
智能体
  │  调用外部进程（Bash / exec）
  ▼
run.mjs  ——  零依赖启动器（agent-skill/pi-research/scripts/）
  │  定位已安装的引擎；找不到则快速失败并给出指引
  ▼
pi-research 引擎  ——  CLI（dist/cli.mjs）
  │  init → run → shutdown
  ▼
带引用的 Markdown 报告  →  stdout  →  返回给智能体
```

智能体根据 `SKILL.md` 中的 `description` 匹配并调用启动器。`run.mjs` 不携带任何依赖；
它依次定位已安装的引擎（先用 `PI_RESEARCH_BIN` 指向引擎的 `dist/cli.mjs`，再用
`PI_RESEARCH_PATH` 指向它的包目录，最后回退到 PATH / `node_modules` / `~/.pi/bin`），
如果包、模型或 API 密钥缺失，就以一条可操作的消息退出 —— 消息里会给出配置文件的位置。
它提供四个子命令：`research "<查询>"`（实时研究）、`knowledge "<查询>"`（检索既往发现）、
`knowledge-config [set <模式>]`（显示/设置按目录生效的知识存储模式）以及 `status`
（检查检测与配置状态）。

### 安装流程 {#安装流程}

技能源码位于包内的 `agent-skill/pi-research/`。所谓安装，就是把该目录链接到每个智能体
的技能文件夹。

> 这个目录刻意**不**命名为 `skills/`：pi 会把包根目录下的 `skills/` 当作自己的资源根
> 目录之一并加载其中的内容，那样会用一份以子进程方式运行的、更慢的自身副本，遮蔽扩展
> 的原生研究工具。

一键安装（推荐）。在 `pi` 扩展中运行 `/research-config` → 安装到外部智能体。安装器会：

1. 检测 `$HOME` 下存在哪些目标智能体 —— 目前是 Claude（`~/.claude/skills`）、OpenAI
   Codex CLI（`~/.codex/skills` —— 该路径未经 Codex 官方文档确认；Codex 的技能支持仍在
   演进中）和 OpenClaw（`~/.openclaw/skills`）。
2. 把 `agent-skill/pi-research/` 符号链接到每个已存在的智能体，绝不覆盖该插槽中已有的
   无关技能。
3. 把创建的内容记入清单，因此"从外部智能体移除"只会移除自己的链接。启动时还会对失效
   链接做垃圾回收。

> **卸载本身不会删除任何东西。** 包内带有 `preuninstall` 脚本，但 **npm 7 及以上版本
> 不会运行 `preuninstall`** —— 已在 npm 11 上验证：`postinstall` 会触发，`preuninstall`
> 不会。因此 `npm uninstall @lincoln504/pi-research` 会留下技能链接、状态目录
> （`~/.pi/research/state`）和缓存目录（`~/.cache/pi-research`，包括已下载的嵌入模型）。
> 请在移除包**之前**运行 `pi-research skill uninstall`，把链接一起带走。

独立使用（不装 pi 扩展）。`pi-research skill install` 和 `pi-research skill uninstall`
从 CLI 做完全相同的事 —— 相同的智能体检测、相同的清单、相同的"绝不覆盖外来技能"保证
—— 适用于用 `npm install -g` 安装了引擎、从不打开交互式扩展的用户。

自带技能注册 CLI 的智能体，也可以直接指向随包发布的文件夹，而不做符号链接。安装引擎后，
把 `$(npm root -g)/@lincoln504/pi-research/agent-skill/pi-research` 注册给该智能体即可
—— 它的根目录就是 `SKILL.md`，这正是这类工具预期的布局。以复制方式而非链接方式接入的
智能体，只会在下一次 `skill install` 时获得引擎升级，不会自动更新。

手动。自己把目录符号链接到任意智能体的技能文件夹：

| 智能体 | 个人 | 项目 |
|-------|----------|---------|
| Claude | `~/.claude/skills/pi-research/` | `<project>/.claude/skills/pi-research/` |
| OpenAI Codex CLI | `~/.codex/skills/pi-research/` | `<project>/.codex/skills/pi-research/` |
| OpenClaw | `~/.openclaw/skills/pi-research/` | `<workspace>/skills/pi-research/` |

### 前置要求

- Node.js >= 22.19.0
- `pi-research` 安装到启动器能找到的位置，并配置好模型（`PI_RESEARCH_MODEL`）和 API
  密钥。见[配置](#configuration)。

```bash
npm install -g @lincoln504/pi-research
node "<skill_dir>/scripts/run.mjs" status   # 验证引擎能否被检测到
```

![一条命令完成健康与就绪检查](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/06-health-check.gif)

安装完成后，让智能体去研究某件事即可 —— 它的技能系统会自动激活 pi-research。包内自带
的 readme（`agent-skill/pi-research/README.md`）和
`agent-skill/pi-research/references/configuration.md` 为直接浏览技能的用户提供了同样的
详细信息。
## SDK {#sdk}

面向脚本、CI 和自定义工具链的高层研究 SDK。配置相关（分层模型、TUI 设置、全部环境
变量）见[配置](#configuration)。

### 安装

把它安装为项目的依赖，让 import 能解析 —— 即使你已经运行了 `pi` 扩展也是如此，因为
扩展保留的是你的脚本无法 import 的私有副本：

```bash
npm install @lincoln504/pi-research
```

在 npm ≥11.19（以及 npm 12）上，依赖安装脚本默认被跳过。本包不需要任何安装脚本：
better-sqlite3 13 为所有受支持平台携带预编译绑定，运行时直接加载；隐身浏览器在首次
使用时自行准备。（早期版本文档中的 `npm approve-scripts better-sqlite3` + `npm rebuild`
组合，是用来修复 better-sqlite3 12 的 —— 它通过安装脚本下载绑定；13 直接把绑定打包
进 tarball，而且在 npm 12.0.2 上，approve 也没办法让被跳过的脚本跑起来。）

然后选择模型：向 `initResearchSDK` 传入 `model`，或设置 `PI_RESEARCH_MODEL`（环境变量
或 `~/.pi/research/config.env`）。SDK 绝不跟随 pi 扩展内选中的模型；只有当两者都未设置
时，才回退到 pi 注册表里第一个可用的模型。API 密钥自动来自 pi 的配置
（`~/.pi/agent/auth.json`），或者来自 `apiKey` 选项 / `PI_RESEARCH_API_KEY` 环境变量。

`src/sdk.ts` 是供脚本、CI 和自定义工具链使用的库。它通过代码配置，而不是全局叠加文件
—— 不存在 `sdk.env`。它以基础文件 `~/.pi/research/config.env` 为基线，其余一切都可以
用 `options.config` 覆盖。传 `ignoreGlobalConfig: true` 可以完全忽略全局文件，只用默认值
+ `process.env` + `options.config` —— 代码自洽、可复现。

> 运行时要求。包的导出（`.` 和 `/sdk`）解析为 TypeScript 源码 —— 没有编译产物
> `dist/sdk.js`。它必须在*转换* TypeScript（而不只是剥离类型）的运行时上运行：源码用到
> 了 `enum` 和构造函数参数属性，Node 的仅剥离模式（`--experimental-strip-types`，Node
> 23.6 起的默认模式）会以 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 拒绝。请二选一：
> - pi 宿主，它原生加载（经由 `jiti`）；
> - 或 `tsx`、`ts-node` 之类的加载器。
>
> **裸 Node 无论如何都加载不了它。** Node 拒绝剥离或转换位于 `node_modules` 下的
> TypeScript —— 已安装依赖的源码正是如此 —— 并以
> `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 失败。这一点对
> `--experimental-transform-types` 和 `--experimental-strip-types` 一视同仁，所以任何
> 标志都帮不上忙；必须用加载器（或 pi 宿主）。（`engines.node` 为 `>=22.19.0`。）

```typescript
import {
  initResearchSDK,
  runDeepResearch,
  runQuickResearch,
  getResearchReports,
  shutdownResearchSDK,
} from '@lincoln504/pi-research';

// 1. 初始化（配置全部写在代码里；不需要全局配置）
await initResearchSDK({
  model: 'openrouter/deepseek/deepseek-v4-flash', // "provider/id" 字符串或 Model 对象
  ignoreGlobalConfig: true,                       // 封闭运行：忽略 ~/.pi/research/config.env
  config: { MAX_SCRAPE_BATCHES: 4 },              // 带类型的 Config 覆盖
});

// 2. 深度研究（深度 1–3）
const markdown = await runDeepResearch('固态电池技术', { depth: 2 });

// 3. 快速研究（深度 0）
const quick = await runQuickResearch('法国的首都是哪里');

// 4. 取回上一次运行中各研究员的报告
const reports = await getResearchReports();

// 5. 清理 —— 必须执行：排空写入队列、关闭 LanceDB、终止 worker
await shutdownResearchSDK();
```

任何研究调用之前必须先执行 `initResearchSDK`。认证解析顺序：`options.apiKey` +
`options.provider` → `process.env.PI_RESEARCH_API_KEY` / `PI_RESEARCH_PROVIDER` → pi 的
`~/.pi/agent/auth.json`。上面五个调用是常规路径；[API 参考](#api-参考)一节列出了每个导出
的完整签名。

> 并发：单个已初始化的 SDK 实例同一时间只执行一个研究调用。同一实例上重叠的
> `runDeepResearch`/`runQuickResearch` 调用会抛错 —— 请串行执行，或为每个并发运行单独
> 起一个进程。
>
> 独立进程之间还受一个**机器级运行上限**（`PI_RESEARCH_MAX_CONCURRENT_RUNS`，默认 3）
> 约束，它覆盖主机上所有 pi-research 进程，因为它们共享同一个经领导者选举产生的浏览器/
> 嵌入进程池。超出上限的运行会排队，最多等 `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS`（默认
> 10 分钟），之后才以 `ResearchRunCapacityError` 拒绝 —— 这是一种"稍后重试"的临时状况，
> CLI 以退出码 `75` 呈现。可以用 `onRunQueued(slots, maxWaitMs)` 观察器告诉等待中的用户：
> 运行在排队，不是卡死了。

### 取消

`runDeepResearch`、`runQuickResearch`、`verifyUrl` 和 `scrapeUrl` 都接受一个可选的
`AbortSignal`，作为**最后一个位置参数**（不是选项对象里的字段）：

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);

const markdown = await runDeepResearch('…', { depth: 2 }, controller.signal);
```

编排器在每个轮次边界检查该信号，并把它贯穿到搜索、抓取和 LLM 调用里，因此中止会真正
停止工作，而不只是与工作脱钩。

**中止不一定会 reject。** 结果取决于信号到达时是否已经收集到内容：

| 中止时的状态 | 结果 | 观察器 |
|---|---|---|
| 已收集到至少一份研究员报告 | **正常 resolve**，基于已收集内容生成部分综合 | `onComplete` |
| 还没收集到任何内容 | **reject**（`Research aborted` / `Research cancelled`） | `onError` |

所以，当调用方自己中止了运行，就不能把"resolve"当成"完整跑完" —— 请检查你自己的信号，
而不是只盯 promise。无论哪种情况，`onComplete` / `onError` 都恰好触发其一。

CLI 始终通过退出码上报取消：带信号的运行在取消区间退出 —— **`128 + 信号`**（`130`
Ctrl-C/SIGINT、`143` SIGTERM、`129` SIGHUP、`131` SIGQUIT）—— 不涉及信号的程序化中止
则退出 `130`。被取消的运行绝不会以 `0` 退出，因为 `0` 表示研究成功，而负责转述的智能体
会把一次完成的运行报告给用户。

*部分*报告会不会先出现在 stdout，取决于中止落地前运行推进到了哪一步：处理器会在拆除
之前中止进行中的运行，因此仍然能综合已有内容的编排器可能会在退出前把材料打印出来。
请把它当成尽力而为的额外产出，而不是保证 —— 可以依赖的是退出码。

任何 ≥ 128 的退出码都视为取消；`pi-research --help` 列出完整集合，面向智能体的契约是
[`SKILL.md`](../agent-skill/pi-research/SKILL.md) 里的退出码表。

这些代码刻意不是 `70` 运行时错误码，也从不带 `retryable: true` —— 取消是已经完成的
意图，不是需要重试的故障。代码按信号推导而不是写死，是因为 CLI *处理*这些信号而不是
被它们杀死：如果写死，观察到的退出状态就会取决于处理器是否跑赢了强制终止（force-kill），
而 `128 + N` 无论哪种情况都与 shell 报告的数值一致。

事后仍然必须调用 `shutdownResearchSDK()`：中止只释放那一次运行，不会释放浏览器进程池、
LanceDB 句柄或 worker 进程。

SDK 不写报告文件。报告导出是前端（接入载体）的职责 —— pi 扩展和 CLI / 智能体技能在
`PI_RESEARCH_REPORT_EXPORT_ENABLED=true` 时执行导出。

### API 参考 {#api-参考}

除标注 *仅 sdk 子路径* 的两项外，以下列表中的每项都同时从 `@lincoln504/pi-research` 和
`@lincoln504/pi-research/sdk` 导出 —— 包入口刻意不重复发布这两项。除 `repairJson` 和
`getSDKContainer` 外，每次调用都要求先执行 `initResearchSDK()`，否则抛出
`SDK not initialized`。

**生命周期**

| 导出 | 签名 | 说明 |
|---|---|---|
| `initResearchSDK` | `(options?: ResearchSDKOptions) => Promise<void>` | 注册各项服务。已初始化时为空操作；会等待正在进行的关闭完成。 |
| `shutdownResearchSDK` | `() => Promise<void>` | 必须调用。排空写入队列、关闭 LanceDB、终止 worker 进程，并清空所有 `getLast*` 访问器。 |
| `getSDKContainer` | `() => ServiceContainer \| null` | *仅 sdk 子路径。* 内部/测试用途 —— 活动中的服务容器，init 之前为 `null`。不受 semver 约束；包入口不导出。 |

**研究**

| 导出 | 签名 | 说明 |
|---|---|---|
| `runDeepResearch` | `(query, options?, signal?) => Promise<string>` | 深度 1–3。返回 Markdown 报告。`options` 是 `ResearchOptions` 去掉 SDK 自持字段（`ctx`、`query`、`model`、`sessionId`、`researchId`）后的部分。 |
| `runQuickResearch` | `(query, options?, signal?) => Promise<string>` | 深度 0。同上，只是 `depth` 固定，因此不接受该字段。 |
| `runResearchDetailed` | `(query, options?, signal?) => Promise<ResearchRunResult>` | 与 `runDeepResearch` 相同的运行，但返回 `{ report, sessionId, runId, metrics, stats, reports }`，而不是裸字符串。 |
| `getResearchReports` | `(researchId?) => Promise<Map<string, string>>` | 按研究员 id 索引的逐研究员报告。默认为最近一次运行；还没有运行则为空映射。 |

**网络访问**

| 导出 | 签名 | 说明 |
|---|---|---|
| `scrapeUrl` | `(url, signal?) => Promise<ScrapeResult>` | 单条 URL 走完整流水线（SSRF 过滤 → fetch 或隐身浏览器 → PDF 提取 → Markdown）。 |
| `verifyUrl` | `(url, signal?) => Promise<boolean>` | 只检查可达性，不返回内容。URL 被拦截或失效时 resolve `false`，而不是抛错。 |

**知识存储**

| 导出 | 签名 | 说明 |
|---|---|---|
| `searchKnowledge` | `(queries: string[], signal?) => Promise<KnowledgeSearchResult>` | `{ text, found: 'yes' \| 'maybe' \| 'no', documentsSearched, citations }`。知识存储禁用、为空或不可用时 resolve `found: 'no'` —— 不抛错。 |
| `exportKnowledge` | `(outputPath: string) => Promise<void>` | 把知识存储写入一个可供 Web 消费的 JSON 文件。 |

**运行后遥测** —— 全部反映最近一次完成的运行，在完成之前为 `null`，并被
`shutdownResearchSDK()` 清空。

| 导出 | 签名 | 说明 |
|---|---|---|
| `getLastRunStats` | `() => ResearchStats \| null` | 从运行快照派生的核心计数（搜索数、抓取数、token、成本）。 |
| `getLastRunMetrics` | `() => IMetricsSnapshot \| null` | 该运行的原始计数器/计量器/直方图。 |
| `getLastRunSummary` | `() => RunSummary \| null` | `{ runId, startedAt, completedAt, durationMs, status, snapshot }`。 |
| `getLastErrorReport` | `() => ErrorReport \| null` | 聚合错误 —— 总数、模式、按域、按类型。让无人值守的调用方不解析日志就能看到失败情况。 |
| `getLastResearcherOutcome` | `() => ResearcherOutcome \| null` | `{ planned, launched, succeeded, failed, failureReasons }`。区分"主题稀疏导致报告单薄"和"大部分研究员失败"两种情况。 |
| `getSessionMetrics` | `() => IMetricsSnapshot` | 自 init 以来跨所有运行的累计值，而不是按运行统计。 |
| `logRunErrorSummary` | `(report, depthLabel, status) => void` | *仅 sdk 子路径。* 为一次运行的已追踪错误输出一行紧凑、已脱敏的摘要。报告为 null 或空时为空操作。 |

**健康与工具**

| 导出 | 签名 | 说明 |
|---|---|---|
| `getResearchHealth` | `(opts?: { force?: boolean }) => Promise<HealthReport>` | 运行所有已注册的健康检查。`force` 绕过缓存结果。 |
| `repairJson` | `(json: string) => string` | 修复被截断/损坏的模型 JSON。纯函数；init 之前即可使用。 |

**类型** —— `ResearchSDKOptions`、`ResearchRunResult`、`KnowledgeSearchResult`、
`ResearcherOutcome`、`ResearchOptions`、`ResearchObserver`、`IMetricsSnapshot`、
`IMetricHistogram`、`RunSummary` 和 `ResearchStats`。

**包入口还导出**以下内容，供想直接使用编排器而不经过 SDK 包装器的调用方：
`DeepResearchOrchestrator`、`QuickResearchOrchestrator`、`HeadlessObserver`（向 stdout
打印进度的观察器）、`ServiceNames`、`shutdownManager`、`extractRunStats`、
`normalizeUrl`、配置访问器 `getConfig` / `setConfig` / `resetConfig` / `validateConfig`，
以及团队规模常量。它们比上面的 SDK 函数更底层，并假定你自行管理服务容器。

### init 选项

| 选项 | 说明 |
|--------|-------------|
| `model` | `"provider/id"` 字符串或 `Model` 对象。省略时使用已配置的 `PI_RESEARCH_MODEL`；只有两者都未设置时，SDK 才回退到 pi 的第一个可用模型。 |
| `apiKey` / `provider` | 显式凭据（给 apiKey 时必须同时给 provider）。 |
| `config` | `Partial<Config>` 覆盖，应用于基线和默认值之上。 |
| `ignoreGlobalConfig` | 完全跳过 `config.env` —— 只用默认值 + `process.env` + `config`。 |
| `cwd` | 日志和知识存储的工作目录。 |
| `verbose` | 把日志镜像到控制台。 |

配置优先级、按前端区分的叠加层、完整的环境变量参考，见[配置](#configuration)。

### 健康与知识存储 API

`health` 工具（以及 SDK 的 `getResearchHealth()`）运行所有已注册的健康检查 —— 浏览器
能力、浏览器运行时、知识存储、状态管理器 —— 并返回结构化报告：

```typescript
import { initResearchSDK, getResearchHealth } from '@lincoln504/pi-research/sdk';

await initResearchSDK();                 // 必须先行 —— 未初始化会抛错
const result = await getResearchHealth();
// { success: boolean, status: 'healthy' | 'degraded' | 'unhealthy', components: [...] }
```

知识存储是内部服务，不是公开导出。它会在研究运行期间自动填充；请用 SDK 的
`searchKnowledge()` 或 `research_knowledge_search` 工具查询已存发现。向量维度取决于模型
（自动检测）；存储字段为 `text`、`content`、`vector`、`url`、`metadata`、`timestamp`、
`workspace`、`is_global` 和 `ingestion_type`。

### 使用示例

[Wall of Shame](https://wallofshame.io) 项目（[仓库](https://github.com/Lincoln504/wall-of-shame)）
在其智能体流水线中使用此 SDK：每次调查都调用 `initResearchSDK` 和研究入口（
`runQuickResearch` / `runDeepResearch`），并直接使用 `scrapeUrl`、`verifyUrl` 和
`repairJson` 导出。
## 知识存储 {#knowledge-store}

知识存储是既往研究发现的本地向量数据库。它是可选缓存（没有它研究照常工作），有两种
截然不同的使用方式：

- **知识优先作答（建议性）。** `research_knowledge_search` 工具直接依据已存结果回答重复
  或重叠的问题。智能体被要求在调用实时的 `research` 工具*之前*先试它，但这只是模型
  遵循的指引 —— 并非强制，而且 `research_knowledge_search` 是独立工具，不是挡在
  `research` 前面的关卡。
- **为实时运行播种（自动）。** 实时的 `research` 运行绝不会从知识存储作答；相反，编排器
  会把此前对该目标有用的 URL 作为起点交给每位研究员，让它们重新实时抓取。

![知识存储命中 —— 不经过实时运行直接返回缓存答案](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/03-knowledge-store.gif)

两者结合，让重复工作更快、更省。

### 它存储什么

知识存储是磁盘上的 [LanceDB](https://lancedb.com) 表。每轮研究结束后，研究员报告中
引用的 URL 会进入队列并在后台写入：每条来源的摘要（以及有可用时的完整抓取 Markdown）
被切分成文本块，每个文本块被嵌入成向量，然后存入行中。

每行携带嵌入向量、来源 URL（为去重做过归一化）、摘要文本和完整内容、时间戳，以及作用域
标志。内容哈希对重复摄入的 URL 去重：没变过的页面会被跳过；有变化的页面会替换旧行。
每个文档的完整页面 Markdown 只缓存一次，因此已存发现日后可以重新水合（rehydrate），
无需再次抓取。

写入绝不阻塞研究运行 —— 它们经过一个异步写入队列，该队列在轮次结束时和关闭时排空。

### 作用域：none、project、global

知识存储的覆盖面由知识模式（`PI_RESEARCH_KNOWLEDGE_STORE_MODE`）决定 —— 这是一个
项目级设置，可以按目录更改：

| 模式 | 行为 |
|------|----------|
| `global`（默认） | 所有目录共享一个知识存储。在一个项目里缓存的发现，可以在任何其他项目检索到。 |
| `project` | 发现限定在创建它的工作目录内；只有该目录能检索。 |
| `none` | 知识存储禁用 —— 不读不写，`research_knowledge_search` 工具不向智能体公开，`/knowledge-store` 不可用。重新启用无需重启（注册机制见 [Pi 扩展](#pi-extension)）。 |

在 pi 扩展里用 `/research-config` TUI（知识模式）更改当前目录的模式，或在独立 CLI 上
运行 `pi-research knowledge-config set <none|project|global>`（只能选一个值）。该设置
持久化到按目录的项目注册表 —— 完整优先级链见[配置](#configuration)。更改在下次运行
生效 —— 无需重启。

所有作用域共享同一个物理 LanceDB 目录；项目行和全局行靠列区分（归一化的 workspace 路径
加一个全局标志），在查询时过滤，而不是分目录存放。默认数据库目录是
`~/.pi/research/knowledge_db/`（可用 `PI_RESEARCH_KNOWLEDGE_DIR` 覆盖）。

嵌入模型是惰性初始化的 —— 只在知识存储第一次真正被写入或搜索时才下载并初始化，因此
`global` 这个默认值在运行缓存到第一页之前，不会带来任何启动开销。

### 运行如何使用知识存储

知识存储由编排器驱动，而不是研究员智能体随意调用，这保证了使用方式的确定性：

1. 每位研究员开始之前，编排器按研究员的目标搜索知识存储，把匹配的历史 URL —— 各带
   之前的摘要 —— 注入该研究员的提示词，作为建议重新抓取的起点。
2. 轮次结束后，被引用的 URL 及其描述进入写入队列，供下一会话使用。

另外，`research_knowledge_search` 工具（以及 SDK 的 `searchKnowledge()`）让模型可以直接
查询知识存储：它重新水合最相关的已存文档，问一个后台 LLM 这些文档是否回答了问题，然后
返回带引用的综合回答 —— 或者报告说需要实时研究。

### 嵌入与模型

嵌入在本地用 [`@huggingface/transformers`](https://github.com/huggingface/transformers.js)
基于 ONNX 计算。默认模型是
`onnx-community/granite-embedding-small-english-r2-ONNX`（英文；512 token 文本块窗口）。
每个受支持的模型都定义自己的文本块大小、池化策略和前缀，并产生一个固定的向量维度，
表结构围绕该维度构建。

受支持的模型（`PI_RESEARCH_EMBEDDING_MODEL`）：

| 模型 | 语言 |
|-------|-----------|
| `onnx-community/granite-embedding-small-english-r2-ONNX`（默认） | 英语 |
| `Xenova/multilingual-e5-small` | 多语言 |
| `Xenova/multilingual-e5-base` | 多语言 |
| `Xenova/bge-m3` | 多语言 |
| `onnx-community/embeddinggemma-300m-ONNX` | 多语言 |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | 多语言 |
| `Xenova/all-MiniLM-L6-v2` | 英语 |
| `Xenova/bge-small-en-v1.5` | 英语 |
| `Xenova/all-mpnet-base-v2` | 英语 |

更换模型会使既有向量失效（维度和语义都不同），因此知识存储会被迁移（见下方"更换
模型"）。模型在首次使用时从 Hugging Face 下载并缓存；首次下载可能需要几分钟（网络慢
时可以调高 `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS`）。

### 设备选择

嵌入可以在 GPU（WebGPU，经由运行时自带的 Dawn 后端）或 CPU 上运行。后端由
`PI_RESEARCH_EMBEDDING_DEVICE` 决定：

- `auto`（默认；TUI 中显示为 GPU）—— pi-research 在一个一次性子进程中探测 WebGPU
  可行性：在那里加载模型并跑一次真实嵌入。成功就用 GPU；失败就用 CPU。结论会被缓存，
  所以每台机器 + 每个模型最多探测一次。
- `cpu`（TUI 中显示为 CPU）—— 强制 CPU 推理，不探测。
- `webgpu` —— 强制 GPU 路径，不探测。高级 / 仅环境变量；见下方说明。

为什么需要探测。有些主机 —— VM、容器、CI runner、带软件 Vulkan 驱动的无头机器 ——
暴露出的 GPU 原生后端无法在其上执行计算。这种失败是原生段错误（segfault），不是可捕获
的错误，会直接终止进程。`auto` 探测在子进程里测试可行性（子进程崩溃不会影响主进程）
并回退到 CPU。强制 `webgpu` 会跳过这个检查，在这类主机上可能崩溃，所以 `/research-config`
菜单只提供 GPU（= `auto`）和 CPU。原始的 `webgpu` 仍可通过环境变量使用，以便在确认
GPU 良好的主机上做基准测试。

缓存的结论存放在 `~/.cache/pi-research/webgpu-viability.json`，以平台、架构、Node 主版本
和模型为键。设置 `PI_RESEARCH_WEBGPU_REPROBE=1` 可丢弃并重新探测（例如驱动升级之后）。

### 平台支持（不支持 Intel Mac）

知识存储依赖两个原生组件 —— 用于嵌入的 ONNX runtime 和用于向量存储的 LanceDB —— 它们
只为特定的平台/架构组合提供预编译二进制：

| 平台 | 架构 | 知识存储 |
|----------|--------------|-----------------|
| macOS | Apple Silicon（arm64） | 支持 |
| macOS | Intel（x64） | 不可用 |
| Linux | x64 / arm64 | 支持 |
| Windows | x64 / arm64 | 支持 |

Intel Mac（`darwin-x64`）上两个组件都没有预编译二进制，所以知识存储无法运行。任何
平台上，只要必需包完全没安装，也会同样干净地关闭 —— 可选的 `@huggingface/transformers`
被 `npm install --omit=optional` 跳过（也会被 npm 的可选依赖 bug 跳过），或
`@lancedb/lancedb` 安装损坏。降级是自动且快速的：

- 研究照常工作。搜索、抓取、YouTube 字幕、安全数据库、Stack Exchange、规划、综合都不
  受影响 —— 只是少了知识存储。
- 知识存储快速失败。缺失的包在任何初始化尝试之前就通过解析检测出来，所以不会有重试
  风暴 —— 知识存储直接以 OFF 启动。
- 设置界面会说明原因。`pi-research knowledge-config`、`/research-config` 菜单和健康
  检查会点名缺失的包和修复方法（安装可选依赖），而不是宣传知识存储无法兑现的模式。
  `research_knowledge_search` 未命中时会报告包缺失，而不是把责任推给一个帮不上忙的
  设置开关。
- 健康检查把知识存储报告为"已禁用"而不是"不健康"，因此缺失组件不会把整体健康拖到
  "unhealthy"，也不会阻塞快速（深度 0）运行。

不需要任何配置：安装包（含可选依赖的完整安装），知识存储就绪；只切换模式无法在进程
中途把它复活。

### 保留与淘汰

缓存发现的保留时长为 `PI_RESEARCH_CACHE_TTL_DAYS`（默认 30；范围 1–365）。淘汰在
知识存储打开时检查，只删除当前作用域内早于截止时间的行。调低可以获得更新鲜的数据和更
少的磁盘占用；调高可以更长久地保留历史。

### 更换模型：迁移

当配置的嵌入模型与已存向量的构建模型不一致时，知识存储按
`PI_RESEARCH_MIGRATION_STRATEGY` 迁移：

| 策略 | 会发生什么 |
|----------|--------------|
| `backup`（默认） | 旧表改名靠边（`knowledge_backup_<timestamp>.lance`），为新模型创建新表。旧数据保留在磁盘上但不参与搜索。 |
| `drop` | 丢弃旧表，创建新表。快；无备份。 |
| `re-embed` | 用新模型把每个已存文档重新嵌入到新表，保留历史。最慢。 |

如果 `re-embed` 失败，pi-research 回退到 `backup`。失败的 `backup`（或 `drop`）则会中止
迁移：知识存储保持在旧模型上，下次打开时重试 —— 除非显式选择 `drop`，数据绝不会被丢弃。
从 `/research-config` 菜单更换模型时，会先要求确认再清空当前知识存储、从零开始；拒绝
则撤销模型更改，知识存储保持不变。

### 管理知识存储

在 `/research-config` 中：

- 知识存储状态 —— 条目计数（项目与用户）、当前嵌入模型和设备、磁盘路径。
- 清空项目知识存储 / 清空用户知识存储 —— 永久删除项目级或全局行（按当前模式显示）。
- 运行健康检查 —— 检验浏览器进程池、GPU/嵌入、知识存储连通性，并报告知识存储的健康
  状态。

知识存储以写时复制方式增长（每次运行追加一个版本），因此每次改变了已存数据的运行
结束后都会自动压缩 —— 修剪过时版本和索引，保持有界。没有手动维护命令。

### 设置

| 设置项 | 变量 | 默认值 |
|---------|----------|---------|
| 知识模式（项目级） | `PI_RESEARCH_KNOWLEDGE_STORE_MODE` | `global` |
| 嵌入模型 | `PI_RESEARCH_EMBEDDING_MODEL` | `onnx-community/granite-embedding-small-english-r2-ONNX` |
| 嵌入设备 | `PI_RESEARCH_EMBEDDING_DEVICE` | `auto` |
| 缓存保留（天） | `PI_RESEARCH_CACHE_TTL_DAYS` | `30` |
| 迁移策略 | `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` |
| 数据库目录 | `PI_RESEARCH_KNOWLEDGE_DIR` | `~/.pi/research/knowledge_db` |
| 模型初始化超时（毫秒） | `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` |
| 重新探测 WebGPU | `PI_RESEARCH_WEBGPU_REPROBE` | _（未设置）_ |

完整配置模型见[配置](#configuration)；知识存储在引擎中的位置见[架构](#architecture)。
## 配置 {#configuration}

所有前端（pi 扩展、Claude Code 等技能兼容宿主运行的独立 CLI / 智能体技能，以及 SDK）
共享同一个配置模型。本文档先介绍 `/research-config` TUI 中暴露的设置，然后是完整的
环境变量参考，最后说明配置各层如何解析。

![/research-config 设置 TUI](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/04-config.gif)

### TUI 中的设置

在 pi 扩展中运行 `/research-config` 可打开交互式菜单。选中一个设置并按 `Enter` /
`Space` 循环切换其值；更改立即保存。（在无 TUI 的主机 —— RPC、web hub、print、JSON、
SDK —— 上，菜单无法渲染：`/research-config` 会说明原因，并改用这些主机上可用的无头
诊断 `/research-config health` 和 `/research-config knowledge-status`。在这些主机上，
设置仍然从环境和配置文件读取，`PI_RESEARCH_*` 变量照常生效。）设置写入以下两种作用域
之一：

- `[project]` —— 按工作目录保存在中央项目注册表中，因此某个仓库可以携带自己的值，
  而不影响全局默认值。
- 用户级 —— 保存到共享基础文件（`config.env`），适用于所有目录和前端，除非更高层级
  覆盖它。

| 设置项 | 作用域 | 取值 | 环境变量 |
|---------|-------|--------|---------|
| `/research` 深度 | 项目 | normal · deep · ultra | `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` |
| 知识模式 | 项目 | none · project · global | `PI_RESEARCH_KNOWLEDGE_STORE_MODE` |
| 研究员超时 | 用户 | 3 · 5 · 10 · 15 · 20 · 30（分钟） | `PI_RESEARCH_TIMEOUT_MS` |
| 最大并发 | 用户 | 1 – 5 | `PI_RESEARCH_MAX_RESEARCHERS` |
| 抓取批次 | 用户 | unlimited · 1 · 2 · 3 · 5 · 10 · 15 | `PI_RESEARCH_MAX_SCRAPE_BATCHES` |
| 自动导出报告 | 用户 | true · false | `PI_RESEARCH_REPORT_EXPORT_ENABLED` |
| 嵌入模型 | 用户 | 受支持的模型之一 | `PI_RESEARCH_EMBEDDING_MODEL` |
| 嵌入设备 | 用户 | GPU · CPU | `PI_RESEARCH_EMBEDDING_DEVICE` |
| 缓存保留 | 用户 | 7 · 14 · 30 · 60 · 90 · 180 · 365（天） | `PI_RESEARCH_CACHE_TTL_DAYS` |
| 调试日志 | 用户 | true · false | `PI_RESEARCH_DEBUG` |

嵌入设备在菜单里提供两个选项。GPU 对应自动检测路径：pi-research 会探测 WebGPU 是否
真的能在这台机器上运行，不能则回退到 CPU。CPU 强制仅 CPU 推理。原始强制 GPU（不探测）
只能通过环境变量 `PI_RESEARCH_EMBEDDING_DEVICE=webgpu` 触达，用于基准测试 —— 见
[知识存储文档](#knowledge-store)。

嵌入模型、嵌入设备、缓存保留这三行，只有在知识模式不是 `none` 时才显示。

菜单还提供一些不属于设置的操作：运行健康检查、知识存储状态、清空项目/用户知识存储、
会话指标、清空调试日志，以及安装 / 移除到外部智能体（编码智能体技能安装器）。浏览器
worker 数量刻意不进菜单 —— 它对 CPU/RAM 敏感，只能通过 `PI_RESEARCH_WORKER_THREADS`
设置。

### 环境变量

每个设置同时也是环境变量。仓库的
[`.env.example`](https://github.com/Lincoln504/pi-research/blob/main/.env.example)
是带行内注释的权威完整清单；本节对同一组变量做分类列举，附默认值和有效范围。超范围的
数值会被钳制（带警告）；无效的枚举值回退到默认值（带警告）。

TUI 暴露的变量标记为 `(TUI)`。`[project]` 标记表示项目级键（按目录保存在注册表中）；
其余都是用户级。

研究

| 变量 | 默认值 | 范围 | 说明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_TIMEOUT_MS`（TUI） | `300000` | 180000–1800000 | 单个研究员超时（3–30 分钟）。 |
| `PI_RESEARCH_MAX_RESEARCHERS`（TUI） | `3` | 1–5 | 并行研究员数。 |
| `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH`（TUI）`[project]` | `1` | 1–3 | 省略 `--depth` 时 `/research` 和 CLI 使用的深度（1=normal，2=deep，3=ultra）。 |
| `PI_RESEARCH_MAX_SCRAPE_BATCHES`（TUI） | `2` | 0–99 | 每个研究员的抓取批次（0 = 不限）。当已知解析出的研究模型启用了提示缓存（Anthropic API 模型，或显式配置为 Anthropic 风格缓存控制的路由）时，有效上限为该值加一 —— 已缓存的提示前缀让额外批次很便宜。 |
| `PI_RESEARCH_MAX_GATHERING_CALLS` | `12` | 1–100 | 每个研究员共享的网络收集调用数（`search` + `security_search` + `stackexchange` + `youtube_transcript`）。 |
| `PI_RESEARCH_MAX_CONCURRENT_SCRAPES` | `3` | 1–20 | 每个抓取批次中并发获取的 URL 数。 |
| `PI_RESEARCH_MAX_SCRAPE_URLS` | `8` | 1–20 | 每个抓取批次获取的 URL 数上限。超出上限的 URL 会列在 "Not Fetched — Over Batch Cap" 下，必须在后续批次中请求。（由硬编码常量提升而来，使其与其他抓取旋钮一样可通过环境/配置文件调节。） |
| `PI_RESEARCH_MAX_RETRIES` | `2` | 0–5 | 每项研究员请求的重试次数。 |
| `PI_RESEARCH_RETRY_DELAY_MS` | `2000` | 100–10000 | 重试之间的基础延迟。 |
| `PI_RESEARCH_MAX_FAILED_RESEARCHERS` | `2` | 1–10 | 中止整个运行的不重复研究员失败数。调高可以让较慢、仍在进行的研究员先跑完再放弃。 |
| `PI_RESEARCH_WORKER_THREADS` | `4` | 1–10 | 浏览器 worker 进程数。越高吞吐越大，CPU/RAM 占用越高。它决定一次搜索突发*以多快排空*，而不是*可以多大* —— 大于进程池的突发会排队等候，不会被裁剪或超时。 |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `2` | 1–10 | 每个 worker 进程的任务数。 |
| `PI_RESEARCH_MAX_CONCURRENT_RUNS` | `3` | ≥1 | 机器级并发研究运行上限，覆盖**每个**进程（CLI、智能体技能、pi 扩展、SDK）。超出上限的运行排队而不是失败。所有并发运行共享一个经领导者选举产生的浏览器/嵌入进程池，因此过度订阅会同时拖垮所有运行。 |
| `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS` | `600000` | ≥0 | 运行放弃排队、以"maximum concurrent research runs reached"失败之前，等待空位的时间（CLI 退出码 `75`）。`0` = 立即失败，不排队。 |
| `PI_RESEARCH_MODEL` | _（pi：会话模型；CLI/技能：必填）_ | — | 研究运行的模型。独立 CLI / 智能体技能**必填** —— 它们只用这一个配置的模型（绝不使用 pi 扩展内选中的模型），没有则拒绝启动（CLI 的按运行 `--model` 标志同样满足要求）。在 SDK 上，未给出 `model` 选项时选择会话模型。在 pi 扩展中，它覆盖研究员子智能体和知识综合，而协调者和研究负责人继续使用会话模型。接受 `provider/id` 或裸模型 id。 |
| `PI_RESEARCH_DISABLED_TOOLS` | _（无）_ | — | 逗号分隔、在一次运行中禁用的研究工具（`search`、`scrape`、`security_search`、`stackexchange`、`youtube_transcript`、`grep`、`read`）。从每个研究员的工具集中移除，并在协调者和研究负责人的提示词中点名。严格加法性 —— 只能移除能力，绝不会授予，并叠加在默认排除之上而不是替换。无法识别的名字不排除任何工具，只会告警，不会让运行失败。 |
| `PI_RESEARCH_REPORT_EXPORT_ENABLED`（TUI） | `false` | — | 前端把 Markdown 报告写入磁盘并显示其路径。 |
| `PI_RESEARCH_REPORT_EXPORT_DIR` | _（智能 cwd）_ | — | 把导出的报告固定到指定目录，绕过相对 cwd 的解析。对智能体技能尤为有用，它从宿主智能体的任意目录运行。 |
| `PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING` | `0.15` | 0.05–1.0 | 用于初始抓取上下文的上下文窗口最大比例。 |
| `PI_RESEARCH_AVG_TOKENS_PER_SCRAPE` | `2500` | 500–10000 | 每次抓取结果的估算 token 数，用于规划。 |

YouTube 字幕

| 变量 | 默认值 | 范围 | 说明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS` | `3` | 1–5 | 每次 `youtube_transcript` 调用转录的视频数。 |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_TIMEOUT_MS` | `20000` | 5000–120000 | 每个视频的字幕超时。 |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_LANG` | `en` | — | 首选字幕语言（BCP-47 前缀）。 |
| `PI_RESEARCH_YOUTUBE_QUERY_EVERY_N` | `5` | 1–100 | 大约每 N 个搜索查询附加一次 `youtube`（1 = 每个查询）。 |
| `PI_RESEARCH_YOUTUBE_POTOKEN_REQUEST_KEY` | _（内置）_ | — | 高级：覆盖 BotGuard PoToken 的 Web 请求密钥（只在 YouTube 轮换公钥、字幕开始失败时使用）。 |

超时

| 变量 | 默认值 | 范围 | 说明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_TIMEOUT_MS` | `300000` | 60000–1800000 | 协调者 / 研究负责人 / 修复 / 知识 LLM 调用超时。 |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | 5000–120000 | 每页抓取（页面加载）超时。 |
| `PI_RESEARCH_SEARCH_TIMEOUT_MS` | `45000` | 5000–120000 | 浏览器搜索页超时。 |
| `PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS` | `10000` | 2000–120000 | 叠加到每个浏览器操作自身超时上的余量（搜索任务上限为 `SEARCH_TIMEOUT_MS` + 此值 + 约 120 秒固定冷启动余量；抓取为 `SCRAPE_TIMEOUT_MS` + 此值 + 相同余量）。冷启动余量覆盖 worker 首次真正启动浏览器和创建上下文，不可由用户调节。这些上限约束的是**执行过程**：任务的时钟从 worker 接手时起算，因此排队等其他工作的耗时不计入；调高此值去覆盖繁忙进程池既无必要也无效。 |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `10000` | 2000–120000 | 预检健康检查超时。 |

LLM 输出与推理

下面是仅环境变量的高级旋钮（不在 TUI 中）。

| 变量 | 默认值 | 范围 | 说明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_THINKING_LEVEL` | `off` | off · minimal · low · medium · high | 引擎所有 LLM 工作的思维链等级（协调者、路由器、综合器、JSON 修复、知识抽取、研究员子智能体）。默认关闭 —— 这些调用输出结构化 JSON / 带引用报告，思维块只会消耗输出预算并可能截断回答。由 pi 按模型钳制。 |
| `PI_RESEARCH_PLANNING_MAX_TOKENS` | `16384` | 1024–131072 | 协调者计划的最大输出 token。路由器决策有自己的、更小的上限；最终综合使用 `PI_RESEARCH_SYNTHESIS_MAX_TOKENS`。按模型真实上限钳制。 |
| `PI_RESEARCH_SYNTHESIS_MAX_TOKENS` | `32768` | 1024–131072 | 最终综合报告的最大输出 token。按模型真实上限钳制。 |

知识存储

每个值的含义见[知识存储文档](#knowledge-store)。

| 变量 | 默认值 | 范围 | 说明 |
|----------|---------|-------|-------------|
| `PI_RESEARCH_KNOWLEDGE_STORE_MODE`（TUI）`[project]` | `global` | none · project · global | 知识存储作用域：所有目录共享一个（`global`）、限定当前目录（`project`）、或禁用（`none`）。与此设置无关，当必需包未安装（安装时跳过可选的 `@huggingface/transformers`、`@lancedb/lancedb` 损坏）时，知识存储干净地 OFF：init 快速失败而不是重试风暴，`pi-research knowledge-config`、`/research-config` 菜单和健康检查都会点名缺失的包和修复方法。 |
| `PI_RESEARCH_EMBEDDING_MODEL`（TUI） | `onnx-community/granite-embedding-small-english-r2-ONNX` | — | 嵌入模型。更换会清空知识存储并重新开始。 |
| `PI_RESEARCH_EMBEDDING_DEVICE`（TUI） | `auto` | auto · webgpu · cpu | 推理后端。`auto` 在进程外探测 WebGPU 可行性并回退到 CPU；`cpu` 强制 CPU；`webgpu` 强制 GPU 路径、不探测（高级 —— 在软件 GPU 上可能硬崩溃）。TUI 只暴露 `auto`（显示为"GPU"）和 `cpu`。 |
| `PI_RESEARCH_CACHE_TTL_DAYS`（TUI） | `30` | 1–365 | 缓存发现在被淘汰前保留多久。 |
| `PI_RESEARCH_KNOWLEDGE_STORE_MAX_SERVE_AGE_DAYS` | `0` | 0–3650 | 读取时缓存抓取可被*伺服*的最大年龄，超过则视为未命中并重新抓取。`0` = 禁用（在 TTL 内按任意年龄伺服）。无论此值如何，缓存年龄始终呈现给模型。 |
| `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` | drop · backup · re-embed | 嵌入模型变更时如何处理已存数据。 |
| `PI_RESEARCH_KNOWLEDGE_DIR` | _（自动）_ | — | 覆盖知识存储数据库目录。默认：`~/.pi/research/knowledge_db`。 |
| `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` | 10000–600000 | 嵌入模型初始化超时（首次下载可能较慢）。 |
| `PI_RESEARCH_WEBGPU_REPROBE` | _（未设置）_ | — | 设为 `1` 以丢弃缓存的 WebGPU 可行性结论，下次使用时重新探测。 |

API 密钥

| 变量 | 说明 |
|----------|-------------|
| `PI_RESEARCH_API_KEY` / `PI_RESEARCH_PROVIDER` | SDK / CLI 模式的显式 LLM 凭据（pi 配置提供密钥时不需要）。在 CLI / 智能体技能上，两者也可放在 `config.env` / `cli.env`。提供密钥时必须同时提供 provider，或从 `provider/model-id` 形式的 `PI_RESEARCH_MODEL` 推断。注意：provider 原生变量（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等）只作为**真实环境变量**才被认可 —— 放进 `config.env` / `cli.env` 无效（这些文件只桥接 `PI_RESEARCH_*` 键以及 `STACKEXCHANGE_API_KEY` / `GITHUB_TOKEN` / `NVD_API_KEY`）。 |
| `STACKEXCHANGE_API_KEY` | 把 Stack Exchange 工具的限额从 300/天提升到 10 000/天。在 <https://stackapps.com/apps/oauth> 申请。 |
| `GITHUB_TOKEN` | 把安全工具的 GitHub 公告限额从 60/小时提升到 5000/小时（任意默认作用域 token）。 |
| `NVD_API_KEY` | 把安全工具的 NVD 限额提升约 10 倍并收紧请求间隔。在 <https://nvd.nist.gov/developers/request-an-api-key> 申请。使用按严重性过滤的安全搜索时推荐设置：这类搜索会发出第二次（CVSS v2）NVD 查询以捕获仅 v2 的 CVE，这会让请求时间在未认证的 6 秒/请求限速下大约翻倍。 |

诊断与平台

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `PI_RESEARCH_DEBUG`（TUI） | `false` | 向日志文件输出 INFO+DEBUG 详细日志。注意：保存在 `config.env` 里的 `DEBUG=true` 行，只对发生过配置*保存*的进程可靠生效（保存会把它同步进环境；单纯加载不会）—— 要保证进程一启动就有详细日志，请在环境中导出 `PI_RESEARCH_DEBUG=true`。 |
| `PI_RESEARCH_CONSOLE_LOG` | `false` | 把日志镜像到 stdout/stderr（CI / 无头场景有用）。 |
| `PI_RESEARCH_LOG_PATH` | _（OS 临时目录）_ | 覆盖详细日志文件路径。浏览器 worker 自动继承。 |
| `PI_RESEARCH_LOG_FILE` | _（未设置）_ | 把浏览器 worker 线程日志发送到单独文件。未设置时，worker 记录到 `PI_RESEARCH_LOG_PATH`。 |
| `PI_RESEARCH_TMP_DIR` | `~/.cache/pi-research/profiles` | 每个 worker 的临时浏览器配置目录。默认落盘（保持在 RAM 上的 `/tmp` 之外，以免每个 worker 配置增加内存压力）。指到系统临时目录下可选用 tmpfs/RAM。 |
| `PI_RESEARCH_STATE_DIR` | `~/.pi/research/state` | 覆盖状态目录（活动会话、浏览器状态、项目注册表）。 |
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | `100` | TUI 刷新防抖（0–1000 毫秒）。 |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | _（未设置）_ | 设为 `1`/`true` 以跳过预检浏览器/嵌入健康检查，依赖按任务的超时。**仅深度 0（快速）** —— 深度 1–3 运行没有此类预检，因此此值对它们无影响。 |
| `PI_RESEARCH_PDF_WORKER` | _（未设置）_ | 设为 `off` 强制 PDF 解析在主线程执行（1.6.6 之前的行为），绕过 worker 线程卸载。针对 worker 或打包问题的应急开关；默认在其 bundle 存在时于 worker 中解析。 |
| `PI_RESEARCH_USE_XVFB` | _（未设置）_ | 仅 Linux。裸 TTY 运行是真正无头的，不需要 X 服务器；设为 `true` 可选用虚拟帧缓冲（`sudo apt install xvfb`）。 |
| `PI_RESEARCH_SKILL_DIR` | _（自动）_ | 覆盖技能安装器使用的随包研究技能源码目录。 |
| `PI_RESEARCH_PURGE_BROWSERS` | _（未设置）_ | 由随包 `scripts/cleanup.cjs` 读取：设为 `1` 同时删除共享的 camoufox 浏览器缓存（默认保留，因为其他安装可能使用）。注意 npm ≥7 不运行 `preuninstall`，因此该脚本在 `npm uninstall` 时不会触发 —— 见[智能体技能](#agent-skill)。 |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | _（未设置）_ | 在 `npm install` 期间设为 `1` 以跳过 camoufox 浏览器下载（改为首次使用时惰性获取；Playwright 标准约定）。 |
| `CAMOUFOX_INSTALL_DIR` | _（用户缓存）_ | camoufox-js 自己的变量，也是唯一能重定位浏览器的变量。它决定 pi-research 查找二进制的位置，并导出给 postinstall 抓取和浏览器 worker。在固定的 camoufox-js 0.12.0+ 上生效，它重新认可该变量；旧固定版本（<0.12，缓存目录硬编码在代码里）只重定位查找 —— 见[架构](#architecture)。 |
| `PLAYWRIGHT_BROWSERS_PATH` | _（用户缓存）_ | 上述变量的别名，为兼容而接受，并作为 `CAMOUFOX_INSTALL_DIR` 继续导出 —— 在 camoufox-js 0.12.0+ 上它重定位下载本身，与 `CAMOUFOX_INSTALL_DIR` 完全相同。 |
| `XDG_CACHE_HOME` | `~/.cache` | 标准 XDG 变量。设置后，下面所有 `~/.cache/pi-research/...` 路径改为扎根于 `$XDG_CACHE_HOME/pi-research/...`。 |
| `PI_RESEARCH_BIN`（别名 `PI_RESEARCH_PATH`） | _（自动）_ | 仅智能体技能启动器：需要绕过自动解析（PATH → 本地安装 → npx）时，指向 pi-research 引擎二进制的显式路径。见 [agent-skill/pi-research/references/configuration.md](../agent-skill/pi-research/references/configuration.md)。 |
| `PLAYWRIGHT_INSTALL_DEPS` | _（未设置）_ | 仅 Linux。在 `npm install` 期间设为 `true`，也会通过 `npx playwright install-deps` 安装系统库（等同于 `npm run install:system-deps`）。 |
| `PI_RESEARCH_STRICT_SETUP` | _（未设置）_ | 由随包 `scripts/setup.cjs` 在 `npm install` 期间读取。设为 `1`/`true` 让浏览器下载失败导致安装失败，而不是推迟到首次使用。 |
| `PI_RESEARCH_CONFIG_DIR_NAME` | `.pi` | 覆盖主目录下宿主配置目录的名称（高级；例如设置为共享另一个 harness 的配置根）。 |

仅测试 —— 生产环境切勿启用

| 变量 | 说明 |
|----------|-------------|
| `PI_RESEARCH_MOCK_SEARCH` | 返回伪造的搜索结果，而非真实网络数据。 |
| `PI_RESEARCH_MOCK_SCRAPE` | 返回伪造的抓取结果，而非真实页面内容。 |
| `PI_RESEARCH_FORCE_READY` | 绕过就绪检查，即使关键服务初始化失败也照常运行。**仅 pi 扩展** —— CLI、智能体技能和 SDK 不理会它。 |
| `PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE` | 允许抓取 **loopback** 地址（`127.0.0.0/8`、`::1`、`*.localhost`、`::ffff:127.x`），以便集成测试用真实浏览器和抓取流水线驱动本地服务器。刻意只限定 loopback：链路本地 `169.254.0.0/16`（云元数据）和 RFC1918 局域网段即使设置此值也保持封锁，请求时和连接时都封锁。 |

### 配置如何分层

配置按以下层级解析，优先级从低到高（后者胜出）：

```
内置默认值
  < ~/.pi/research/config.env                       （基础、共享；由 /research-config 编辑）
  < ~/.pi/research/{pi,cli}.env                      （可选的前端叠加层）
  < cwd 下遗留的 .pi-research.env                   （已废弃；自动迁移到注册表）
  < 项目注册表                                       （~/.pi/research/state/project-settings.json，按目录）
  < process.env                                      （真实 shell 环境始终胜出）
```

基础文件。`config.env` 保存你共享的用户级设置。`/research-config` TUI 只编辑这个文件
（以及项目注册表）—— 绝不编辑叠加层或合并视图 —— 因此叠加值永远不会被烘焙回基础文件。

前端叠加层。每个前端只读取自己的可选叠加层，叠加在共享基础层之上，因此可以独立配置。
恰好存在两个：

- `~/.pi/research/pi.env` —— pi 扩展
- `~/.pi/research/cli.env` —— 独立 CLI / 智能体技能（技能兼容宿主运行的界面）

叠加文件默认不存在；按需手动创建。刻意不存在 `sdk.env`：SDK 是从代码配置的库（见
[SDK](#sdk)），而不是从全局文件配置。

示例 —— 不改动 pi 扩展，只给独立 CLI / 智能体技能单独配置模型和深度：

```sh
# ~/.pi/research/config.env   （共享基线）
PI_RESEARCH_KNOWLEDGE_STORE_MODE=project

# ~/.pi/research/cli.env       （仅独立 CLI / 智能体技能）
PI_RESEARCH_MODEL=openrouter/anthropic/claude-sonnet-4-6
PI_RESEARCH_DEFAULT_RESEARCH_DEPTH=2
```

项目注册表。项目级设置（研究深度、知识存储模式）按目录保存在 `project-settings.json`
中，以归一化的工作目录路径为键。它们只对该目录覆盖基础层和叠加层。在 pi 扩展中由
`/research-config` TUI 写入。在独立 CLI 上可以直接按目录设置知识存储模式：

```sh
pi-research knowledge-config                       # 显示这里的模式及其来源
pi-research knowledge-config set <none|project|global>   # 只选一个值
```

在智能体技能下你不必自己运行 —— 直接让智能体去做（例如"在这里禁用知识存储" / "改成
项目作用域"），它会代表你运行同一个命令。无论哪种方式都会落入注册表（优先级在
`config.env` 之上），因此按目录的值会覆盖机器级 `config.env` 默认值；真实环境变量仍胜过
两者。

process.env。真实环境变量始终胜出。一次性覆盖，只为那个进程导出变量即可。

> 基础文件不会被你的 shell 自动加载。要么使用 `/research-config` TUI（它会写入），要么
> 在 shell 中导出变量，要么使用 direnv 之类的加载器。`.env.example` 是参考，不是生效的
> 配置文件。

### 提示缓存

一次研究运行会多次重发一个庞大且基本不变的提示：研究员在每个工具回合重发其整个对话
（包括每个抓取的页面），研究负责人过去则在每一轮重发累积的发现。每个 provider 都会按
输入价的一小部分从提示缓存伺服这种重复 —— 但只针对请求的**精确前缀**，且前提是前缀
之前没有可变内容。

pi-research 的做法。研究负责人被拆成两个角色，把重复内容*去掉*，而不是仅仅打折。
**路由器**每轮决定是否继续：只在它到达的那一轮完整读取每份报告，此后只读其简短覆盖
摘要，而不是重新读完此前收集的全部报告。**综合器**只在最后运行一次，是唯一完整读取
报告的调用。拆分之前，一个调用兼任两职，每轮重发整个语料，因此其输入随轮次数平方
增长。综合器的语料也会对照模型上下文窗口做预算：超预算时，报告以部分轮次缩减并合并，
而不是截断或拒绝。

路由器多久跑一次取决于轮次预算。深度 2 和 3 在除最后一轮外的每一轮路由。深度 1 的
基础预算为两轮，且最后一轮跳过，因此普通深度 1 运行从不路由 —— 但转向会提高预算
（最多额外两轮），被转向的深度 1 运行确实会路由。那也正是携带发现最多的深度 1 场景，
所以在摘要而非全语料上路由的意义最大。

此外，两个负责人提示都采用稳定内容置前的布局：只插值整个运行期间固定的值（复杂度、
团队规模、查询预算、已禁用工具），所有轮次间变化的内容 —— 根查询、轮次号、议程、已
执行查询、转向、轮次阶段指引 —— 都作为 `RUN CONTEXT` 块附加在后面。单元测试固定住
该布局；如果你编辑 `src/prompts/system-lead-router.md` 或
`src/prompts/system-lead-synthesizer.md`，请勿把轮次间变化的文本放进去。

你的 provider 怎么做，取决于 pi 对接的是哪个 API（`~/.pi/agent/models.json` 中 provider
的 `api` 字段），在 OpenAI 兼容端点上，还取决于一个 `compat` 键：

| Provider API | 行为 |
|--------------|-----------|
| `anthropic-messages` | pi 自动插入 `cache_control` 断点 —— 在系统提示、最后一个工具定义、最后一个用户/助手/工具结果块上。无需配置。 |
| `openai-completions` | 只要 `compat.cacheControlFormat` 为 `"anthropic"`，pi 就把**相同**的 Anthropic 风格断点插入 OpenAI 形状的载荷。自动检测只在一种情况下设置该键 —— OpenRouter 路由到 `anthropic/*` 模型 —— 因此默认不发送标记，而是依赖 provider 自身的隐式前缀缓存。该默认值对 OpenAI、DeepSeek、Gemini 和 GLM 是正确的，它们都做隐式缓存。 |
| `openai-responses` | 任何设置下都不发送标记；仅隐式缓存。 |

注意：标记行为由 `cacheControlFormat` 决定，**而非** `api` 字段 —— 设置该键会让
`openai-completions` provider 像 `anthropic-messages` 一样发出显式断点。阅读下面的计数器
时这一点很重要：在你这样配置的 provider 上，缓存读数为零并不能证明标记缺失。

缺口在于：需要显式标记、却经由 OpenAI 兼容端点触达、且不属于那一个自动检测场景的
provider。该类别中的任何对象（经由 OpenRouter 的 Qwen，或任何前置 Claude 的网关）都
**完全不做**缓存，无声无息、无报错。按 provider 用 `compat` 块修复：

```json
{
  "providers": {
    "openrouter": {
      "api": "openai-completions",
      "compat": {
        "cacheControlFormat": "anthropic",
        "sessionAffinityFormat": "openrouter",
        "sendSessionAffinityHeaders": true
      }
    }
  }
}
```

`cacheControlFormat: "anthropic"` 强制启用标记。对整个 provider 设置它是安全的：不使用
标记的模型会忽略额外字段。两个会话亲和键请 OpenRouter 把对话保持在预热了缓存的副本上；
没有它们，OpenRouter 会回退到哈希前几条消息，而智能体循环会改动这些消息。

`PI_CACHE_RETENTION=long`（pi 的变量，不是 pi-research 的）在 provider 支持时请求 1
小时保留。它把缓存写入倍率从 1.25x 提到 2x，因此只有在运行中调用间隔超过 provider 默认
窗口（名义上 5 分钟）时才划算。

启用前先测量。在 GLM 上经 `anthropic-messages` 的直接探测中，一个条目在**默认保留下
七分钟**后仍被原样读回，而 `long` 产生相同数字 —— 因此在该路由上，翻倍的写入倍率买不到
任何东西。名义上 5 分钟的数值是 provider 可以超越的下限，而不是可以按它规划的期限。

验证它是否生效。设置 `PI_RESEARCH_DEBUG=true` 并读取运行日志：每次 LLM 调用都会记录
`llm_cache_read_tokens_total` 和 `llm_cache_write_tokens_total`，附带 `llm_tokens_total`，
并按组件标注（`coordinator` / `router` / `synthesizer` / `researcher`）。多轮研究员上
缓存读数保持为零，意味着前缀没有命中 —— 通常是 provider 有最小可缓存前缀（通常
1024–4096 token），短提示达不到；或是显式标记 provider 缺少上面的 `compat` 块。计数器
缺失而非为零，表示 provider 根本不报告缓存。

缓存**写入**是两者中较弱的信号。多家 provider 报告读取却完全省略写入 —— OpenRouter
和 Z.ai 的 Anthropic 兼容端点都返回非零 `cache_read` 和平平为零的 `cache_write` ——
因此那里的零是正常的，对缓存是否工作不说明任何问题。请以读取计数器为准。

### 文件位置

所有 pi-research 状态都在自己的命名空间 `~/.pi/research/` 下：

| 路径 | 内容 |
|------|----------|
| `~/.pi/research/config.env` | 共享基础配置（用户级设置）。 |
| `~/.pi/research/{pi,cli}.env` | 可选的前端叠加层。 |
| `~/.pi/research/state/project-settings.json` | 项目注册表（按目录设置）。 |
| `~/.pi/research/state/` | 活动会话、浏览器状态、锁。 |
| `~/.pi/research/knowledge_db/` | 知识存储（LanceDB），除非设置了 `PI_RESEARCH_KNOWLEDGE_DIR`。 |
| `~/.cache/pi-research/profiles/` | 临时浏览器配置，除非设置了 `PI_RESEARCH_TMP_DIR`。设置 `XDG_CACHE_HOME` 时扎根于 `$XDG_CACHE_HOME`。 |
| `~/.cache/pi-research/webgpu-viability.json` | 缓存的 WebGPU 可行性结论（见知识存储文档）。设置 `XDG_CACHE_HOME` 时扎根于 `$XDG_CACHE_HOME`。 |

路径可通过 `PI_RESEARCH_STATE_DIR`、`PI_RESEARCH_KNOWLEDGE_DIR` 和
`PI_RESEARCH_TMP_DIR` 重定位。
## 架构 {#architecture}

pi-research 是 pi 的 TUI 扩展，用于多智能体网络研究。它运行在 pi 进程内，注册自己的
工具和命令，并管理自己的浏览器 worker 进程池、服务注册表和本地知识存储。一个引擎支撑
全部前端：除 pi 扩展外，它还以独立 CLI、可移植智能体技能（任何技能兼容宿主运行的同一
技能）和编程式 SDK（`src/sdk.ts`）的形式暴露。

```
pi CLI
└── pi-research 扩展（src/index.ts）
    ├── 已注册工具   research、health、research_knowledge_search（始终注册；知识存储禁用时说明原因）
    ├── 命令         /research、/research-config、/knowledge-store
    ├── 事件         input（运行中途转向）、session_shutdown（清理）、session_before_compact / session_compact、before_agent_start、after_provider_response
    └── 分层
        ├── 编排      快速/深度研究协调
        ├── 智能体工具  search、scrape、youtube_transcript、security_search、stackexchange、grep、read
        ├── 基础设施   浏览器进程池、知识存储、状态管理器
        └── 核心       服务注册表、调度器、健康检查
```

1. 查询经由 `runResearch` —— 唯一的内部入口 —— 进入，并携带深度。调用方用自然语言
   表述请求：当 `research` 工具在会话内被调用时，调用智能体根据用户措辞和任务复杂度
   选择深度（1–3），由其工具的使用提示词（`src/prompts/research-tool-usage.md`）引导。
   CLI 和 SDK 调用方显式传入深度。
2. 深度 0 走快速路径；深度 1–3 走深度路径（见下）。pi 扩展的工具和 TUI 限制在 1–3 级；
   CLI、SDK 和智能体技能可以传 0。
3. 在深度路径上，协调者规划研究轨道并执行一轮初始搜索突发，然后把一组结果 URL 交给
   每位研究员作为起点。
4. 研究员通过抓取工具抓取并阅读这些页面，返回带引用的报告。它们只考虑本次会话抓取
   到的内容。
5. 研究负责人的**路由器**审查该轮：要么再跑一轮，要么结束循环；随后其**综合器**基于
   收集到的全部报告写出最终报告。
6. 结果作为一份带引用的 Markdown 报告返回；被引用的 URL 和它们的摘要进入知识存储队列，
   供未来运行使用。

### 编排

`runResearch`（`IResearchOrchestration`，实现在
`src/orchestration/research-orchestration-service.ts`）是唯一的内部入口。它按深度分发。

深度 0 —— 快速（`QuickResearchOrchestrator`）：单个研究员带全部工具直接运行；没有
协调者、没有规划阶段、没有轮次。深度 0 只能通过 SDK（`runQuickResearch`）或 CLI
（`--depth 0`，智能体技能可以传）触达。pi 扩展的 `research` 工具最低深度为 1，因此
会话内的智能体永远无法请求快速模式。

深度 1–3 —— 深度（`DeepResearchOrchestrator`）：运行按**轮次**推进。一轮是"协调 → 研究
→ 路由"的一个循环：该轮议程先被规划（第 1 轮由协调者，此后由研究负责人的**路由器**），
一批**研究员**并行执行，然后路由器决定再跑一轮还是结束循环。两个限制彼此独立：一轮
*之内*跑多少研究员，以及整个运行最多多少轮。

研究负责人是两个角色，而不是一个调用身兼两职。路由器只做决定：它在报告到达的那一轮
完整读取每份报告，此后只读该报告简短的覆盖摘要，因此它的输入随团队规模增长，而不是
随轮次数的平方增长。**综合器**恰好运行一次，在最后，完整读取每份报告并写出报告 ——
受从模型上下文窗口推导出的语料预算约束，语料放不下时以部分轮次缩减并合并。两个提示词
是 `src/prompts/system-lead-router.md` 和 `system-lead-synthesizer.md`。

| 深度 | 标签 | 每轮研究员数（上限） | 轮数（上限） |
|-------|--------|-----------------------------|--------------|
| 1     | normal | 2                           | 2            |
| 2     | deep   | 3                           | 3            |
| 3     | ultra  | 5                           | 3            |

这些是上限，不是目标：协调者和路由器按主题需要决定用多少研究员和轮次。例如，深度 2
运行最多可以在各 3 轮中每轮起 3 个研究员。排队中的转向消息（Alt+Enter）可以解锁上限
之外的几轮额外轮次（`MAX_EXTRA_ROUNDS_WITH_STEERING`）。

协调者还执行初始搜索突发，并把其结果 URL 分发到第 1 轮的研究员
（`distributeSearchResults`），因此深度模式下研究员自己不会调用 `search`。

LLM 调用约定。协调者、路由器、综合器、JSON 修复和知识抽取调用都经过
`completeSimple`（`src/core/llm/pi-ai-completion.ts`），配 `buildSafeOptions`
（`src/core/llm/llm-utils.ts`）；研究员子智能体经 `createAgentSession` 创建。有两条
约定：

- 思维（thinking）默认关闭。这些调用输出结构化 JSON 或带引用报告，思维链块只会消耗
  输出 token 预算（并可能截断回答）。`PI_RESEARCH_LLM_THINKING_LEVEL`（默认 `off`）
  控制它，并按 provider 钳制。
- 输出预算按角色设置，并钳制到模型上限：`PLANNING_MAX_TOKENS` 用于计划/决策，
  `SYNTHESIS_MAX_TOKENS` 用于最终报告。轮中评估无法解析时，会继续现有议程而不是提前
  收尾，因此解析失败永远不会截断运行。

### 工具清单

这是系统在两套界面上暴露的全部工具的权威清单。

**面向宿主的工具** —— 注册到 pi 会话（`src/index.ts`），供调用智能体调用：

| 工具 | 用途 |
|------|---------|
| `research` | 运行一次完整的多来源研究会话，返回带引用的 Markdown 报告 |
| `research_knowledge_search` | 知识存储的即时本地搜索 —— 在实时研究之前检查；始终注册，知识存储禁用时说明原因 |
| `health` | 验证系统状态（浏览器进程池、知识存储、GPU 锁）；可选活性探测 |

**研究员智能体工具** —— 每个研究员子智能体使用的固定工具集（`src/tools/index.ts`）。
`search`、`security_search`、`stackexchange` 和 `youtube_transcript` 共享每阶段 12 次
收集调用的预算（`MAX_GATHERING_CALLS`）；`scrape` 和本地 `grep` 有自己的预算：

| 工具 | 快速 | 深度 | 后端 |
|------|-------|------|---------|
| `search` | ✓ | — | 经隐身浏览器的 DuckDuckGo Lite |
| `scrape` | ✓ | ✓ | 经隐身浏览器的批量页面抓取 → Markdown（每次调用最多 MAX_SCRAPE_URLS 个 URL，默认 8） |
| `youtube_transcript` | ✓ | ✓ | 经 youtubei.js + BotGuard PoToken 的 YouTube 字幕（默认 ≤3 个视频，可配置 1–5；每位研究员一次调用） |
| `security_search` | ✓ | ✓ | NVD、CISA KEV、GitHub 公告、OSV |
| `stackexchange` | ✓ | ✓ | Stack Exchange 网络 |
| `grep` | — | — | 本地 ripgrep（来自 pi-coding-agent）—— 始终排除，见下 |
| `read` | ✓ | ✓ | 本地文件读取（来自 pi-coding-agent） |

深度研究下 `search` 被排除 —— 协调者执行搜索突发并直接分发 URL。

`grep` 在**所有**深度和所有前端（CLI、SDK、智能体技能、pi 扩展）都被排除：这是网络
研究，一个能力强的模型否则会把回合浪费在搜索本地文件系统上。两个排除面 —— `excludeTools`
列表（CLI 上为 `--exclude-tools`，扩展里为 `excludeTools` 工具参数）和
`PI_RESEARCH_DISABLED_TOOLS` —— 在这个默认之上严格加法：只能移除能力（见
[配置](#configuration)）。1.3.10 之前，非空 `excludeTools` 列表会替换默认值，因此点名
任何其他工具都会悄悄重新启用 `grep`。

研究员不能写文件、不能运行 shell 命令，也不能触达这些工具之外的网络。

### 浏览器基础设施

所有浏览器工作（搜索、抓取、健康检查）都经过 poolifier 的 `FixedClusterPool` worker
进程池 —— 每个 worker 是一个 Node.js 子进程，运行自己的 camoufox（隐身 Firefox）实例。
把浏览器隔离在 worker 中意味着，一个 worker 崩溃不会拖垮编排器或其他会话。

```
BrowserTaskScheduler
└── FixedClusterPool（poolifier）
    ├── Worker 1  →  camoufox 实例
    ├── Worker 2  →  camoufox 实例
    └── Worker N  →  camoufox 实例
```

关键文件：
- `src/infrastructure/browser/browser-task-scheduler.ts` —— 把任务分发到进程池
- `src/infrastructure/browser/thread-worker.ts` —— worker 入口（由 esbuild 单独打包）
- `src/infrastructure/browser/thread-worker-messaging.ts` —— IPC 协议
- `src/infrastructure/browser/config.ts` —— 进程池配置、二进制路径检测

### 知识存储与数据处理

知识存储是既往发现的本地 LanceDB 向量表。它是可选的（没有它研究照常工作），完全由
编排器驱动 —— 研究员从不直接调用它：

- 每位研究员开始前，编排器按该研究员的目标搜索知识存储，并把匹配的历史 URL（带摘要）
  作为起点注入其提示词。
- 运行后，被引用的 URL 和它们的描述进入异步写入队列并后台存储 —— 写入从不阻塞运行。

摄入时，每条来源的摘要和完整抓取 Markdown 被切分成文本块并嵌入为向量。页面内容哈希
（SHA-256）对重复摄入的 URL 去重：未变的页面跳过，有变化的页面替换旧行。每行携带向量、
归一化 URL、文本和完整内容、时间戳，以及查询时过滤的作用域标志（项目 vs 全局）。

```
WriterQueue（异步、非阻塞）
└── KnowledgeStore
    ├── Embedder（经 @huggingface/transformers 的 onnx-community/granite-embedding-small-english-r2-ONNX）
    │   └── 后端：auto（进程外 WebGPU 探测 → webgpu 或 cpu）/ webgpu / cpu
    └── LanceDB（knowledge_db/ 目录，Arrow 支撑的向量表）
```

关键文件：`src/knowledge/store.ts`（LanceDB 操作）、`embedder.ts`（模型加载 + 批量
推理）、`writer-queue.ts`（异步写入 + 内容哈希去重）、`chunker.ts`（切分）、
`webgpu-viability.ts`（进程外 GPU 探测 + 缓存结论）、`migration.ts`（迁移策略类型 ——
drop / backup / re-embed 逻辑本身在 `store.ts`）。

知识存储需要原生 ONNX runtime 和 LanceDB 绑定。在没有预编译二进制的平台上 —— 尤其是
Intel macOS（`darwin-x64`）—— 它缺席：健康检查报告"已禁用但健康"，研究在无缓存下照常
运行。完整子系统和平台矩阵见[知识存储](#knowledge-store)。

### 服务与生命周期

服务以异步工厂函数注册，通过注册表（`getService()`）解析，init 时接好依赖，可按需或
立即初始化。

```typescript
registerService(ServiceNames.FOO, async () => {
  const dep = await getService<IBar>(ServiceNames.BAR);
  return new FooService(dep);
}, { lazyInitialization: true });

const foo = await getService<IFoo>(ServiceNames.FOO);
```

持有资源的服务实现 `dispose()`；注册表按依赖逆序释放它们。通过注册表解析（而非直接
import）强制生命周期纪律（init → 使用 → dispose），并让测试可以替换 mock。

- 核心（`src/core/`）：`PlanningService`、`SchedulerService`
- 基础设施（`src/infrastructure/`）：`StateManagerService`、`KnowledgeStoreService`、
  `MetricsService`、`WorkerPoolManager`、`FileLockService`、`GPUResourceService`（另有
  `WriterQueue`，定义在 `src/knowledge/`，在此注册）
- 编排（`src/orchestration/`）：`ResearchOrchestrationService`、
  `ResearchSessionService`、`ResearchSynthesisService`

跨会话、跨进程的状态（活动会话、浏览器状态、指标）在 `StateManagerService`
（`src/infrastructure/state/`）中，它用基于文件的锁（`FileLockService`）序列化并发写入。

### 并发运行（运行上限）

一台机器上的每个 pi-research 进程 —— CLI、智能体技能、pi 扩展、SDK —— 共享一个经
领导者选举产生的浏览器进程池和一个嵌入模型。让无上限的研究运行涌向那个共享进程池，
并不会优雅地拖慢运行；它会饱和优先级队列，同时拖垮*所有*运行。

因此 `ResearchRunSemaphore`（`src/infrastructure/research-run-semaphore.ts`）给每次
`runResearch()` 入口加上 N 个槽位的闸门，槽位实现为状态目录中 N 个众所周知的锁文件，
由同一个 `FileLockService` 协调。因为槽位所有权记录为 PID + 进程启动时间，崩溃运行
持有的槽位会在下次获取时立即被回收，而*存活*的持有者绝不会被抢走 —— 一个合法运行会
持有槽位数分钟，抢走它就等于放进了上限本要阻止的第 (N+1) 个运行。

超出上限的运行**排队**而不是失败：获取会轮询直到槽位释放，并通过观察器宣布一次
（`onRunQueued`，CLI 显示为 `• queued: …`），让等待中的运行绝不被误认为卡死。只有整
个排队窗口内都没有槽位释放，才抛出 `ResearchRunCapacityError` —— 一种临时状况，CLI
以退出码 `75` 报告，与崩溃区分开。上限在内部或 IO 出错时*开放*失败，因此信号量自身的
故障永远不会阻止研究运行。上限和排队窗口都可配置（`PI_RESEARCH_MAX_CONCURRENT_RUNS`、
`PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS`）。

### TUI

实时进度面板使用 `@earendil-works/pi-tui`，它处理终端状态（键盘协议、鼠标追踪、括号
粘贴）。stdio 捕获（防止杂散输出破坏面板，并保证干净退出）在
`src/utils/stdio-capture.ts`。

### 项目结构

```
src/
├── index.ts              扩展入口（工具、命令、事件、生命周期）
├── cli.ts                独立 CLI 入口
├── sdk.ts                编程式 SDK（非扩展用途）
├── config.ts             环境变量解析、校验、单例
├── constants.ts          团队规模、轮次上限、工具预算、批次上限
├── logger.ts             结构化日志（JSONL、TUI 安全）
├── tool.ts               research + health 工具定义的再导出桶文件
├── research-config.ts    /research-config TUI
├── core/
│   ├── llm/              prompts、模型解析、智能体 JSON 修复、日期注入
│   ├── interfaces/       抽象契约（观察器、规划、编排）
│   ├── planning-service.ts, scheduler-service.ts
│   ├── service-registry.ts, service-interfaces.ts, service-initialization.ts
│   └── planning-utils.ts
├── infrastructure/
│   ├── browser/          worker 进程池、任务调度器、IPC、camoufox 配置
│   ├── state/            状态管理器、会话跟踪、指标收集器
│   ├── embedding/        本地嵌入服务管理
│   ├── knowledge-store-service.ts, metrics-service.ts, file-lock-service.ts
│   └── process-lifecycle-service.ts
├── orchestration/
│   ├── deep-research-orchestrator.ts, quick-research-orchestrator.ts
│   ├── research-orchestration-service.ts, research-synthesis-service.ts
│   ├── research-session-service.ts, session-state.ts, session-context.ts
│   ├── researcher-executor.ts, researcher.ts, headless-observer.ts
├── prompts/              所有智能体的 Markdown 提示词模板
├── tools/                search, scrape, youtube_transcript, security, stackexchange, grep, read, knowledge-search
├── knowledge/            embedder、store、writer queue、chunker、migration、webgpu 探测
├── web-research/         DuckDuckGo 搜索、抓取器、重试逻辑
├── security/             NVD、CISA KEV、OSV、GitHub Advisory 客户端
├── stackexchange/        Stack Exchange API 客户端
├── youtube/              YouTube 字幕客户端（InnerTube + BotGuard PoToken）
├── skill-install/        面向编码智能体 harness 的研究技能安装器
├── tui/                  面板、布局、控制器、波形动画、终端工具
├── healthcheck/          健康检查注册表和检查项
├── cleanup/              研究结果清理
├── observers/            研究观察器实现
├── types/                共享索引与 TUI 类型
└── utils/                熔断器、文本工具、共享链接、指标、错误追踪
```

### 关键设计决策

只读研究员 —— 研究员智能体被限制在上面的工具集内。它们不能写文件、不能起进程、不能做
任意网络调用。它们*可以*读文件：`read` 已注册，研究员的排除列表（`bash`、`write`、
`edit`、`repl`、`git`、`terminal`）不覆盖它。本地 `grep` 已注册但始终排除（见工具表）。
传给 `read` 的 `cwd` 是解析基准，不是牢笼 —— 绝对路径解析到自身 —— 因此边界是"不可
变更"，而不是"仅此目录"。

worker 进程池优先于直接浏览器 —— 浏览器进程隔离在 worker 中，一个崩溃不会影响编排器
或其他会话。

固定浏览器技术栈 —— `playwright-core` 和 `impit` 固定到精确版本，`camoufox-js` 固定到
其 `0.12.0` 线；三者耦合，一起升级，因为每个浮动范围都曾破坏全新消费者安装，而我们的
lockfile 掩盖了问题。playwright-core 保持在 `1.60.0`（1.61+ 拒绝 camoufox 的 Juggler，
导致每次启动都失败 —— 上游可佐证：camoufox-js `0.12.0` 声明
`peerDependencies: { "playwright-core": "<1.61.0" }`，与这个手工持有的边界一致）。`impit`
精确在 `0.14.4`（2026-08-30 随 camoufox 升级从 `0.13.0` 刷新）—— 之所以精确，是因为
npm 的 `overrides` 不会传播给消费者，精确固定是在下游强制版本的唯一方式；impit 的
`only-allow pnpm` 预安装守卫事故（0.13.1/0.14.0，0.14.1 移除）就是这里不信任浮动范围的
原因。完整理由：`src/infrastructure/browser/thread-worker-browser.ts`。

0.10.x→0.12.0 的 camoufox 升级曾因三个阻塞项被推迟了两个刷新周期，现已全部解决：
camoufox 在 `v152.0.4-beta.26`（2026-07-16）恢复了 Windows 二进制；impit 的 pnpm 守卫
只存在于 0.13.1/0.14.0；camoufox-js 0.12 升级到 better-sqlite3 13，起初看起来要求每次
安装都带 C++ 工具链。在 13.0.3 上实测：全部八对平台/架构的 `prebuilds/` 都打包在
tarball *内部*，经 node-gyp-build 在运行时加载 —— 没有安装脚本，消费者无需审批任何
东西。真正坏的是工具链而不是绑定：npm ≤11 注入的 `node-gyp rebuild` 不必要地重编译
一个没有安装脚本的 binding.gyp（而它的 node-gyp 11.2 检测不到 VS2026 CI runner 镜像），
这正是 CI 跑 npm 12 的原因。今后任何升级都先查 better-sqlite3，而不是 camoufox。

相反，浏览器**二进制**不固定，也无法固定。`camoufox-js fetch` 不接受版本参数：它从新到
旧遍历 `daijro/camoufox` 的 GitHub releases，取第一个带本 OS/架构资产的非预发行 release。
因此消费者拿到什么二进制，取决于安装时 camoufox 最新发布了什么，与安装了哪个
camoufox-js 版本无关 —— npm 固定不冻结它，未来某个 camoufox release 可能在我们没有任何
改动的情况下破坏全新安装的启动。事实上 Windows 资产从 `v146-hardware` 到
`v152.0.2-alpha` 一直缺失，在 `v152.0.4-beta.26`（2026-07-16）回归。当前最新是
`v152.0.4-beta.28`（Firefox 152）；它在 playwright-core `1.60.0` 下启动顺畅、驱动
正常，已直接验证，现存缓存中可能仍持有的较老 `v135.0.1-beta.24` 也一样。实际含义是：
浏览器新鲜度独立于 npm 固定 —— 过时的 `camoufox-js` 不代表过时的 Firefox。升级这套
技术栈时务必重新验证真实启动 —— 单元和集成测试都 mock 浏览器，抓不到 Juggler 不匹配。

固定数据技术栈 —— `apache-arrow` 是 `21.1.0` 的直接依赖，`overrides` 把整棵树强制到
这一个版本，让 LanceDB 和 Arrow 共享同一个 Arrow 实例（版本不匹配的 Arrow 副本无法
互操作 —— 一方构建的数组会被另一方拒绝）。这位于 `@lancedb/lancedb` 0.37 声明的 Arrow
peer 上限（`>=15.0.0 <=18.1.0`）之上 —— 没有 override，npm 根本不会解析这个组合 ——
并且已验证可用，但每次升级 `@lancedb/lancedb` 都应重新验证。

`21.1.0` 精确是出于实测原因，不是谨慎。把看似 patch 的 minor 升到 `21.2.0` 直接破坏
知识存储：LanceDB 的 Rust 侧 Arrow 读取器无法解析 Arrow 21.2 写入的 schema，每次打开
表都失败，报 `Failed to read IPC file: Arrow error: Parser error: Unable to get root as
footer: RangeOutOfBounds … UnionVariant { variant: "Type::FixedSizeList" }` —— 56 个单元
测试和 36 个集成测试，凡是碰真实表的都挂。不要把这个范围当 caret 安全。另请注意，
`@lancedb/lancedb` 到 0.37 为止的每个 release 都声明同样的 `<=18.1.0` Arrow 上限，
因此升级 LanceDB 并不能消除 override；只会改变需要重新验证的组合。

固定校验库 —— `typebox` 固定到 pi 宿主包依赖的精确版本（`@earendil-works/pi-ai`/
`@earendil-works/pi-coding-agent` 在 0.84.x 线上固定 `1.3.7`）。每个工具的参数 schema
都在这里用 TypeBox 构建，跨边界交给 pi 的工具系统，因此两者必须在
`Value.Check`/`Convert` 语义上一致。浮动范围 `^1.1.38` 曾让全新消费者安装把 pi-research
解析到比 pi 更新的 TypeBox，发布了一个未经测试的跨版本组合；精确固定让 pi-research
与 pi 校验所用的版本一致。要与 pi 宿主同步升级，不要单独升。（`undici` 相反，跟随宿主的
major —— 宿主在 undici 8 上，pi-research 只用稳定的 `Agent` 连接器 API，所以跟随 `^8`。）

瞬态失败弹性 —— 每次 LLM 调用都是流式端点上的潜在单点故障，可能在响应中途断开
（undici 把它呈现为 `terminated`）。协调者和研究负责人的调用以有界指数退避快速重试
瞬态传输失败（socket 中止、5xx、429、provider 过载）—— 镜像按研究员重试
（`PI_RESEARCH_MAX_RETRIES`）—— 若仍然失败，则降级到确定性兜底计划而不是中止运行。
应用级 LLM 超时不重试（它已花掉全部预算）；直接降级。重试次数是内部常量，不是配置项。

注册表优先于直接 import —— 服务通过注册表注册和解析，以支持测试（mock 替换）并强制
init → 使用 → dispose 生命周期。

纯 ESM —— 代码库是 ES Modules（`"type": "module"`）。worker bundle 在集成测试或发布
前用 esbuild 构建（`npm run build:worker`）。

强制边界 —— `docs/deps.svg` 在每次 push 时重新生成（madge），架构规则由
dependency-cruiser（`config/tooling/dependency-cruiser.cjs`）强制执行。

### 技术栈

浏览器与抓取

- [Camoufox](https://camoufox.com) —— 隐身 Firefox（经 [Playwright](https://playwright.dev)
  驱动），用于不被检测的搜索和抓取
- [poolifier](https://github.com/poolifier/poolifier) —— 浏览器 worker 背后的 worker
  进程池
- [html-to-markdown](https://github.com/kreuzberg-dev/html-to-markdown) —— 把抓取的 HTML
  转成 Markdown（node-html-markdown 作为纯 JS 兜底）
- `pdf-oxide-wasm` —— PDF 文本提取（Rust/WASM）

知识存储与嵌入

- [Transformers.js](https://github.com/huggingface/transformers.js) —— 本地嵌入推理
  （模型经 ONNX Runtime 执行）
- Google [Dawn](https://dawn.googlesource.com/dawn) —— WebGPU 后端，经 `webgpu` Node
  绑定访问
- [LanceDB](https://lancedb.com) —— 磁盘向量数据库
- [Apache Arrow](https://arrow.apache.org) —— 向量表构建其上的列式 schema

YouTube 字幕

- [youtubei.js](https://github.com/LuanRT/YouTube.js) —— YouTube 内部 API 客户端
- [BgUtils](https://github.com/LuanRT/BgUtils) —— BotGuard PoToken 生成
- [jsdom](https://github.com/jsdom/jsdom) —— 铸造 PoToken 的 DOM 环境

宿主与运行时

- [pi](https://github.com/earendil-works/pi) —— 宿主运行时、智能体 SDK 和 TUI 工具包
- [TypeBox](https://github.com/sinclairzx81/typebox) —— 运行时配置 schema 与校验

### 开发

```bash
npm run test:unit         # 单元测试，无需浏览器
npm run test:integration  # 需要 camoufox（仅可选的虚拟显示测试需要 Xvfb）
npm run type-check        # TypeScript 严格模式（src）
npm run type-check:tests  # TypeScript 严格模式（tests）
npm run type-check:native        # 在 TS7 原生编译器上跑同样的检查（固定；约快 9 倍）
npm run type-check:native:tests  # TS7 原生检查，测试项目
npm run lint              # ESLint
npm run deps:check        # 架构规则执行
npm run build:worker      # 打包浏览器 worker（集成测试 / 发布前必需）
```
