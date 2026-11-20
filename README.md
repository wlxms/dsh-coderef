# dsh-coderef（原型，方案 1）

把助手消息里的 **`**Type**` / `**Type.member**`** 以及**行内代码里的路径/符号**（如
`AssistantNodeView.tsx:14-18`、`lib/index.js:1216`）识别为代码引用：Host 半先读**会话自己的工具证据**
（grep/read 结果里已经有 `path` + `Line N:`），解析成 `file:line`，再兜底工作区索引；Client 半
**影子覆盖** `conversation.chat.node[assistant-step]` 渲染器，在消息收尾后把命中的加粗文本改写成
inline code，并把行内代码 token 的 `fileMentions` resolver 换成自己的实现 —— 点击引用时**总是先**在右侧栏
打开文件并高亮目标行（ping），**然后**再 best-effort 调 Host `/coderef/open` 尝试打开 IDE；两者不互斥，
IDE 打不开也不影响侧边栏跳转。

> 当前 profile 实际使用 **fork renderer**（`../dsh-coderef-renderer/`）：**左键只在 DSH 窗口打开文件**，
> 右键菜单只剩「在资源管理器中打开 / 复制路径」，不再提供外部 IDE 选项（Host 的 `/coderef/open`
> 仅保留给旧 client 兼容）。下面的“点击顺序”描述的是旧 client v0.0.6 的行为，
> 新交互见 renderer README。

> 方案 1 = "上游导出原渲染器 + 插件影子占位后渲染原组件、只替换输入"。
> 本目录是双半插件本体；DSH 源码侧只需要一行导出（见下文"已修改的宿主文件"）。
>
> 同仓还有一个 **renderer 版（fork）**：`../dsh-coderef-renderer/` —— 影子接管 `assistant-step`
> （priority -100），并把宿主原生 `MarkdownText` 管线 fork 进插件（mdast GFM + 流式增量 +
> `render.tsx`），在 `inlineCode` / `strong` / `link` 节点层接 coderef chip，复用本插件的
> `/coderef/*` Host 路由；不需要宿主导出补丁，源码构建与打包桌面版都能加载。
> 当前 `.dsh-home` profile 同时装了 `dsh-coderef` 与 `dsh-coderef-renderer`，渲染由 fork 接管、
> 解析仍走本目录的 Host 半。详见 [renderer README](../dsh-coderef-renderer/README.md)。

## 目录

```text
dsh-coderef/
├─ lib/index.js          Host 半：会话证据账本 + 符号索引 + resolve/open/health/debug/refs 路由
├─ lib/references.js     引用收集分析器：session 事件 → 文件/URL/符号/助手建议命令 ledger + visible 投影
├─ lib/client.js         Client 半：ModuleLoader 包，影子 assistant-step + 文本改写 + mention resolver
├─ cordis.patch.yml      profile bundle patch：插入 coderef 行
├─ package.json          dsh.bundle.patch + dsh.client.platform=web
├─ dsh.plugin.json
└─ test/
   ├─ host-smoke.mjs     证据解析/成员作用域/re-export/索引/路由/IDE argv 冒烟
   ├─ client-smoke.mjs   影子注册、候选过滤、文本改写、resolve item 投影、缓存、点击回退冒烟
   ├─ references-smoke.mjs 引用收集器：conversation/grep/read/web fold、URL canonical、增量幂等
   ├─ smoke.mjs          以上两个
   ├─ resolution-eval.mjs 离线评测：解会话日志 → 证据/引用/索引三层解析 → 命中率基线
   ├─ e2e-check.mjs      CDP 驱动 headless Chrome：打开会话，断言引用按钮与 title 来源
   └─ browser-smoke.mjs  CDP 驱动 headless Chrome：真实浏览器里确认 Client 半加载 + 0 console 错误
```

## 已修改的宿主文件（方案 1 的"一行导出"）

- `D:\dsh-mydsh\deepseek-harness\packages\client\ui-chat\src\client\index.ts`
  末尾新增：
  ```ts
  export { AssistantNodeView } from './chat/AssistantNodeView.tsx'
  ```
