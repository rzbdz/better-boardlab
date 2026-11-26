# 设计哲学

这份文档是 boardlab 的宪法：它说清楚每一层能知道什么、必须由谁来说、以及一次改动该落在哪里。代码可以改，这条边界不能绕。
评审一个改动时，先问这里的问题；答案对不上，就是设计错了，而不是"先这样，以后再拆"。

## 一句话

**core 只管框架，发行版只管组装，后端只管自己的能力。**

- **core**（`core/`，boardlab-core）：定义板子、槽位、锁、租约、串口、下载、启动、发现这些概念**共同的形状**，以及让它们跑起来的机制。它不认识任何一家厂商、任何一台主机、任何一条命令。
- **发行版**（本仓库的模块与前端）：把具体后端接进来，把 core 的形状翻译成某个后端能做的事，并给这一版 boardlab 装上具体的界面。
- **后端**（boardctrl、Home Assistant、另一台 boardd、本机硬件……）：自己最清楚自己能做什么、怎么做、文案该怎么说。它以**能力 + 描述符**的形式上报，core 和前端只搬运、渲染、执行。

依赖方向永远是一条线：

```
frontends ──► src/ui（契约与客户端）──► core（shape）
    │                                        ▲
    └──────────────► 模块 ui.ts ─────────────┘
src/modules/<id> ──► core（实现 Backend / 注册视图/命令）
externals/<id>   ◄── src/modules/<id>（只能经它的 CLI 或 API 驱动）
```

前端不认识模块内部，模块不认识前端；core 不认识发行版里任何一个模块。

## 三种知识，三种归属

1. **形状（shape）归 core。**
   "一块板子有名字、槽位、芯片、锁""发现方法有 id、标题、说明、字段""一个字段可以是文本或选择"——这些是所有后端共有、前端和 API 都必须理解的，归 core。
2. **内容（content）归后端。**
   方法叫"自动刷机"还是"人工配对"、说明怎么写、有哪些字段、字段的可选项是什么、运行起来调什么命令、进度行怎么打——这些只有后端知道，由后端在运行时上报。core 不写这些字符串，前端不预设这些模式。
3. **装配（wiring）归发行版。**
   哪个后端接进来、模块提供哪些视图和命令、这一版页面长什么样、站点和固件放在哪——归发行版，不进 core。

**判据**：换成另一个后端（比如 Home Assistant 有了自己的发现方式），core 要不要改？通用前端要不要改？两个答案都必须是"不要"。需要改的只有那个后端自己的适配模块。

## 描述符优先，而不是枚举模式

反例（已经修掉的）：

```ts
// core 里的发现接口带着 human / prefer / slots：core 知道 boardctrl 的两种玩法
discover(config, { human?: boolean, prefer?: number[], slots?: string[] }, ...)
```

```tsx
// 前端硬编码后端的方法与文案
<button>自动刷机</button><button>人工刷机</button>
```

正例：

```ts
// core：只有形状
interface DiscoveryMethod { id: string, title: string, about: string, fields?: DiscoveryField[] }
interface DiscoveryCapability {
  methods(config, context: DiscoveryContext): Promise<DiscoveryMethod[]>
  run(config, method, values, context, progress, registered?, signal?): Promise<{ message, found }>
}
```

```tsx
// 前端：拿到什么渲染什么，选择用后端给的字段，提交方法 id + 字段值
methods.map(method => <button onClick={() => choose(method)}>{method.title}<span>{method.about}</span></button>)
fields.map(field => render(field)) // text / choice，选项来自 field.options
```

描述符必须**自足**：标题、说明、字段、可选项、初值、必填、提示都在上报里，前端不需要知道任何后端名词就能画出可用的表单。

同类模式在本项目里的其他落点：

- **模块视图**：`src/ui/contract.ts` 的 `Element`（`form`、`select-many`、`table`、`job`…）。模块描述界面，前端渲染元素；新增一个模块的视图不需要改前端。
- **实验室状态**：`LabSettings` 报告 `canDiscover`、`canBind`、`hosts`、`fields` 等能力，而不是让前端猜“这是 boardctrl 所以有主机”。
- **板子状态**：`LabDevice` 报告 `empty`、`slotGone`、`mediaBoot`、`attention`、`sdks`；页面按这些状态渲染，而不是按后端名字分支。
- **认证与访问**：`LabFields` 让后端声明自己用哪些设置项；设置页不写死“URL / token”。

