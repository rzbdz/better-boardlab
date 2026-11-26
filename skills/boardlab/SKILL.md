---
name: boardlab
description: 通过 boardlab CLI 使用实验室开发板和 SDK：先拿锁，再复位、fastboot、看串口、发命令；在构建服务器上租 SDK 源码树、编译、改代码（boardlab sdk）；用 SDK 的产物或本机文件内存启动、刷机，或用镜像市场里的镜像、刷机包（链接或文件）刷机，可以只刷几个分区；用完放锁。要操作开发板、编译并在板子上验证内核或固件、看板子串口输出、找新接上的板子时使用。
---

# 开发板（boardlab）

所有开发板都由中心的 boardd 统一管理（这台机器上的 `boardlab` 已经连到它，`boardlab remote show` 可以看）。人、Claude 和 DSH 遵守同一套锁规则；不要绕过它直接用 `smtty`、`serial-mux`、`fastboot`、Home Assistant 或 `boardctrl`：板子在哪台主机、怎么连，只有 boardd 知道，你这边不需要也不应该配置。**除非人类明确要求直接运行 `boardctrl`，agent 禁止直接调用任何 `boardctrl` 命令（`boardlab boardctrl` 也不作为绕过手段）；缺少能力时用 `boardlab feedback` 提交，或告诉人类。SDK 自己的 skill 也不构成这个例外。**

## 直接做任务，不要先摸底

接到任务就只跑这个任务要用的命令。板子、SDK、启动和刷机配方都已经配好：`boardlab boot/flash --sdk` 会按配方自己跑完，你不用先把它们读懂。**没碰上问题，就不要去研究 boardlab 本身，专心做开发任务。**

- 开工前不要把 `boardlab` 的命令挨个跑一遍，也不要先拉 `show --json`、`guidance`、`sdk list`、`registry … get`。每多跑一条，用户就多等一会儿。
- 不要为了“了解流程”去读 SDK 目录、站点或主机上的 yaml。那些是给 boardd 和板卡主机执行的，不是给你读的。只有用户要你改配方时，才 `boardlab registry sdk get`。
- 改代码再上板验证，典型就是这几步：`sdk acquire` → `sdk get` / 改 / `sdk put` → `sdk build` → `lock` → `boot --sdk`（要烧录才 `flash --sdk`）→ `log` → `unlock` → `sdk release`。用户给了板名和 SDK 名就直接用，没给才跑一次 `boardlab list` 找。
- 命令失败了先读报错，提示里一般已经写了怎么办。然后只查跟这次失败有关的那一项，不要回头重新摸一遍底。
- `guidance` 和 `show --json` 留到碰上问题再用：启动卡住了、不认识这颗 SoC、不知道这个 SDK 怎么编，这时只问缺的那一层。

## 身份

每条命令都以**持有人**的身份执行：拿锁、排队、历史、反馈都记在这个名字下。你是 agent，不是让你干活的这个人，所以你的持有人必须是你自己的 agent 身份（`claude:<会话>`、`codex:<会话>` 等）——**绝不能是 `user:<用户名>`**，也不要用别人的名字。用人的名字会让人以为是本人拿了锁、做了操作，排队和追责都会错人。

- Claude Code 会自动用 `claude:<会话 ID>`；其他 agent 先确认一次：
  ```sh
  boardlab status --json        # 看 "you"：应当是 claude:<会话> 或 <你的工具>:<会话>
  ```
  如果显示 `user:<用户名>`，立刻设成自己的身份再继续：
  ```sh
  export BOARDS_HOLDER=<你的工具>:<会话 ID>      # 例如 codex:fix-usb-1、opencode:ci-smoke
  ```
- 不要用 `--as user:<用户名>`（那是自称是本人）；用 `--as <你的工具>:<会话>` 或上面的环境变量。
- 子 shell、脚本、后台任务里也显式带上 `--as <你的身份>` 或 export，不要依赖继承。
- 看到 CLI 提示「以 user:… 的身份操作」时，停下来改身份，不要忽略。
- 协作项目里的成员身份是 `workspace:<项目>/<成员>`，同样不是你应冒用的。

