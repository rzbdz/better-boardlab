---
name: boardlab
description: 通过 boardlab CLI 使用实验室开发板和 SDK：先拿锁，再复位、fastboot、看串口、发命令；在构建服务器上租 SDK 源码树、编译、改代码（boardlab sdk）；用 SDK 的产物或本机文件内存启动、刷机，或用刷机包（链接或文件）刷机；用完放锁。要操作开发板、编译并在板子上验证内核或固件、看板子串口输出、找新接上的板子时使用。
---

# 开发板（boardlab）

所有开发板都由中心的 boardd 统一管理（这台机器上的 `boardlab` 已经连到它，`boardlab remote show` 可以看）。人、Claude 和 DSH 遵守同一套锁规则；不要绕过它直接用 `smtty`、`serial-mux`、`fastboot`、Home Assistant 或 `bsp`：板子在哪台主机、怎么连，只有 boardd 知道，你这边不需要也不应该配置。

## 身份

每条命令都以你的会话身份执行。后台启动的 Claude 已经设好环境变量 `BOARDS_HOLDER`（`claude:<会话 ID>`，协作项目成员是 `workspace:<项目>/<成员>`），不要改它；`echo $BOARDS_HOLDER` 为空时，才自己设：

```sh
export BOARDS_HOLDER=claude:<当前会话 ID>
```

## 基本流程

```sh
boardlab list --json                         # 先看有哪些板、谁在用
boardlab lock com260 --for "调试 U-Boot 网络"  # 拿锁；被占用时退出码 3
boardlab reset com260
boardlab send com260 'printenv ethaddr' --wait '=> ' --timeout 10s
boardlab log com260 --lines 200
boardlab unlock com260                       # 锁没有时间限制，用完一定要放锁，排队的人才能拿到
```

- 别人持有锁时只能看（`list`、`show`、`log`、`console`），不能输入或控制。要等就排队，先到先得：
  - `boardlab lock <board> --for ... --wait`：一直等到拿到锁；
  - `boardlab queue <board> --for ...`：只排队不等，轮到你时锁自动归你，再运行 `boardlab lock <board> --for ...` 取凭证。
- 持锁期间串口有 serial-mux 输入闸门：`boardlab send` 自动通过；确实需要直接用 `smtty` 时，带上 `boardlab lock` 打印的 `--token`。不带 token 的输入会被丢弃，`smtty --send` 以退出码 3 报「已锁定」。
- 自定义槽位上没有 fastboot 脚本的板子只能复位，`boardlab fastboot` 会报「只能复位」；不要为此去改槽位脚本，脚本由用户维护。
- 认板子只看 `boardlab list` 和扫描结果，不要猜 `/dev/ttyUSBn`。
- `boardlab list` 里标着 `[实验室 <名字> <设备>]` 的板子在远程实验室（例如 `bsp-k3-a`），命令完全一样，`boot` 给的仍是本机的绝对路径，boardd 会传到实验室那边。实验室的板子别人也可能在实验室后台直接用，串口没有输入闸门；看到不是你发的输入或复位，停下来告诉用户。
- 实验室 `bsp` 的板子（`bsp-<dut>`，例如 `bsp-board-1`）在 bsp 管理的板卡主机上。拿锁时 boardd 同时替你持有 bsp 的租约，所以只用 `boardlab` 命令操作它们，不要再用 `bsp dut acquire/reset/boot` 去动同一块板。要在构建服务器上租 SDK 源码树、编译、改代码，用 `boardlab sdk …`（见下一节）。
- 卡片或 `boardlab show --json` 里 `lab.attention` 不为空时，板子在等人按 RESET 之类的操作（由人复位的板子）：复位、boot 放到后台跑，把提示原样告诉用户，用户说做完了再 `boardlab confirm <board>`。不要自己猜着确认。
- `lab.heldBy` 不为空表示有人直接在 bsp 里租着这块板，拿锁会失败；要等就 `boardlab queue`。
- 后端能单独控制继电器的板子（bsp 主机；`boardlab relay <board>` 会说这块板能不能），持锁时可以直接控制它的线：`boardlab relay <board>` 列出继电器和按钮，`boardlab relay <board> power pulse --ms 3000` 断电三秒再上电，`boardlab relay <board> boot press` 按住 BOOT（用完 `release`）。复位和进下载模式仍然用 `reset`、`fastboot`；只在用户要求、或这两条做不到时才直接动线，并说明动了哪根。
- 实验室的板子都在槽位里（`boardlab list` 里的「槽位 host1/s3」）。所有命令都可以用槽位名代替板名：`boardlab lock host1/s3 --for …`、`boardlab console host1/s3`。在同一个槽位上换着板子反复测试时，用槽位名，不用管板子叫什么。
- 「空槽位」是还没登记板子的串口：可以拿锁、`boardlab console` 看，用户要求时 `boardlab lab discover bsp --slot <主机>/s4 --yes` 在上面找板子（会复位没登记的线），找到就登记。
- 用户说槽位里换了板子：拿锁后 `boardlab refresh <槽位>`（`--name <新名字>` 或 `--rename` 按读到的型号改名），不要 remove 再重新发现；锁跟着槽位走。
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
  `boardlab cancel <board>`，不要让它一直挂着。