- 重建产物：`packages/client/ui-chat/lib/client.js`（tsdown 单包重建，已含 `exports.AssistantNodeView`）。
- 原始文件备份在 `.backup/`（`ui-chat-client.js.before-coderef`、`ui-chat-src-client-index.ts.before-coderef`、`ui-chat-build.log`）。
- 回滚：把备份复制回去，或对 source 文件 `git checkout` 后重新执行
  `cd packages/client/ui-chat && <repo>/node_modules/.bin/tsdown`。
- 宿主源码升级/重建后，这行导出会丢，需要重新打补丁 + 重建（脚本见 `.backup` 日志中的命令）。

## 本地运行（已配置好一个隔离 DSH_HOME）

原型使用**工作区内**的隔离 home：`D:\dsh-mydsh\dsh-coderef\.dsh-home`，不触碰桌面版 DSH 的配置。

- profile：`.dsh-home/profiles/web`
  - `package.json`：bundles 追加 `dsh-coderef`，依赖 `dsh-coderef: link:../../../dsh-coderef`
  - `node_modules/dsh-coderef` → junction 指向本目录
- 启动（二选一）：

```powershell
# 方式 A：脚本
D:\dsh-mydsh\dsh-coderef\dsh-coderef\run-local.ps1

# 方式 B：命令行（服务会打印带 token 的 URL）
$env:DSH_HOME='D:\dsh-mydsh\dsh-coderef\.dsh-home'
cd D:\dsh-mydsh\deepseek-harness
& 'C:\Program Files\nodejs\node.exe' 'apps\cli\lib\bin.js' web --port 3080
```

首次在**新 shell**里启动如果报 `dsh: initialized profile ...` 或权限错误，直接重跑一次即可
（profile 模块回退 junction 已由首次启动创建好）。

## 在 GUI 里验证

1. 打开服务打印的 URL（形如 `http://127.0.0.1:3080/?token=...`）。
2. 新 profile 没有配置模型：在 **设置 → 模型** 里登录 DeepSeek 账号，或添加任意 OpenAI 兼容 provider。
3. 打开一个工作区（例如 `D:\dsh-mydsh\deepseek-harness` 或 `D:\dsh-mydsh\dsh-coderef`），发一条测试消息：
   > 用加粗列出 AssistantNodeView 和 OpenFileOptions 这两个符号
4. 模型回答里 `**AssistantNodeView**` 会在**该轮最后一条助手消息**收尾后被改写为链接样式
   （代码块里的 `AssistantNodeView` 不受影响）；点击 → 右侧栏**必定**跳到对应行并高亮（ping）→ 随后再尝试
打开 IDE（有 IDE 时两边同时生效）。
5. 浏览器控制台可查状态：

```js
window.__dshCoderef
// { version, stock:'ok'|'missing'|'unknown', resolves, lastError, lastResolve }
```

`stock:'missing'` 表示宿主补丁没生效（或宿主被重新构建过）——回到"已修改的宿主文件"重新打补丁/重建。

### 让点击打开真实 IDE

默认依次尝试 `code`、`code-insiders`、`cursor`、`windsurf`（PATH / App Paths）。
若 IDE 没在 PATH 上，启动服务前加环境变量指向可执行文件：

```powershell
$env:DSH_CODEREF_IDE='C:\Users\Administrator\AppData\Local\Programs\Microsoft VS Code\Code.exe'
```

### 解析架构（P0 + P1 已落地）

`/coderef/resolve` 按**证据可信度**分三层，前一层命中就不必等下一层：

1. **会话证据账本（evidence-first）**：经 `sessionQuery.readSession(sessionId)` 读会话事件并按 seq
   增量折叠。按工具名解析 `tool/result` 文本：
   - `grep`：`Found N matches` / 文件路径行 / `Line N: 内容` → 文件 + 行 + 声明；
   - `read`：`<path>…</path>` + `<content>` 里的 `N: 内容` → 文件 + 读窗口 + 声明；
   - `edit/write`：文件路径（含变更行）；
   - `glob/list`：路径集合。
   命中行再跑声明正则（class/interface/type/enum/const/function/…）得到符号锚点。
   同名多行时按"声明 > 命中 > 读窗口 > 路径出现"加最近性排序。