## 基本流程

```sh
boardlab list --json                         # 不知道用哪块板、谁在用时才看
boardlab lock <板子> --for "调试 U-Boot 网络"  # 拿锁；被占用时退出码 3
boardlab reset <板子>
boardlab send <板子> 'printenv ethaddr' --wait '=> ' --timeout 10s
boardlab log <板子> --lines 200
boardlab unlock <板子>                       # 锁没有时间限制，用完一定要放锁，排队的人才能拿到
```

- 别人持有锁时只能看（`list`、`show`、`log`、`console`），不能输入或控制。要等就排队，先到先得：
  - `boardlab lock <board> --for ... --wait`：一直等到拿到锁；
  - `boardlab queue <board> --for ...`：只排队不等，轮到你时锁自动归你，再运行 `boardlab lock <board> --for ...` 取凭证。
- 持锁期间串口有 serial-mux 输入闸门：`boardlab send` 自动通过；确实需要直接用 `smtty` 时，带上 `boardlab lock` 打印的 `--token`。不带 token 的输入会被丢弃，`smtty --send` 以退出码 3 报「已锁定」。
- 自定义槽位上没有 fastboot 脚本的板子只能复位，`boardlab fastboot` 会报「只能复位」；不要为此去改槽位脚本，脚本由用户维护。
- 认板子只看 `boardlab list` 和扫描结果，不要猜 `/dev/ttyUSBn`。
- `boardlab list` 里标着 `[实验室 <名字> <设备>]` 的板子在远程实验室，命令完全一样。正常 SDK 启动/刷机由板端主机自己从构建服务器取产物；本机文件兜底才经 boardd 传输。实验室的板子别人也可能在实验室后台直接用，串口没有输入闸门；看到不是你发的输入或复位，停下来告诉用户。
- 实验室 `boardctrl` 的板子（`boardctrl-<dut>`，例如 `boardctrl-board-1`）在 boardctrl 管理的板卡主机上。拿锁时 boardd 同时替你持有 boardctrl 的租约，所以只用 `boardlab` 命令操作它们，不要再用 `boardctrl dut acquire/reset/boot` 去动同一块板。要在构建服务器上租 SDK 源码树、编译、改代码，用 `boardlab sdk …`（见下一节）。
- 卡片或 `boardlab show --json` 里 `lab.attention` 不为空时，板子在等人按 RESET 之类的操作（由人复位的板子）：复位、boot 放到后台跑，把提示原样告诉用户，用户说做完了再 `boardlab confirm <board> --request <lab.attentionRequest>`（带上请求 id 不会因为实验室已经自己看到结果而报错）。不要自己猜着确认。
- `lab.heldBy` 不为空表示有人直接在 boardctrl 里租着这块板，拿锁会失败；要等就 `boardlab queue`。
- 后端能单独控制继电器的板子（boardctrl 主机；`boardlab relay <board>` 会说这块板能不能），持锁时可以直接控制它的线：`boardlab relay <board>` 列出继电器和按钮，`boardlab relay <board> power pulse --ms 3000` 断电三秒再上电，`boardlab relay <board> boot press` 按住 BOOT（用完 `release`）。复位和进下载模式仍然用 `reset`、`fastboot`；只在用户要求、或这两条做不到时才直接动线，并说明动了哪根。
- 实验室的板子都在槽位里（`boardlab list` 里的「槽位 host1/s3」）。所有命令都可以用槽位名代替板名：`boardlab lock host1/s3 --for …`、`boardlab console host1/s3`。在同一个槽位上换着板子反复测试时，用槽位名，不用管板子叫什么。
- 「空槽位」是还没登记板子的串口：可以拿锁、`boardlab console` 看，用户要求时 `boardlab lab methods boardctrl --slot <主机>/s4` 看这个槽位的发现方式，再 `boardlab lab discover boardctrl --method <方式> --slot <主机>/s4 --yes` 在上面找板子（会复位没登记的线），找到就登记。
- 用户说槽位里换了板子：拿锁后 `boardlab refresh <槽位>`（`--name <新名字>` 或 `--rename` 按读到的型号改名），不要 remove 再重新发现；锁跟着槽位走。
- 板子识别不出来（`soc` 为空、没有下载口、`lab.sdks` 为空，`boardlab show <board> --json` 能看到）：拿锁后用 `boardlab set <board> --soc <soc> --usb usb:<x-y> --fdl button` 补齐登记（也可以改 `--model`、`--sdks`、`--reset-pin`、`--fdl-pin`）。boardd 用你锁上的那份 boardctrl 租约去改，直接 `boardlab boardctrl dut set` 是拿不到租约的，不要绕。
- 拿锁时板子正被人用：你会等最多 60 秒，页面会问那个人「让出 / 继续用」。被拒时说明没有拿到，别抢；等他放锁或改用另一块板子。
- `boardlab reset` 是让板子启动它自己的系统。下载模式短接的板子：`boardlab list` 写着「复位：经 … 从介质启动」时，复位会从板载介质启动；写着「停在下载模式」时，复位后它停在下载模式，要用 `boardlab boot` 从内存启动。
- 多芯片板用 `<board>.<die>` 指定芯片，例如 `boardlab send evb.die1 ...`。
- 每条命令都支持 `--json`，解析结果用它。