- **板子在等人**（`lab.attention`）：等用户，不要 sleep 猜；用户说做完了再 `boardlab confirm <board>`。
- **确实没有阻塞接口时才轮询**：间隔从短到长（0.5 秒、1 秒、2 秒…）并设总超时，拿到结果立即继续。

## SDK：编译、改代码、启动

SDK 源码树在构建服务器上，也通过 boardlab 用（boardd 那边的 bsp 执行，用法和 `bsp sdk` 一样，`boardlab sdk help` 列出全部）：

```sh
boardlab sdk list                                   # 有哪些 SDK、在哪台构建服务器
boardlab sdk acquire sdk-a --task fix-usb        # 租源码树：切到任务分支 bsp/fix-usb；用完一定 release
boardlab sdk exec sdk-a -- git -C linux-6.18 log --oneline -3
boardlab sdk get sdk-a linux-6.18/drivers/usb/x.c -o x.c     # 取到本机改
boardlab sdk put sdk-a linux-6.18/drivers/usb/x.c x.c        # 改完写回（要持有租约）
boardlab sdk build sdk-a kernel                  # 编译，输出实时显示，退出码就是结果
boardlab sdk release sdk-a
```

编好以后在板子上验证，不用把产物拷来拷去：

```sh
boardlab lock bsp-board-1 --for "验证 fix-usb"
boardlab boot bsp-board-1 --sdk sdk-a        # 内存启动：板子所在主机自己去构建服务器取产物
boardlab flash bsp-board-1 --sdk sdk-a       # 要烧录到板子上时才用；先说明原因
boardlab log bsp-board-1 --lines 300            # 看串口确认真的起来了
boardlab unlock bsp-board-1
```

- `boardlab show <board> --json` 里 `lab.sdks` 是这块板能跑的 SDK；不在里面的不要硬启动。
- 本机文件（例如自己打的 FIT）照样 `boardlab boot <board> fsbl u-boot-opensbi ./Image.itb`，文件会自动传过去。
- 只在调 U-Boot 或它加载的内核时：`boardlab boot <board> --sdk <sdk> --break uboot` 停在 U-Boot（recipe 里有 `breaker: uboot` 才行；页面启动对话框也会列出来）。之后在串口里自己操作。
- 启动或刷机卡住了用 `boardlab cancel <board>`：任务在这一步之后停，板子回到你手里。
- 现成的刷机包（用户给的链接或本机文件）用 `boardlab flash <board> <链接|文件> [--flasher <工具>]`：http(s) 链接由板子所在主机自己下载，本机文件先传给 boardd。同样要拿锁，会改写板子的存储，先说明原因；`lab.canFlashPackage` 为 false 的板子不支持。

## 给 SDK 加启动或刷机方法

SDK 的定义（构建服务器、路径、组件、产物、load 内存启动和 download 刷机两套步骤）在中心的 SDK 目录里，改了会马上推到每台板卡主机。**不要去改任何机器上的 yaml 文件**（板卡主机的 site、本机的 ~/.config/bsp）：那些副本不会生效，下次部署还会被覆盖。