2. **引用文件**：Client 从 tool-call 参数、正文 inline code 提取绝对路径/相对路径；相对路径先在 cwd、
   再到 cwd 同级目录做存在性匹配（monorepo 兄弟仓回退），直接解析这些文件里的声明。
3. **工作区符号索引**：懒建 + 后台构建。文件枚举优先 `git ls-files`（尊重 ignore、比递归快得多），
   否则递归 walk；`MAX_FILES=20000`、单文件 512KB、跳过 `node_modules/.git/dist/...`。
   只有前两层都没命中时才最多等 `INDEX_WAIT_MS=1200ms`，没建完就先不链接（下条消息再命中）。
   实测 `deepseek-harness`（7,791 文件、33,878 符号）：本机宿主进程内 spawn 被策略拒绝时走 walk，
   后台构建约 10s；构建完成后同一 cwd 的解析即时命中。

**打分与决策**（`decideCandidates`）：grep 声明 `0.98`、read 声明 `0.94`、引用文件声明 `0.9`、
索引唯一 `0.62`、索引歧义 `0.44`；test/docs/readme/generated 路径 `-0.12`；同一 `file:line` 去重
取最高分。最终状态：

- `linked`：唯一高分（≥0.9 且无 0.12 内竞争者，或唯一索引命中）→ **才改写为引用**；
- `ambiguous`：候选接近（如同名多文件）→ **保持普通加粗**，不硬猜；
- `unresolved`：三层都没有 → 保持原样。

**行内代码 token**（inline code）走另一条通道：宿主的 Markdown 渲染器对每个 inline code 都会调用
`fileMentions.resolve(value)`，所以 Client 额外把 `inlineTexts` 发给 `/coderef/resolve`：

- 路径 token（`path.ts:12`、`path.ts:12-20`、`dir/file.ts`、绝对路径）→ 在 cwd、cwd 同级目录、
  evidence/index 文件表里按**直接存在 / 后缀匹配 / basename 匹配**解析，行号取 `:line`；
- 标识符 token（`AssistantNodeView`、`formatTitle:279`、`composeMentions()`）→ 先剥 `()` 与 `:line`
  再复用证据 → 引用文件 → 索引三层，行号用 `:line` 覆盖；
- **表达式 token**（`require('@deepseek-ai/dsh-client-ui-chat').AssistantNodeView`、
  `props.openFile(...)`、`chatFileMentions.forClosing(owner, sessionId)`）→
  `extractInlineRefs` 从里面抽出路径 / `name:line` / 点分成员 / PascalCase 候选，路径优先，再逐个解析；
- **拆分引用合并**（`EVIDENCE_SCORE`（`:493`））→ 渲染前合并成单个 `` `EVIDENCE_SCORE:493` `` chip，
  不修改模型输出；
- **转述片段匹配**（`useTurnData('turn-tail').closing.finalNode.seq === data.finalNode.seq`）：
  如果符号/路径都解析失败，就把片段拆成 distinctive terms，在**本会话读过的行**（evidence 的文件行 +
  hint 文件）里做 1–4 行滑窗模糊匹配（要求命中 ≥3 个词、覆盖率 ≥60%、≥2 个长词），
  落到词密度最高的那一行。所以即使模型转述得和源码不完全一样（源码是 `tail?.closing?.finalNode.seq !== ...`），
  也能链到 `AssistantNodeView.tsx:16`；
**点击后的右侧栏行为**（源码勘察结论 + 插件补充）：

- DSH 侧边栏的“跳转”本身只有 **滚动到行**：`openFile(path,{line})` → `sidebarRight.openResource(地址,{params:{line}})`
  → `TextPreview` 读 `navigation.params.line` → `scrollToLine(body,line)` 只是 `body.scrollTop = row.offsetTop`；
  **没有 native ping / 行高亮 / 闪烁 / 选中**（`scrollToLine` 没有加 class，也没有对应 CSS）。