## 等结果，不要 sleep

要等的东西几乎都能阻塞等到，不要用 `sleep` 盲等：`send --wait`、`console`、`boardlab boot` 的任务都是阻塞的。
但**一次 wait 不要超过约 30 秒**：等不到就先 tail 一下串口看清卡在哪，再决定继续等、换方法还是停。

- **30 秒以内**：直接 `boardlab send <board> '<命令>' --wait '<正则>' --timeout 30s`，退出码说明等到没有。
- **会超过 30 秒的**（开机、刷机、大文件传输、等内核起来）：不要一个 `--timeout 1800` 干等。用「等 30 秒 → tail
  看一眼 → 再等」的循环；每次先看串口最近的输出：
  - 一次性看：`boardlab log <board> --lines 60`（要筛就 `| grep -E '<正则>'`）；
  - 跟着看：`boardlab console <board>`（长连接、断线自动重连）；
  - 看到已经到位（出现提示符/登录行/启动完成标志）就立即继续，不要等满超时；看到 panic、卡死、重复重启就停下来报告，
    不要继续等。
- **写脚本时就用这个模式**：每一轮阻塞等一小段（`--wait … --timeout 30`，或轮询 `boardlab log`），等不到就 tail
  一下并检查失败标志，再进入下一轮；总时长设上限（开机 3–5 分钟、刷机按镜像大小 10–30 分钟），轮次间隔可逐步放宽
  （30 秒、60 秒、120 秒…）。示例：

  ```sh
  deadline=$((SECONDS + 300))          # 开机最多等 5 分钟
  for i in 1 2 3 4 5 6 7 8 9 10; do
    boardlab send "$B" ' ' --wait 'login:|~ # ' --timeout 30s && { echo booted; break; }
    if boardlab log "$B" --lines 60 | grep -E 'Kernel panic|Please RESET|Synchronous External Abort'; then
      echo "启动失败，看上面的串口输出"; exit 1
    fi
    boardlab log "$B" --lines 8 | tail -8      # tail 一下，看进度
    [ $SECONDS -ge $deadline ] && { echo "超时：还没起来"; exit 1; }
  done
  ```

- **启动/刷机**本身是后台任务：`boardlab boot …` 会跟着任务走，`--timeout` 给比预期略长的值；等太久可以
  `boardlab cancel <board>`，不要让它一直挂着。boardd 中途重启时启动/刷机不会丢：命令行说一次「连接断了」，
  然后接着跟到它结束，按它真正的结果退出（0 成功；失败、取消或「被打断」都不是 0）；`boardlab show <board>` 也看得到它最后一次怎样结束。被打断的不要直接重跑，先看板子现在的样子。
