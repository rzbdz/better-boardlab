# boardlab

开发板管理平台

boardlab 是一套开发板管理平台，包含服务 boardd、命令行 `boards`、本机网页，以及教 Claude 使用命令行的 skill（`skills/boards`，启动内核另见 `skills/boards/boot.md`）。人和 Claude 共用同一套开发板锁和排队。本机的板子只通过以下三条路径接触：

- Home Assistant：复位开关和 fastboot 按钮；
- serial-mux：串口读写；
- `fastboot`：往内存加载 boardd 自带的固件，或按顺序加载启动文件做内存启动。

远程实验室的板子只通过实验室自己的后台接口和它的跳板机接触，见「远程实验室」。

## 模型

- **槽位**：控制器上的一路，含一个复位实体（`switch.*`，`turn_on` 产生复位脉冲）和一个 fastboot 实体（`button.*`）。控制器以外的板子可以用自定义槽位，见下文。
- **板子**：占用一个槽位，可以有多颗芯片。锁加在整块板上，因为复位会影响整块板。
- **芯片**：每颗芯片有自己的串口，可能还有自己的下载口（USB 端口路径，例如 `3-2.3`）。串口按 `/dev/serial/by-path/...` 登记，并记下对应的 serial-mux 别名。不用 by-id，是因为没有序列号的转接头在 by-id 下会共用同一个名字。Espressif 的 USB 串口是复位控制器本身，打开它可能把控制器复位，所以扫描时会跳过。
- **数据库**：boardd 用自己的 SQLite 数据库（文件权限 600），需要时可以导出 TOML。板子只来自确认过的扫描结果或手工登记，不从任何旧文件导入。Home Assistant 的地址和令牌在网页「设置」里填写。槽位由 boardd 自己维护：HA 验证通过时、boardd 启动时和每次扫描前，都会从 HA 读出名字形如 `board_N_reset` 的开关和 `board_N_fastboot_mode` 的按钮，归到槽位 N，不需要人确认。HA 里不见了的槽位会被删掉，除非上面还登记着板子。

### 自定义槽位

Home Assistant 控制器管不到的板子（例如接在米家插座上、靠断电重启的板子），可以在网页「设置」里添加自定义槽位：填一个槽位号，贴上复位脚本，fastboot 脚本可选。CLI 用 `boards slot set <n> --reset-script <文件> [--fastboot-script <文件>] [--label <名称>]` 和 `boards slot remove <n>`。

- 没有 fastboot 脚本的槽位只能复位，`fastboot` 会被拒绝。
- 脚本在 boardd 所在机器上以 boardd 的用户身份运行：首行有 `#!` 就用指定的解释器，否则用 bash。环境变量 `BOARDS_SLOT`、`BOARDS_ACTION`（`reset` 或 `fastboot`）和 `BOARDS_BOARD` 告诉脚本是谁在调用。超过 2 分钟没结束会连同它启动的进程一起终止；退出码不是 0 算失败，输出的最后几行会记进操作记录。
- 控制器已经用了的槽位号不能再用；以后控制器报出同一个号，自定义槽位保持不变。槽位上还有板子时不能删除。
- 网页上任何人都能新建和修改脚本，等于能在这台机器上执行命令，所以网页只应开放给可信的网络（见「安全边界」）。
- **在线串口**：只有 serial-mux 守护进程确实绑着设备的串口，才能打开控制台或输入；没绑设备的串口会显示「未绑定设备」。

## 远程实验室

别人维护的板子集群，boardd 也能接进来，用法和本机的板子一样：同样拿锁，同样 `reset`、`fastboot`、`console`、`send`、`stage`、`boot`。boardd 看板子在哪个实验室，用那个实验室的驱动做这四件事：复位、进下载模式、串口、往下载口加载文件。

现在支持的实验室：

- `bmc`：SpacemiT BMC 集群管理系统。复位和进下载模式走 BMC 的 HTTP 接口（Basic 认证），串口走 BMC 的 WebSocket，`stage` 和 `boot` 通过 ssh 在集群主机上跑 `fastboot`。
- `abmc`：Firefly aBMC 机架。aBMC 本身就是跳板机，boardd 全部经 ssh 过去：接口（会话令牌）和串口（aBMC 的 webtty WebSocket，历史来自它自己采集的串口日志）都走 `ssh -W` 转发的连接，复位用 `PowerCycle`，进下载模式用 `LoaderByHardware`。aBMC 不告诉哪个 USB 口是哪块板，boardd 在板子进下载模式时看跳板机上新出现的下载口记下来，所以同一时间只让一块板进下载模式；`boot` 之前要先 `fastboot` 过一次。

在网页「设置」里开启实验室，填后台地址、账号和密码；跳板机留空时用驱动的默认值（`bmc` 是 `ubuntu@<后台主机>`，`abmc` 是 `bmc@<后台主机>:2222`），ssh 用 boardd 所在用户自己的密钥，不提示密码。跳板机要经别的机器才能到时，在这个用户的 `~/.ssh/config` 里给它配 `ProxyJump`，boardd 不用改。「只用这些板子」填设备名或带 `*` 的模式（例如 `sub0-* sub1-*`），留空列出全部。