```sh
boardlab registry sdk get sdk-a -o sdk-a.yaml       # 第一行记着版本号，别删
# 编辑 sdk-a.yaml
boardlab registry sdk put sdk-a -f sdk-a.yaml --check                       # 只校验：整个目录带着改动加载、所有流程排一遍
boardlab registry sdk put sdk-a -f sdk-a.yaml -m "加 download：按厂商 fastboot_flash.sh 逐分区烧"
boardlab registry sdk recipe sdk-a download -f steps.yaml -m "…"            # 只改一套步骤
boardlab registry sdk history sdk-a                 # 谁改的、为什么；rollback sdk-a <版本> 回到旧版
boardlab registry hosts                             # 每台主机拿到的目录版本
```

- 板卡主机上的 site 文件（/opt/bsp-dev-loop/site/…）改了不生效：`boardlab registry hosts` 会把它列成 NOT IN EFFECT。要生效就 put 进目录。怀疑主机拿的不是最新版本，`boardlab registry refresh`。
- 别人在你之后改过同一个文档，put 会报冲突：重新 get、把你的改动做在新版本上再 put，不要 `--force` 盖掉别人的。
- 校验不过（引用了不存在的服务器、产物或步骤）什么都不会写，按报错改。
- 新流程没在硬件上验证过，`-m` 里写明；第一次用它刷机前告诉用户。

## 新接上的板子

- `boardlab slots bsp` 列出 bsp 主机上还没有板子用的串口和下载口；`boardlab bind bsp --host <主机> --console <串口> --usb <下载口>` 把它们登记成一块由人复位的板子（临时调试用，默认名 `tmp-<主机>-<串口>`，用完 `boardlab remove`）。
- `boardlab lab discover bsp [--human --host <主机>]` 让实验室自己找新板子，会复位板子，只在用户要求时运行；找到的是改动建议，`boardlab proposals apply <id> [--name <板名>]` 才登记。

## boardlab 本身不够用时

用的时候发现 boardlab 的架构、某个接口或设计做不到你要做的事（少了字段、要绕很多步、行为和文档不符），不要只在回答里说一句：
`boardlab feedback "<哪里不够用、现在只能怎么绕开、希望提供什么>" [--kind bug|api|design|feature|other] [--subject "<标题>"] [--context '<JSON>']`
boardd 把它存在数据库里，维护 boardlab 的人下次会看到并修复。先 `boardlab feedback list` 看看有没有人提过，不要重复提同一条；这条是给维护者的，用户要的结果仍然要在回答里给。

## 规则

- `boardlab lab discover <实验室>` 会让实验室复位没人用的板子去找新板，只在用户要求时运行。
- 扫描（`boardlab scan --yes`）会逐个切换槽位上的板子，并重启所有串口守护进程。只要有任何一块板被拿着锁，boardd 就拒绝扫描；不要为了扫描去放别人的锁。
- 烧录、擦除、修改板上的持久配置（`saveenv`、写 EEPROM 等）可以在持锁时做，结论里写明做了什么、用的什么镜像。
- 抢别人的锁只有人能做，你只能请用户处理。
- 等板子、等编译、等刷机用阻塞等待（`--wait`/`--timeout`/任务跟着走），不要 `sleep` 盲等，见上面「等结果，不要 sleep」。

`boardlab stage <board> <固件名>` 只往内存加载 boardd 自带、sha256 和 `firmware.json` 一致的固件（`boardlab firmware` 列出），不会写板子；用之前仍要说明目的。`minor-board-info` 是扫描读型号用的，读完就停住。

要在板子上启动编好的内核、FSBL 或 U-Boot/OpenSBI（`boardlab boot` 内存启动，或 TFTP/PXE 网络启动），先读 [boot.md](boot.md)。

## 留证据

结论要附上 `boardlab log` 的相关输出，或扫描记录（`boardlab show <board>`）。不要只凭记忆说"板子已经启动"。