- **板子在等人**（`lab.attention`）：等用户，不要 sleep 猜；用户说做完了再 `boardlab confirm <board> --request <lab.attentionRequest>`。提示已经消失（实验室自己看到板子到位）说明不用再确认，不要把它当失败重试。
- **确实没有阻塞接口时才轮询**：间隔从短到长（0.5 秒、1 秒、2 秒…）并设总超时，拿到结果立即继续。

## 请人帮忙（插拔、接线、按键）

板子外面的事你做不了：插拔线、把板子接到某个口、按按钮、按住 BOOT 再按 RESET。不要猜着让别人做，也不要假设已经插好了——用 `boardlab ask` 请人，等结果：

```sh
boardlab ask "把 K3 板的 USB 线插到 2-1.1" --kind 插拔 \
  --body "插好后板上串口会打印 ROM: usb download handler；下载口应该出现在 usb:2-1.1" --timeout 10m
```

- 标题一句话说清做什么；`--body` 写怎么做、做完是什么样（能验证的现象，例如串口出现哪一行、哪个下载口出现）；`--kind` 是给页面上分类的（插拔、接线、按键、其他都行）。
- 这条命令会**阻塞等人**：页面上出现「人工请求」，人在那里点「我做好了」或「做不了」。退出码 0 表示做好了（输出里有人的说明），3 表示人明确说做不了，超时是错误并提示请求还在等。
- 人还在忙时不要反复重发：`--timeout` 给足（默认 10 分钟），超时后用 `boardlab ask list` 看请求状态，需要继续等就再 `boardlab ask <同样的标题> --key <同一个键>`（同一个 key、同一个人还在等时不会产生第二条）。写脚本时用 `--no-wait` 只登记，再用 `boardlab ask list` / `GET /api/human/request?id=<id>&wait=20` 轮询。
- 不要用 `boardlab ask` 代替你能做的事（拿锁、复位、串口），它是给人做的物理操作。做完之后自己验证：看串口、看下载口、`boardlab list`，再继续。
- 人在页面上写的原因要看：说「线不够长」「没有这个口」时换个办法或告诉用户，不要硬等。

## SDK：编译、改代码、启动

SDK 源码树在构建服务器上，也通过 boardlab 用（boardd 那边的 boardctrl 执行，用法和 `boardctrl sdk` 一样，`boardlab sdk help` 列出全部）：

```sh
boardlab sdk list                                   # 有哪些 SDK、在哪台构建服务器
boardlab sdk acquire sdk-a --task fix-usb        # 租源码树：切到任务分支 boardctrl/fix-usb；用完一定 release
boardlab sdk exec sdk-a -- git -C linux-6.18 log --oneline -3
boardlab sdk get sdk-a linux-6.18/drivers/usb/x.c -o x.c     # 取到本机改
boardlab sdk put sdk-a linux-6.18/drivers/usb/x.c x.c        # 改完写回（要持有租约）
boardlab sdk build sdk-a kernel                  # 编译，输出实时显示，退出码就是结果
boardlab sdk release sdk-a
```

**先对齐上游，除非用户明确说就在本地分支上做。** `acquire` 从源码树当前检出的提交切出任务分支，这个提交可能落后远端很多。用户没有明确说“就用本地分支/当前代码”时，改代码之前对每个开发仓库（`boardlab sdk show` 列出）先 fetch 再比较：

```sh
boardlab sdk exec sdk-a -- git -C linux-6.18 fetch origin
boardlab sdk exec sdk-a -- git -C linux-6.18 status -sb                 # 是否 behind 上游
boardlab sdk exec sdk-a -- git -C linux-6.18 log --oneline HEAD..@{u}   # 远端有、本地没有的
boardlab sdk exec sdk-a -- git -C linux-6.18 log --oneline @{u}..HEAD   # 本地有、远端没有的
```

- 已是最新：直接继续。
- 只是落后、没有本地独有提交：告诉用户落后多少，**问**要不要基于最新远端开发；同意后在刚切出的 `boardctrl/<task>` 上 `git merge --ff-only @{u}`（在你提交任何东西之前）。
- 有本地独有提交、已分叉或没设上游：不要自己 rebase / reset，说清看到了什么，问用户用哪个基线。
- fetch 失败（构建服务器没网或没权限）：说出来，问用户是否就用本地状态继续。
- 永远不动所有者自己的分支，只让任务分支跟上远端。