## 谁跑，谁负责

- **后端跑后端的事**：core 不拼 boardctrl 命令、不解析 GPIO、不判断 fastboot 语义。模块把 core 的调用翻译成后端命令，命令失败原因由后端给出，模块只负责搬运和统一错误形状。
- **core 跑流程**：确认、互斥、进度、取消、操作记录、锁与租约的同步由 core 负责，后端不会重复实现这些。
- **前端跑展示**：前端不推断能力，不拼业务文案；一句文案要么来自 core 的状态 shape，要么来自模块/后端的上报。

## 新增一个东西时放在哪

| 你要加的东西 | 放在 |
| --- | --- |
| 所有后端共有的一种状态 / 能力 / 事件 | core 的 `shared/types.ts`、`core/backend.ts`，并提供通用 UI |
| 某个后端能做的一件事、它的文案和参数 | 该后端模块的 `driver.ts`（能力实现）和 `ui.ts`（设置/操作视图） |
| 前端的一种新排版、快捷方式、样式 | 该前端自己的文件，或 `ui` 的 `custom` / `extra`；不能要求 core 改 shape |
| 某一版发行版的装配、默认值、站点 | 本仓库的模块目录、`frontends/`、`scripts/` |
| 只对某个后端有意义的字符串 / 命令 / 引脚 / 主机名 | 该后端模块或它的站点仓库；**不进 core、不进通用前端、不进公开文档** |

## 发现功能：一个完整例子

1. boardctrl 模块在 `methods()` 里上报两种方法（自动复位线探测、人工下载模式登记），连同标题、说明、字段和可选项（主机、空闲下载口、串口、SoC、SDK）。
2. core 的 `/api/labs/discover/methods` 原样返回；`/api/labs/discover` 只校验“方法存在、必填字段有值、选择在给过的选项里”，然后调用后端的 `run()`。
3. CLI `lab methods` / `lab discover --method --set` 同样只认方法和字段。
4. 两个前端把方法渲染成选项、把字段渲染成表单，提交方法 id 和字段值；取消、进度、超时仍由 core 统一处理。

在这条链上，core 不知道“人工/自动”，CLI 不知道 SoC，前端不知道 boardctrl。新增第三种发现方式时，只改 boardctrl 模块的 `methods()` / `run()`，其他层零改动。

## 偏离开销的判断

出现下面任一情况，先停下来重新设计：

- core 里出现某个后端的专有名词（boardctrl、fastboot、GPIO 编号、HA、厂商名、具体命令）。
- 通用前端里出现某个后端的模式名或流程名（自动/人工、配对、刷机包格式）。
- 为了一个新后端，要改 core 的公共类型或通用前端。
- 模块的 `ui.ts` 里出现“如果是现代前端就……”；前端里出现“如果是 boardctrl 就……”。
- 后端把文案、字段留给前端猜；前端把业务判断（能不能做、要不要确认）留给用户猜。
- 一个概念在 CLI、API、前端各有一份不同的说法，且没有一层是权威。

## 每次开发结束的自检（扪心自问）

在结束一次开发前，逐条回答，并把答案写进提交说明或评审记录：

1. 这次改动的**概念**是什么？它归 core、发行版还是后端？
2. 我有没有把某个后端的名字、命令、文案、模式写进 core 或通用前端？
3. 如果明天接入第二个后端（例如一个只有人工发现方式的 HA），这条链需要改哪些文件？列表里有没有 core 或前端？
4. 新增的能力是否**自描述**：标题、说明、字段、选项、初值、必填、提示是否都由拥有它的那一层给出？
5. CLI、HTTP API、两个前端看到的说法是否一致？有没有一层在“猜”？
6. 失败、取消、超时、权限、锁的语义是否仍然由 core 统一负责？
7. 测试里是否覆盖了“换一个后端/换一种方法即可工作”的路径，而不只是当前这一种？
8. 有没有为了过检查而加的例外（架构白名单、`@ts-ignore`、if-else 特判）？能不能改成正确的归属？

## 每个版本发布前的架构扫描与 LLM 评审

发布（RC 与稳定版都包括）之前必须完成：