- 开启时先验证后台和跳板机，再列出板子；之后每分钟刷新一次，boardd 启动时也会刷新。每块板登记成 `<实验室>-<设备名>`（例如 `bmc-sub0-0`），芯片的串口和下载口是实验室那边的（BMC 读的串口、跳板机上的 USB 路径）。
- 实验室的板子不占槽位，不参加扫描，不导出 TOML，也不能手工删除：改范围或关掉实验室，它们就从清单里去掉。有人拿着锁的板子先留着，放锁后下次刷新再去掉；有锁时不能关实验室。
- 串口「在线」指实验室那边的串口读取正常，来自最近一次刷新；打开控制台和输入时不看它，直接问实验室。BMC 在板子断电重启后会读不到串口，boardd 每次复位和进下载模式后都会让它重新打开串口。
- 文件按 sha256 存在跳板机的 `~/.cache/troy-boards/files/` 里，传完先核对 sha256 才用；同一个文件不重复传，3 天没用的会删掉。跳板机的账号要能打开 SpacemiT 的下载口（USB 厂商号 `361c`），否则 `boot` 会报没有 USB 权限，要在跳板机上加 udev 规则。跳板机上没装 `fastboot` 时，boardd 用 `~/.cache/troy-boards/bin/fastboot`。
- 实验室的串口没有 boardd 的输入闸门：能登录实验室后台的人都能输入，锁只约束经过 boardd 的操作。

## 锁

| 操作 | 是否要锁 |
| --- | --- |
| 查看状态、读串口输出、看日志和历史 | 不要 |
| 串口输入、复位、fastboot、往内存加载固件 | 要 |

- 持有人格式：`user:<名字>`、`claude:<会话>`、`dsh:<对话>`、`workspace:<项目>/<成员>`。后台启动的 Claude 自动带上 `BOARDS_HOLDER`，不用自己设。
- 锁没有时间限制，持有到本人放锁或被人抢走为止。
- 拿锁时返回一个凭证，凭证只以哈希形式保存。agent 操作时要带凭证；人凭自己的持有人名操作，不必携带。持有人再次拿锁会换发新凭证，旧的随即失效。
- 被占用时可以排队，按先来后到。放锁时，锁自动交给排在第一位的人，并通知他。
  - 网页上点「排队」，或用 `boards queue`，会一直排着，直到本人退出排队（`boards unqueue`）。
  - `boards lock --wait` 会一直等到拿到锁；中途退出时，也会退出排队。
- 网页上，每个人在右上角填自己的名字，排队和锁就按名字区分。不填时，使用 boardd 所在机器的用户名。
- 抢锁只允许人操作，必须写明原因。抢锁会被记录，原持有人会收到通知，排队顺序不变。
- 锁和排队都存在数据库里，boardd 重启后都不丢。

### 串口闸门

拿锁时，boardd 会给这块板每颗芯片的串口打开 serial-mux 输入闸门，放锁时关掉；锁交给排队的下一个人或被抢走时，闸门换成新持有人的 token。闸门开着时：

- 所有人照常能看串口输出和历史；
- 通过 boardd 输入（网页控制台、`boards send`）由 boardd 自动带上 token；
- 直接用 `smtty` 输入要带 `--token`（或 `SERIAL_MUX_TOKEN`）。`boards lock` 会打印这个 token；不带的 `smtty` 会被提示「已锁定」以及谁在用，输入被丢弃。

没人拿锁时串口是放开的，直接用 `smtty` 也能输入。闸门需要支持 `input-gate` 的 serial-mux；遇到旧版，拿锁照样成功，但板子卡片上会显示「闸门未生效」，并记进操作记录，不会悄悄放过。serial-mux 守护进程重启后闸门会丢，boardd 在恢复串口、应用扫描结果和自身启动时会按锁重新设置。

## 内存启动

`boards boot <板子>[.<die>] <文件>...` 通过这颗芯片的下载口按顺序加载启动文件，通常是 FSBL、U-Boot/OpenSBI、内核 FIT：每个文件 `stage` 后 `continue`，再等下载口重新出现才加载下一个（第一个之后先等 8 秒，之后 3 秒，最多再等 20 秒；没回来就停下并报出是第几个文件）。每个参数是绝对路径，或 boardd 自带固件的名字（见下一节）；boardd 加载前算 sha256，每一步连同文件路径记进操作记录。只改内核时：`boards boot <板子> fsbl u-boot-opensbi /path/Image.itb`。要持锁，先用 `boards fastboot` 让板子进下载模式：Home Assistant 的 fastboot 按钮在按键序列开始时就应答，板子约 2 秒后才复位，所以 `boards fastboot` 按完再等 6 秒才返回，返回时板子已经在下载模式。只写内存，不烧录、不改板上配置。

文件从哪来、只改内核和改了固件时分别用哪套、TFTP 怎么做，写在给 Claude 的 [`skills/boards/boot.md`](skills/boards/boot.md) 里。

## 自带固件