编好以后在板子上验证，不用把产物拷来拷去：

```sh
boardlab lock boardctrl-board-1 --for "验证 fix-usb"
boardlab boot boardctrl-board-1 --sdk sdk-a        # 内存启动：板子所在主机自己去构建服务器取产物
boardlab flash boardctrl-board-1 --sdk sdk-a       # 要烧录到板子上时才用；先说明原因
boardlab log boardctrl-board-1 --lines 300            # 看串口确认真的起来了
boardlab unlock boardctrl-board-1
```

- `boardlab show <board> --json` 里 `lab.sdks` 是这块板能跑的 SDK；不在里面的不要硬启动。
- SDK 配方拿不到的本机自定义文件（例如自己打的 FIT）才让 CLI 用 scp 送过去：`boardlab boot <board> fsbl u-boot-opensbi ./Image.itb`。URL 或板端已有路径用 `boardlab boot <board> https://…/Image.itb`、`boardlab boot <board> host:/绝对路径`，由板端自己取并计算 sha256，不上传。网页上传是给人用的（分片传，boardd 自己算 sha256）；CLI 一律用 scp。
- 只在调 U-Boot、edk2 或它们加载的内核时：`boardlab boot <board> --sdk <sdk> --break <名字>` 停在 recipe 的 `breaker:` 那一步（常见 `uboot`、`edk2`；页面启动对话框的「停在哪」列出的就是可用的名字，没有列出来的不要猜）。edk2 的流程停在 UEFI Shell / ACPI 阶段，U-Boot 的停在自己的命令行，之后在串口里自己操作。
- 启动或刷机卡住了用 `boardlab cancel <board>`：正在跑的这一步会被停下（连同它起的进程），锁还在你手里。被取消的命令以**退出码 4** 结束（3 是被占用或连不上，0 才是成功）：不要把 4 当成功，也不要自动重跑。
- 镜像市场里的刷机包（站点配好的仓库或构建服务器目录）用名字刷，不用自己拼链接：

  ```sh
  boardlab images                                   # 有哪些镜像市场
  boardlab images <市场>:<目录> --soc <soc>          # 一层目录，新的在前；--soc 只看这块板的 SoC
  boardlab images <市场> --find <文字> [--soc <soc>] # 把整个市场读一遍，只列名字里有这几个字的镜像（和通往它们的目录）
  boardlab images <市场>:<镜像> --targets            # 这个镜像能刷到哪些板子上
  boardlab flash <board> --image <市场>:<镜像> --plan   # 只看会写哪些分区，不碰板子（要拿锁）
  boardlab flash <board> --image <市场>:<镜像> [--partitions a,b] [--reset]
  ```

  `--plan` 列出每个介质上的分区、包里对应的文件，以及能不能单独刷（`·` 标记的可以）。只改了某几个分区时用 `--partitions`（名字照 `--plan` 列的），不要整包重刷；`--reset` 刷完复位，从刚写的系统启动。不知道镜像在哪个目录里时用 `--find`（例如 `boardlab images <市场> --find <版本或关键字> --soc <soc>`），它会读整个市场，不需要一层层找；文件夹太多或太慢时会说没读完整个市场，那时再按目录找。用户说“刷最新的镜像”时，先 `images` 或 `--find` 找到这块板 SoC 的最新那个，说清楚是哪一个再刷。
- 现成的刷机包（用户给的链接或本机文件）用 `boardlab flash <board> <链接|文件> [--flasher <工具>]`（`--plan`、`--partitions`、`--reset` 一样能用）：http(s) 链接由板子所在主机自己下载，本机文件先由 CLI scp 到 boardd、再到板卡主机。板卡主机可能按链接把下载过的包留一段时间，同一个链接再刷就不再下载（日志里会说是缓存的）；链接后面的内容换过了就加 `--refresh` 重新下载。同样要拿锁，会改写板子的存储，先说明原因；`lab.canFlashPackage` 为 false 的板子不支持。