- 本插件在侧边栏跳转成功后补一个 **ping**（不依赖 IDE 是否可用）：注入一次性样式，轮询右侧栏 DOM（最多 6s）找到
  `[data-code-preview] pre .line` 或 `[data-textpreview-line="N"]`，把目标行滚动到视口约 1/3 处并加
  `.dsh-coderef-line-ping`（背景高亮 + 左侧色条 + 2.4s 渐隐，2.6s 后移除）。行号范围
  （`AssistantNodeView.tsx:14-18`）会**同时高亮 14–18 五行**；不修改宿主 bundle，桌面/源码构建都用同一套。
- **点击顺序是固定的**：① `props.openFile` 打开右侧栏 + ping（always）→ ② `/coderef/open` 尝试 IDE
  （best effort，不阻塞侧边栏）→ ③ 两者都失败才写剪贴板。`window.__dshCoderef.lastOpen` 记录
  `{file,line,previewOpened,ideOpened}`。
- 调试：`window.__dshCoderef.lastPing` 记录最近一次 `{line,end,rows,at}`。

命中后由 `composeMentions` 返回 `{label,title,open}`，宿主渲染成可点 chip；**不修改 markdown**，
也不影响未命中的代码片段。路径证据分 `0.95`（会话证据）/ `0.9`（直接存在）/ `0.62`（索引）。

成员引用（`Owner.member`）先解析 Owner，再用**花括号作用域**把 member 限定在 Owner 声明体内，
避免全文件误配；`export { X } from './x'` / `export * from './x'` 会沿相对 import 链最多 3 层
追到定义文件。title 会带上来源（`grep 命中` / `read 命中` / `引用文件` / `索引`）与候选数，例如：

```text
D:\...\AssistantNodeView.tsx:6 · const · grep 命中
D:\...\lib\index.js:1216 · file · evidence
```

**缓存**：会话证据按 session 缓存并只折叠新事件（TTL 1.5s 内的重复请求直接复用）；Client 对
`sessionId|cwd|token` 做 5 分钟跨消息缓存，同一 token 不重复请求。

**调试**：

```js
window.__dshCoderef.lastResolve
// { cwd, sessionId, candidates, inlineCandidates, requested, cached,
//   hits, statusCounts:{linked,ambiguous,unresolved}, inlineLinked,
//   evidence:{events,symbols,files,folded}, index:{building,used,files,enumeratedBy} }
```

HTTP 侧还有 `GET /coderef/debug/evidence?sessionId=…&cwd=…` 可直接看证据账本规模与样本。

## 已知限制（原型范围）

- **桌面版打包 App（app.asar）不能使用本原型**：方案 1 需要宿主 `ui-chat` 导出 `AssistantNodeView`
  并重建客户端 bundle；打包版里该组件只在内部注册、没有导出，无法打补丁。本原型只跑源码构建
  （`apps/cli/lib/bin.js` + 隔离 `.dsh-home`）。
- 只处理**每轮最后一条助手消息**：宿主只在 closing turn 的 assistant node 上计算 `mentions`，
  中间 tool-calling 步骤保持原加粗（避免丢格式）。
- `ambiguous`（多个接近候选）**不链接**，也不弹候选选择器；hover/title 候选浮层与"不是这个"
  负反馈尚未实现。
- 行内代码只在**能解析**时变可点：带空格的命令行（`node test/smoke.mjs`）不拆，纯代码片段保持原样；
  路径未进证据/索引时才可能暂时未链接（索引后台构建，下条消息再命中）。
- 复杂表达式只取**第一个可解析路径/前几个符号**：服务实例成员（`ctx.get(...)`、`props.fileMentions`）、
  环境变量名（`DSH_CODEREF_IDE`）、框架内部调用通常解析不到；单独成 token 的 `:110` 这类行号
  （不与前一个引用紧邻）无法判断归属，保持原文。
- 转述片段匹配只覆盖**本会话读过的文件 / 正文引用过的文件**；仓库里存在但本轮没读过的代码暂不做全仓
  snippet 搜索（可作为后续 P2），且是启发式（title 会显示候选数，仍只链最高分行）。
- 行高亮（ping）在**每次点击**都触发（不管 IDE 能否打开）；它依赖预览 DOM 选择器
  （`[data-code-preview] pre .line` / `[data-textpreview-line]`），宿主预览器大改后可能失效
  （6s 重试后静默放弃），不影响跳转本身。