boardd 用的固件放在仓库的 [`firmware/`](firmware/README.md) 里，[`firmware.json`](firmware/firmware.json) 就是登记表：每条写 SoC、用途（名字）、文件和 sha256。每次加载前 boardd 都重新核对 sha256，对不上就拒绝；要换或加固件就改这里再提交，没有别的登记方式。`boards firmware` 和网页「设置」里能看到当前这份清单。

| 名字 | 用途 |
| --- | --- |
| `minor-board-info` | 一键扫描固定用它读 K3 板子的型号 |
| `fsbl`、`u-boot-opensbi` | 只改内核时内存启动的前两个文件 |

`boards stage <板子> <名字>` 单独加载其中一个，例如 `boards stage com260 minor-board-info`。

## 一键扫描

扫描只认 K3 boot ROM（USB `361c:1001`），其他下载口标成「型号未知」。扫描前必须确认。只要有任何一块板被拿着锁（包括发起扫描的人自己拿着的），就不开始；开始时一次拿到范围内所有板子的锁。

对每个槽位：

1. 按两次 fastboot。进入 boot ROM 下载模式的板子只打印一次横幅，之后保持安静，所以已经扫过的板子不会干扰后面的槽位。
2. 两次都有响应的串口，归入这个槽位。
3. 第一次按下后新出现的 USB 设备，就是这个槽位的下载口。
4. 对每个 K3 下载口，用 `fastboot stage` + `continue` 把自带的 minor-board-info 固件加载到内存，再从这颗芯片的串口读出型号。

只能复位的自定义槽位改按两次复位：两次都打印启动日志的串口归入这个槽位（每次复位前会等所有串口安静下来，最长 60 秒）。这种槽位没有下载口，读不到型号，所以它的新板子建议要由应用的人填板名；它的板子已经在正常启动，扫描结束时不会再复位一次。

扫描开始前会停掉所有 serial-mux 守护进程，再给每个串口起一个新的临时守护进程（`port-<USB 口>`），不沿用扫描前的任何名字或绑定。应用扫描结果时，每个认出来的串口的守护进程会以板名重新启动（多芯片板为 `<板名>-<die>`）。

所有动过的槽位最后都会复位，恢复正常启动。扫描结果先作为改动建议列出（新板、换板、串口或下载口变了），用户确认后才写入清单。原始串口片段和 USB 变化会作为证据保存。

扫描从不烧录、擦除或改写板上的持久配置。

## 安全边界

- 网页默认只监听 `127.0.0.1`。`serve --host <地址>` 可以额外监听别的地址，例如 Tailscale 地址。能访问这些地址的人都以运行 boardd 的本机用户身份操作，所以只应开放给自己可信的网络。不在监听列表里的 Host 头、以及跨站的写请求，一律拒绝。
- Home Assistant 的服务调用每次都新建连接。只有在连接都没建立、请求肯定没到达时才重试；连接建立后从不重发，避免一次操作按下两次。
- CLI 通过状态目录里的 Unix socket（权限 600）访问 boardd。
- Home Assistant 令牌和实验室密码只能写入：它们不出现在接口返回、网页、日志或操作记录里。
- 去实验室跳板机的 ssh 用 boardd 所在用户的密钥（`BatchMode`，连接复用的 socket 在状态目录的 `ssh/` 下）。boardd 只在跳板机上跑固定的命令：检查和传文件、`fastboot -s usb:<路径> stage|continue`、读 sysfs 里的 USB 设备；`abmc` 还经 `ssh -W` 连 aBMC 自己的 web 端口，连接已经由 ssh 认证到了跳板机，所以不校验 aBMC 自签名的证书。
- 自定义槽位的脚本以 boardd 的用户身份执行，能访问网页的人都能修改它们。
- 锁和串口闸门用来防止误操作，不是安全边界：同一个系统用户总能绕过 boardd 停掉守护进程、直接打开设备。闸门 token 和锁一起存在数据库里，只在拿锁的结果里返回给持有人。

## 运行

```sh
pnpm install
pnpm run build
node dist/cli.js serve        # 默认 http://127.0.0.1:38127/
# 在网页「设置」里填写 Home Assistant 地址和令牌，槽位会自动同步
# （或：echo <令牌> | boards ha set <地址> --token-stdin）
node dist/cli.js scan         # 发现板子；确认后用 boards proposals apply 写入
node dist/cli.js list
```

Claude 用的 `boards` 命令和 skill 要装到它能找到的地方：

```sh
ln -s "$PWD/dist/cli.js" ~/.local/bin/boards
ln -s "$PWD/skills/boards" ~/.claude/skills/boards   # Claude 用的配置目录不是 ~/.claude 时换成那个目录
```

Claude 运行时的 PATH 里要有 `~/.local/bin`，才找得到 `boards`。

## 开发

```sh
pnpm run typecheck
pnpm test
```

状态目录默认是 `~/.local/state/troy-boards`，可以用 `BOARDS_STATE_DIR` 或 `--state-dir` 改。端口用 `--port` 改；额外的监听地址用 `--host` 或 `BOARDS_HOSTS`（逗号分隔）。完整命令列表见 `boards help`。