## 分层知识：先问平台，再问 SDK，不要问用户

这份 skill 只讲**开发板这个对象**和 boardlab 的规矩。**这块硬件的知识**（这颗 SoC 的坑、这个 SDK 的用法、
这块机器人的接线约定）由配置层分级提供，随站点变化，所以不在客户端里写死——**用命令问，不要凭记忆猜，也不要
为了“那颗 SoC 该怎么弄”去问用户**。问的顺序就是层级，逐级往下：

```sh
boardlab guidance --list            # 这一层有哪些可问：通用提示、有笔记的 SoC、有 skill 的 SDK
boardlab guidance                   # 第一层：站点和 platform 的通用提示（适合每块板子）
boardlab guidance --soc <soc>       # 第二层：这颗 SoC 的笔记 + 它的资料在哪
boardlab guidance --sdk <sdk>       # 第三层：这个 SDK 自己的 SKILL.md（构建、启动、刷机怎么做）
boardlab guidance --dut <board>     # 一次问全：问板子所在主机它的 SoC 和 SDK，自动带上上面三层
```

- **碰上问题才问，不是每个任务开头都问**：任务照常跑通，就不用去查这些。卡住时，`boardlab guidance --dut <board>` 一次就能拿到适用这块板的知识，`boardlab show <board> --json` 的 `lab.soc` 和 `lab.sdks` 说明这块板认得的平台和 SDK。
- **每一层只回答自己那一层**：通用提示是给一屋子板子的；SoC 笔记是这颗芯片的复位方式、串口电平、boot ROM 行为；SDK skill 是这份源码树怎么编译、怎么启动、有哪些变形。上层不重复下层，引用下层。
- 站点里出现 `soc.yaml` 之外的 `.md`（`socs/<soc>/*.md`）就是这颗 SoC 的笔记，`skills/<id>.md` 就是那个 SDK 的 skill；`boardlab guidance --soc <soc>` / `--sdk <sdk>` 只给这些，不要自己去主机上找文件。
- 需要更多一层（例如某块板子的接线、实验室的特殊步骤）时，看板子页的 `help`。没有的话，在回答里说明缺什么，再用 `boardlab feedback` 报一条：不要为此直接读主机上的站点文件。
- **知识不在这一层时**：`--list` 里没有你要的 SoC/SDK，说明站点还没提供；那就在回答里说明缺什么，用
  `boardlab feedback --kind design` 提交，不要反复问用户同一个问题。
- **SKILL.md 的来源**：有的 SDK 带自己的说明，`boardlab sdk skill list` / `boardlab sdk skill <sdk>` 取来看；
  `--install [--dir DIR]` 写到 `.claude/skills/<sdk>/SKILL.md`，`-g` 写到这台机器上每个 agent 的 skill 目录。

## 给 SDK 加启动或刷机方法

SDK 的定义（构建服务器、路径、组件、产物、load 内存启动和 download 刷机两套步骤）在中心的 SDK 目录里，改了会马上推到每台板卡主机。**不要去改任何机器上的 yaml 文件**（板卡主机的 site、本机的 ~/.config/boardctrl）：那些副本不会生效，下次部署还会被覆盖。

```sh
boardlab registry sdk get sdk-a -o sdk-a.yaml       # 第一行记着版本号，别删
# 编辑 sdk-a.yaml
boardlab registry sdk put sdk-a -f sdk-a.yaml --check                       # 只校验：整个目录带着改动加载、所有流程排一遍
boardlab registry sdk put sdk-a -f sdk-a.yaml -m "加 download：按厂商 fastboot_flash.sh 逐分区烧"
boardlab registry sdk recipe sdk-a download -f steps.yaml -m "…"            # 只改一套步骤
boardlab registry sdk history sdk-a                 # 谁改的、为什么；rollback sdk-a <版本> 回到旧版
boardlab registry hosts                             # 每台主机拿到的目录版本
```