- 行号取自当前文件内容；文件被改动后与消息里的旧行号会一起偏移（这是跳转语义本身，不是 ping 的 bug）。
- 中文加粗强调（「本次链路」等）和普通加粗文本按设计不链接。
- 会话证据走 `sessionQuery.readSession` 增量折叠；更理想的 host-only `sessionProjections` 单元
  （宿主持久化缓存）留作后续——需要 zod schema 与 Session 对象读取 seam，当前实现功能等价。
- 工作区索引按 cwd 进程内缓存、构建后不主动失效（改完文件/切分支后新符号要重启或等下次重建）。
- 文件枚举优先 `git ls-files`，但本机 DSH 宿主进程内 `spawn` 可能被策略拒绝而回退递归 walk
  （实测 `deepseek-harness` 7.8k 文件约 10s），这是性能优化点而不是功能缺口。
- 只支持本地会话（cwd 来自 Chat 视图），远端/SSH 会话不处理；不解析 `node_modules`/标准库等外部符号。
- 语言以 TS/JS 为主，声明正则可覆盖 py/go/rs/java/kt/cs 等常见形态，但不是真 AST。

## 测试

```powershell
cd D:\dsh-mydsh\dsh-coderef\dsh-coderef

# 1) 纯函数 + 路由冒烟（不启动进程）
& 'C:\Program Files\nodejs\node.exe' test\smoke.mjs

# 2) 离线解析评测：解 .dsh-home 会话日志，跑证据/引用/索引三层，打印命中率基线
& 'C:\Program Files\nodejs\node.exe' test\resolution-eval.mjs

# 3) 真实浏览器 E2E（先启动本地服务与 headless Chrome CDP :9333）
$env:CDP_BASE='http://127.0.0.1:9333'
& 'C:\Program Files\nodejs\node.exe' test\e2e-check.mjs '<token>'

# 3b) Host 引用收集器
& 'C:\Program Files\nodejs\node.exe' test\references-smoke.mjs

# 4) renderer 版（fork 原生 MD；在 ../dsh-coderef-renderer）
cd ..\dsh-coderef-renderer
& 'C:\Program Files\nodejs\node.exe' test\smoke.mjs
& 'C:\Program Files\nodejs\node.exe' test\e2e-renderer.mjs '<token>'   # 需 CDP :9333
# 重新构建 fork bundle（esbuild + wrap，使用宿主 pnpm store 离线依赖）
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

## 插件级引用 instruction（v0.0.9）

Host 半通过 `ctx.inject(['systemPrompt'])` 注册 `coderef:citations` section（order = `FILE_REFERENCE + 1`），
要求助手主动输出 coderef 引用格式：

- 文件：`[lib/index.js:1216](coderef:lib/index.js#L1216)`；
- 符号：`[AssistantNodeView](coderef:sym:AssistantNodeView)`；
- 命令：`[node test/smoke.mjs](coderef:cmd:node%20test%2Fsmoke.mjs)`（destination 中的空格/斜杠要 percent-encode）；
- 网页：普通 Markdown 链接。

inline code 只用于代码字面量，不再作为引用格式。`GET /coderef/instruction` 返回这条 instruction 以及 `registered` / `order`，用于确认插件加载后确实挂到了本次会话的系统提示上。

## 渲染性能（v0.0.10）

之前每个 assistant-step 都各自启动一个 `/refs` 轮询，30 条消息就是 30 个 interval；实测这会造成
**12 秒 90 次请求、JS heap +72MB**，长会话下浏览器容易崩溃。

现在：

- 每个 `sessionId+cwd` 共享一个 module-level ledger channel，N 个 renderer 只订阅一个轮询；
- 轮询带 `since=<version>`，内容未变化时 Host 只返回 42B 的 `{unchanged:true}`；
- channel 内有 in-flight guard，隐藏标签页跳过轮询，最后一个订阅者卸载时清掉 interval；
- toast / resolve retry 的 timer 在组件卸载时清理。

RuleSystem 实时会话（30 个 assistant 节点）实测：

```text
修复前：12s 90 次 /refs，heap 62MB → 135MB（+72MB）
修复后：12s 2~3 次 /refs，60s 空闲 heap 稳定 42.3MB，节点 3671、renders 65 不增长
```