1. **架构扫描**：`pnpm check`（含 `core/scripts/check-architecture.mjs`、模块注册表、core 版本与 tag 校验）必须通过；扫描规则本身也要评审，防止规则被绕过。
2. **全链路架构评审**：按概念分派 LLM 评审（发现、登记/端口、启动/刷机/SDK、锁/租约/槽位、模块与 UI 契约、发布身份、串口……），每个概念从后端契约一路查到 API、CLI、两个前端和测试，回答上面的自检问题。
3. **记录**：评审发现按“违反哲学 / 边界风险 / 文案不一致”分级，能在这个版本修的在版本内修掉；不能修的写进发行说明的“已知边界”，并给出下一版的归属方案。不得用临时例外换发布。
4. **关闭反馈**：核对 `boardlab feedback list --all` 中与本次改动相关的条目，能关的关闭并注明版本。

## 已知边界（2026-11）

下面这些还没有按上面的原则收干净。它们是下一版的归属方案，不是永久例外；新增功能不要照着它们的样子写。

1. **启动/刷机/SDK 的描述符还在 core 和通用前端里。** `BuildsCapability` 的 `load`/`download`、`variant`、`brk`、`flasher`，以及两个前端的启动对话框，仍然是 boardctrl 的模型。下一步：后端上报启动/刷机描述符（方法、就绪状态、选项、刷机包来源），core 只搬运，前端只渲染；CLI 按描述符校验，而不是按正则。
2. **页面状态里还有模块私有字段。** `PageState` 直接带 `slots`/`scan`/`ha`，两个前端也认识 `boardctrl-hosts`、`cli-machines`、`human` 等模块视图 id 和路由。下一步：改为模块键的扩展注册 + `View` 的通用元数据（顺序、分组、首次使用步骤）。
3. **架构检查没有覆盖通用层。** `architecture.json` 顶层没有 `core` 规则块，`ui-contract`/`frontends` 里的模块名不会被拦；`core/architecture.json` 也还没列 `fastboot`/`gpio`。下一步：补齐规则并清理现存名字，不要加白名单。
4. **实验室访问设置还是固定四个键。** `LabFields` 只允许 `url`/`username`/`password`/`jump`，设置页也按这四个键渲染。下一步：`LabFields` 改为任意键 + 通用值表，core 按声明存取。
5. **板子租约在改名/释放失败时的处理仍偏 boardctrl。** core 改名时清空后端租约 token，释放失败会吞掉错误。下一步：由 `RenameCapability` 报告租约是否保留，释放失败保留 token 并在每次同步重试。
6. **安装器的本地 dist 身份校验、GitHub 发布目标仓库的 tag 校验仍不完整。** 已加上 `--verify-tag` 与发布 README 的凭据清洗，但还没有在目标仓库验证 tag 指向的 revision 与签名。下一步：两阶段稳定发布（先构建验证，再在目标线打签名 tag）。
7. **下载模式在 core 里还叫 `fastboot`。** `RelayCapability.fastboot`、`BoardMode 'fastboot'`、`/api/fastboot`、CLI 的“已进入 fastboot”和两个前端的标签都是 boardctrl 的词。下一步：形状改成“进入下载模式”，词由 `RelayCapability.describe` 给；core、CLI、两个前端和后端一起改。
8. **core 在解析后端的进度文字。** `ACTION NEEDED`、`(request …)`、`(confirmed by a person|detected )` 都是 boardctrl 的写法：第二个后端换个说法，等人操作的提示就静默消失。下一步：后端通过 progress/notice 回调报告“我在等人做什么”，core 只转发。
9. **调试的描述符到页面上不再自足。** `src/modules/boardctrl/ui.ts` 的 `KINDS` 之外的动作（`write`、`gdb`、插件自己的）CLI 能跑、页面看不到；只有实验室列出的板子才有调试块（`BoardInLab.debug`）；`DebugCapability.start/action` 没有 `signal`，锁结束时停不掉一个卡住的启动。下一步：页面渲染后端报的每一个 kind（`KINDS` 只提供标签），`debug` 放到 `Board` 上而不是只在实验室视图里，`start`/`action` 接 `doing` 的 signal。
10. **有些页面作业停不下来。** 契约里的作业用 `cancellable` 声明它真能停（`signal` 一 abort，服务器那边也停，作业随即结束），两个前端只对这样的作业给「取消」；本机扫描是这样。装 boardctrl 主机（`/api/boardctrl/install`）、同步站点（`/api/boardctrl/site/sync`）和给机器装命令行（`/api/clients/install`）还不读请求的 `signal`：页面不给它们「取消」，离开页面也不算取消，boardd 会把它们做完。下一步：把处理器的 `signal` 传进安装和同步，让它们在步骤之间停下，再标成 `cancellable`。
11. **完成状态靠推断。** 首页的首次设置步骤用 `status?.tone === 'ok'` 判断“这一步做完了”，模块没法表达“装好了但状态是 warn”；troy 前端不按 `order`/`summary` 排序、不渲染 `help`/`hint`，也不渲染 `board` slot。下一步：`View.done`，并让第二个前端读同一批通用元数据。
12. **版本一致性只报一半。** `boardlab version` 不比 CLI 与 boardd 的版本是否一致；页面的重载只比 revision，同一个提交新切一个 RC 不会触发重载。下一步：两处都比 `version`+`revision`。
13. **租约靠同步续期。** backend 的租约 TTL 是 600 秒，只在 60 秒一次的同步里续：boardd 停超过 10 分钟再回来，核心锁还在，backend 的租约已经过期，期间直接占板子的人会在下次同步被悄悄顶掉（页面上只有 `leaseError`）。下一步：租约丢了的记录在板上报出来，并按 TTL/3 续期。
14. **放锁时“会话已随板子停下”这件事到不了人。** 后端在释放租约时确实会停掉会话并回报 `sessions_stopped`（宿主 API 与 `boardctrl dut release --json` 都能看到），但 `LeaseCapability.give` 的返回值被 core 丢弃，CLI 只说“已释放 <板>”，两个前端也只在前说明“板子一释放就停”。下一步：`give` 返回它停掉的会话，core 转成一条通知，CLI 与两个前端都按同一 shape 显示。
15. **串口重连靠比对文字补上断开期间的输出。** 页面重连后在新的 history 里找屏幕上最后一行，从它后面接着写（`src/ui/console-session.ts`）：同一行出现过两次、或者最后一行已经不在 backlog 里，就会重复或漏掉输出；`LOG_STAMP` 是 serial-mux 的时间戳格式，却写在通用层里。下一步：按偏移续传。core 的看串口会话数输出的字节，事件带上偏移，页面带 `since=` 重连，core 只补上中间缺的那一段，补不上就说丢了多少；`LOG_STAMP` 移出 `src/ui`。归属：core consoles。
16. **主机的 GPIO 服务不认租约。** 板卡主机的 GPIO 面板经 boardd 转发、带着主机 token，主机上的 GPIO 写操作不查是谁拿着板子。这一版在 boardd 这边挡住：一个实验室里有板子被别人锁着时，面板的修改（POST）一律 403，只能看。这挡不住绕过 boardd 直接拿 token 调主机的人，也让同一台主机上不相干的板子一起不能改。下一步：板子认领自己的控制线（复位、下载、电源），主机的 GPIO 服务拒绝没有这块板子租约的人改这些线，其余的线照常可用。归属：boardctrl。
17. **页面不按运行 id 跟进。** CLI 断线后按运行 id 接着跟一个刷机或启动，boardd 重启后接手的运行也照样跟得上；页面的作业还是一条请求的流，boardd 换进程时流断了，页面只能从板子的 `run` 上看到结果，看不到中间的进度。运行 id 在旧记录被清理后可能重用，两个请求同时建同一个 id 时第二个拿到的是没有说明的 500；被 boardd 重启打断的运行在 CLI 上以 1 退出，和普通失败分不开。下一步：页面作业带上运行 id，断了按 id 重连；id 不重用，冲突报 conflict；打断单独一个退出码。归属：core runs。
18. **升级前的进程里不能取消的运行，新进程停不了。** 换进程期间旧进程的运行还在跑，板子照样显示忙；能取消的运行（后端有 `cancel`）由新进程转给后端去停，其余的只能等它在旧进程里做完，或者等旧进程退出。旧进程最多等它的运行 6 小时，再长的会被打断。下一步：新进程把取消转给旧进程（经监督进程），旧进程按自己的 signal 停下。归属：core server。