- 板卡主机上的 site 文件（`/etc/boardctrl/site/…`，旧的安装是 `/etc/bsp/site/…`）改了不生效：`boardlab registry hosts` 会把它列成 NOT IN EFFECT。要生效就 put 进目录。怀疑主机拿的不是最新版本，就运行 `boardlab registry refresh`。
- put 会逐台列出这次改动：`delivered rev N, verified, in effect` 是送到并核对过；`NOT DELIVERED` 后面写着原因（连不上、不再报到、主机没配 server.announce、拿到了但加载不了）和 `next:` 该做什么。refresh 让每台主机从头重新拿，同样逐台列出；一台都没拿到时 refresh 直接报错并说明原因。看到没送到的主机，不要自己去改那台主机上的文件：告诉用户，再用 `boardlab feedback` 报一条。
- 别人在你之后改过同一个文档，put 会报冲突：重新 get、把你的改动做在新版本上再 put，不要 `--force` 盖掉别人的。
- 校验不过（引用了不存在的服务器、产物或步骤）什么都不会写，按报错改。
- 新流程没在硬件上验证过，`-m` 里写明；第一次用它刷机前告诉用户。

## 新接上的板子

- 网页上每台主机/空槽位有「发现这块板」：选一种实验室**上报的方式**（boardctrl 现在上报「自动刷机」和「人工刷机」，别的后端可能上报别的），再按它给的字段填。CLI 用 `boardlab lab methods <实验室> [--host <主机>] [--slot <主机>/s4]` 看有哪些方式、字段和可选项，用 `boardlab lab discover <实验室> --method <方式> [--set 字段=值 …] [--host] [--slot] [--yes]` 运行。
- `boardlab slots boardctrl` 列出 boardctrl 主机上还没有板子用的串口和下载口。没有按钮/复位线、已经由人按住 BOOT 进了下载模式的板子，用 `boardlab lab discover boardctrl --method bind --host <主机> --set usb=<下载口> --set console=<串口> --set soc=<SoC> [--set sdk=<SDK>] [--set board=<型号>] [--set name=<板名>] --yes` 登记；先 `boardlab lab methods boardctrl --host <主机>` 看当前字段和可选项。多个下载口/串口时不会替你猜，按 `labPorts`（`boardlab slots`）或 `lab methods` 的选项指定。
- 登记后板子的 SDK 由它的 SoC 和 boardctrl 的 SDK 目录决定；要改 SoC/SDK 用 `boardlab set <板子> --soc <SoC> [--sdks a,b]`，或网页板子页的「改登记」。`boardlab set --model <型号>` 记型号。
- 自动发现（boardctrl 的「自动刷机」）会让实验室逐个拉没人用的复位线，会复位板子，只在用户要求时运行；找到的是改动建议，`boardlab proposals apply <id> [--name <板名>]` 才登记。知道这批板子接在哪些排针上时给它 `--set prefer=12,13` 先试那些 GPIO（`12,13`、`GPIO12`、`gpio_13`、`P15` 等写法由后端认）。
- 发现卡住或用户不想要了：`boardlab lab cancel <实验室>`，不要等（会停在当前这一步，已经登记的留着）。

## 模块和模块市场

boardd 能做什么由它装的模块决定。`boardlab module` 列出装了的模块：每个是什么、要什么（`inject`）、给什么（`provide`）、在不在跑；不在跑的会说为什么（等着哪个服务、或者起不来）。`boardlab module search <文字>` 按名字、说明和标签在**装了的**和**市场里的**模块里一起找。

市场里的模块不是随 boardlab 发的：`boardlab market` 列出这台机器加了哪些市场，`boardlab market show <市场>` 看一个市场提供什么，`boardlab market add <市场> <git 地址>` 加一个。装哪个由 boardd 的配置说（`boardd.json` 的 `modules` 里写模块名和它的设置），**改完要重启 boardd 才生效**；市场更新同理（`boardlab market update --all` 会列出哪个模块的代码变了）。

- 不要为了让某个模块工作去改 boardd 的状态目录或市场复制品里的文件：那是 git 的复制品，`market update` 会盖掉。要改就去改市场仓库。
- 一个模块在 `boardlab module` 里是「等着」，说明它 `inject` 的服务没人提供：看是哪个模块没装或起不来，别硬重启。
- 装了什么模块、某个模块为什么不在跑，先看 `boardlab module --json` 再说，不要猜。

## 全部接口

要看 boardd 提供的全部接口：网页上的「API」页按模块列出来，机器可读的是 `GET /api/openapi.json`（OpenAPI 3.1，和 `GET /api` 的列表一致）。CLI 没覆盖到的接口，可以先在这里找，再用 `boardlab` 自己的命令或 HTTP 调（地址见 `boardlab remote show`）。

## boardlab 本身不够用时：一定提 feedback

**只要碰到框架不合理或者有漏洞，就提一条 feedback，哪怕你已经自己绕过去、任务也做完了。** 你绕过去了，下一个 agent 还会再踩一遍；只有提了，维护的人才会知道、才会修。

下面这些情况都要提：

- 命令报“成功”，结果没生效。例如改了目录，主机还在用旧的；说刷完了，板子没变。
- 输出和事实对不上。例如 `--json` 说 ok，文字输出却说失败；状态显示的和串口看到的不一样。
- 为了做完任务，你做了 skill 明确说不要做的事（直接改主机上的 yaml、直接调 `boardctrl`、ssh 到主机），或者绕了很多步。
- 少了接口或字段，只能猜，或者只能从别的地方拼出来。
- 文档、帮助和实际行为不一致。
- 报错没说清原因，或者提示的办法不管用。

什么时候提：**一发现就提，不要等任务做完**，免得忘了。用户的任务照常往下做，提 feedback 不用停下来问用户。最后汇报时，一句话说明提了哪一条（`#编号`）。

写什么：哪里不对，你怎么绕过去的，希望框架提供什么。

用法如下：
`boardlab feedback "<哪里不够用、现在只能怎么绕开、希望提供什么>" [--kind bug|api|design|feature|other] [--subject "<标题>"] [--context '<JSON>']`
boardd 把它存在数据库里，维护 boardlab 的人下次会看到并修复。先 `boardlab feedback list` 看看有没有人提过，不要重复提同一条；这条是给维护者的，用户要的结果仍然要在回答里给。
不在 `boardlab` 手边（比如从脚本里）也可以直接走 HTTP：`GET /api/feedback?status=open` 看已经有了什么，`POST /api/feedback`（`kind`、`subject`、`body`、`context`）提一条，维护者用 `POST /api/feedback/resolve`（`id`、`status`、`note`）关掉。地址和 CLI 连的是同一个 boardd（`boardlab remote show`），网页上的「反馈」页也能看到待处理的。

## 规则

- `boardlab lab discover <实验室> --method <方式>` 会让实验室复位没人用的板子去找新板，只在用户要求时运行；先 `lab methods` 看后端上报了哪些方式。
- 扫描（`boardlab scan --yes`）会逐个切换槽位上的板子，并重启所有串口守护进程。只要有任何一块板被拿着锁，boardd 就拒绝扫描；不要为了扫描去放别人的锁。
- 烧录、擦除、修改板上的持久配置（`saveenv`、写 EEPROM 等）可以在持锁时做，结论里写明做了什么、用的什么镜像。
- 抢别人的锁只有人能做，你只能请用户处理。
- 等板子、等编译、等刷机用阻塞等待（`--wait`/`--timeout`/任务跟着走），不要 `sleep` 盲等，见上面「等结果，不要 sleep」。

`boardlab stage <board> <固件名>` 只往内存加载 boardd 自带、sha256 和 `firmware.json` 一致的固件（`boardlab firmware` 列出），不会写板子；用之前仍要说明目的。`minor-board-info` 是扫描读型号用的，读完就停住。

要在板子上启动编好的内核、FSBL 或 U-Boot/OpenSBI（`boardlab boot` 内存启动，或 TFTP/PXE 网络启动），先读 [boot.md](boot.md)。

## 留证据

结论要附上 `boardlab log` 的相关输出，或扫描记录（`boardlab show <board>`）。不要只凭记忆说"板子已经启动"。
