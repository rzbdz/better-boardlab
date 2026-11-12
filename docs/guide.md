# boardlab guide

## 模型

- **槽位**：控制器上的一路，含一个复位实体（`switch.*`，`turn_on` 产生复位脉冲）和一个 fastboot 实体（`button.*`）。控制器以外的板子可以用自定义槽位，见下文。
- **板子**：占用一个槽位，可以有多颗芯片。锁加在整块板上，因为复位会影响整块板。
- **芯片**：每颗芯片有自己的串口，可能还有自己的下载口（USB 端口路径，例如 `3-2.3`）。串口按 `/dev/serial/by-path/...` 登记，并记下对应的 serial-mux 别名。不用 by-id，是因为没有序列号的转接头在 by-id 下会共用同一个名字。Espressif 的 USB 串口是复位控制器本身，打开它可能把控制器复位，所以扫描时会跳过。
- **数据库**：boardd 用自己的 SQLite 数据库（文件权限 600），需要时可以导出 TOML。板子只来自确认过的扫描结果或手工登记，不从任何旧文件导入。Home Assistant 的地址和令牌在网页「设置」里填写。槽位由 boardd 自己维护：HA 验证通过时、boardd 启动时和每次扫描前，都会从 HA 读出名字形如 `board_N_reset` 的开关和 `board_N_fastboot_mode` 的按钮，归到槽位 N，不需要人确认。HA 里不见了的槽位会被删掉，除非上面还登记着板子。

### 自定义槽位

Home Assistant 控制器管不到的板子（例如接在米家插座上、靠断电重启的板子），可以在网页「设置」里添加自定义槽位：填一个槽位号，贴上复位脚本，fastboot 脚本可选。CLI 用 `boardlab slot set <n> --reset-script <文件> [--fastboot-script <文件>] [--label <名称>]` 和 `boardlab slot remove <n>`。

- 没有 fastboot 脚本的槽位只能复位，`fastboot` 会被拒绝。
- 脚本在 boardd 所在机器上以 boardd 的用户身份运行：首行有 `#!` 就用指定的解释器，否则用 bash。环境变量 `BOARDS_SLOT`、`BOARDS_ACTION`（`reset` 或 `fastboot`）和 `BOARDS_BOARD` 告诉脚本是谁在调用。超过 2 分钟没结束会连同它启动的进程一起终止；退出码不是 0 算失败，输出的最后几行会记进操作记录。
- 控制器已经用了的槽位号不能再用；以后控制器报出同一个号，自定义槽位保持不变。槽位上还有板子时不能删除。
- 网页上任何人都能新建和修改脚本，等于能在这台机器上执行命令，所以网页只应开放给可信的网络（见「安全边界」）。
- **在线串口**：只有 serial-mux 守护进程确实绑着设备的串口，才能打开控制台或输入；没绑设备的串口会显示「未绑定设备」。

## 远程实验室

别人维护的板子集群，boardd 也能接进来，用法和本机的板子一样：同样拿锁，同样 `reset`、`fastboot`、`console`、`send`、`stage`、`boot`。boardd 看板子在哪个实验室，用那个实验室的驱动做这四件事：复位、进下载模式、串口、往下载口加载文件。

每个实验室是某个后端模块的一个实例，实例名写在 boardd 的配置里（见「模块和配置」），板子登记成 `<实例名>-<设备名>`。现在有的后端：

- `bsp` 模块：bsp 管理的板卡主机（[bsp-remote-dev-workflow](https://github.com/rzbdz/bsp-remote-dev-workflow)，子模块 `externals/bsp`）。boardd 只通过 bsp 命令行（`--json --stateless`）操作它们：列表、租约、复位、进下载模式、`stage`、`boot` 都是 `bsp dut …` 命令，串口走 `bsp dut pipe`（在板卡主机上把 serial-mux 的协议原样转过来，boardd 用自己的 serial-mux 客户端读写）。有哪些主机由 bsp 自己的配置决定：bsp site 的 `remotes.json`，或主机自己上报的 registry（设置里填 registry 地址）。拿锁时 boardd 同时持有这块板的 bsp 租约（持有人 `boardlab:<你>`），每分钟续一次，锁转给别人时改名，放锁后归还；有人直接在 bsp 里租着板子时，卡片上显示「实验室占用」，拿锁会排队，等对方释放后自动交给排第一的人。`boot` 整个交给 `bsp dut boot --files`，由 bsp 的忙碌保护和日志覆盖整个过程。

在网页「设置」里开启实验室，填后台地址、账号和密码（`bsp` 实验室这三项都可以留空）；「只用这些板子」填设备名或带 `*` 的模式（例如 `sub0-* sub1-*`），留空列出全部。

- 开启时先验证后台，再列出板子；之后每分钟刷新一次，boardd 启动时也会刷新。每块板登记成 `<实验室>-<设备名>`（例如 `bsp-k3-a`），芯片的串口和下载口是实验室那边的。
- 板卡主机接上或拔掉串口线、USB 线时，会马上告诉 bsp registry；boardd 一直跟着 registry 的消息（`bsp watch --registry`），收到后马上重新问空闲端口、刷新板子，网页弹出提示（「lab-1 新接上 /dev/ttyUSB3」）。这条消息流断了，下一次每分钟的刷新会重新接上。
- 实验室的板子不占槽位，不参加扫描，不导出 TOML，也不能手工删除：改范围或关掉实验室，它们就从清单里去掉。有人拿着锁的板子先留着，放锁后下次刷新再去掉；有锁时不能关实验室。
- 串口「在线」指实验室那边的串口读取正常，来自最近一次刷新；打开控制台和输入时不看它，直接问实验室。有的实验室在板子断电重启后会读不到串口，boardd 每次复位和进下载模式后都会让它重新打开串口。
- 实验室的串口没有 boardd 的输入闸门：能登录实验室后台的人都能输入，锁只约束经过 boardd 的操作。
- **槽位**：bsp 主机上每个串口（插在某个物理 USB 口上的 USB 转串口）就是一个槽位，主机一看到它就给它起一个 serial-mux 串口。复位线、下载口和板子都是后来挂到槽位上的。还没有板子的槽位在 boardlab 里是一张「空槽位」卡片：可以拿锁、打开串口看和输入，点「发现这块板」（或 `boardlab lab discover bsp --slot <主机>/s4`）就在这个槽位上找板子，找到一块马上登记一块。每块板都有槽位名（卡片上的「槽位 host1/s3」），所有命令都能用它代替板名：`boardlab console host1/s4`、`boardlab lock host1/s3 --for …`。槽位里换了一块板子时不用删了重加：`boardlab refresh host1/s3 [--name <新名字> | --rename]`（卡片上的「重新读取」）重新读型号、SoC 和下载口；换了名字的板子还是这个槽位的记录，锁、排队和历史都跟着槽位走。重新理线以后，bsp 先试槽位以前用过的复位线。
- **下载模式短接的板子**：复位总是停在下载模式的板子，后端有办法让它从板载介质启动时（bsp 的 SoC 配置里的 `media_boot`），`boardlab reset` 就从介质启动；卡片和 `boardlab list` 写着复位会怎样。
- 后端的继电器控制器能单独控制板子的每根线时（bsp 主机的 gpio_relay），拿着锁可以直接断电重启、按住 BOOT：`boardlab relay <板子>` 列出这块板的继电器和按钮，`boardlab relay <板子> power pulse --ms 3000` 控制其中一个，网页卡片上是「继电器」。bsp 里别名在 `<板子>/` 下的线（`<板子>/reset`、`<板子>/power`……）都算这块板的。

## 锁

| 操作 | 是否要锁 |
| --- | --- |
| 查看状态、读串口输出、看日志和历史 | 不要 |
| 串口输入、复位、fastboot、往内存加载固件 | 要 |

- 持有人格式：`user:<名字>`、`claude:<会话>`、`dsh:<对话>`、`workspace:<项目>/<成员>`。后台启动的 Claude 自动带上 `BOARDS_HOLDER`，不用自己设。
- 锁没有时间限制，持有到本人放锁或被人抢走为止。
- 拿锁时返回一个凭证，凭证只以哈希形式保存。agent 操作时要带凭证；人凭自己的持有人名操作，不必携带。持有人再次拿锁会换发新凭证，旧的随即失效。
- 被占用时可以排队，按先来后到。放锁时，锁自动交给排在第一位的人，并通知他。
  - 网页上点「排队」，或用 `boardlab queue`，会一直排着，直到本人退出排队（`boardlab unqueue`）。
  - `boardlab lock --wait` 会一直等到拿到锁；中途退出时，也会退出排队。
- 网页上，每个人在右上角填自己的名字，排队和锁就按名字区分。不填时，使用 boardd 所在机器的用户名。
- 抢锁只允许人操作，必须写明原因。抢锁会被记录，原持有人会收到通知，排队顺序不变。
- 锁和排队都存在数据库里，boardd 重启后都不丢。

### 串口闸门

拿锁时，boardd 会给这块板每颗芯片的串口打开 serial-mux 输入闸门，放锁时关掉；锁交给排队的下一个人或被抢走时，闸门换成新持有人的 token。闸门开着时：

- 所有人照常能看串口输出和历史；
- 通过 boardd 输入（网页控制台、`boardlab send`）由 boardd 自动带上 token；
- 直接用 `smtty` 输入要带 `--token`（或 `SERIAL_MUX_TOKEN`）。`boardlab lock` 会打印这个 token；不带的 `smtty` 会被提示「已锁定」以及谁在用，输入被丢弃。

没人拿锁时串口是放开的，直接用 `smtty` 也能输入。闸门需要支持 `input-gate` 的 serial-mux；遇到旧版，拿锁照样成功，但板子卡片上会显示「闸门未生效」，并记进操作记录，不会悄悄放过。serial-mux 守护进程重启后闸门会丢，boardd 在恢复串口、应用扫描结果和自身启动时会按锁重新设置。

## 内存启动

`boardlab boot <板子>[.<die>] <文件>...` 通过这颗芯片的下载口按顺序加载启动文件，通常是 FSBL、U-Boot/OpenSBI、内核 FIT：每个文件 `stage` 后 `continue`，再等下载口重新出现才加载下一个（第一个之后先等 8 秒，之后 3 秒，最多再等 20 秒；没回来就停下并报出是第几个文件）。每个参数是绝对路径，或 boardd 自带固件的名字（见下一节）；boardd 加载前算 sha256，每一步连同文件路径记进操作记录。只改内核时：`boardlab boot <板子> fsbl u-boot-opensbi /path/Image.itb`。要持锁，先用 `boardlab fastboot` 让板子进下载模式。只写内存，不烧录、不改板上配置。

文件从哪来、只改内核和改了固件时分别用哪套、TFTP 怎么做，写在给 Claude 的 [`skills/boardlab/boot.md`](skills/boardlab/boot.md) 里。

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

## 模块和配置

boardd 能做什么由它加载的模块决定：

| 模块 | 带来什么 | 需要 |
| --- | --- | --- |
| `local` | 本机的板子：槽位、serial-mux 串口和输入闸门、本机 fastboot、一键扫描 | — |
| `home-assistant` | Home Assistant 控制器上的槽位 | `local` |
| `script-slots` | 脚本驱动的自定义槽位 | `local` |
| `bsp` | bsp 板卡主机、`boardlab sdk`、`boardlab registry`、`boardlab bsp`（`instances`、`bin`） | — |

配置文件是状态目录里的 `boardd.json`（或 `--config`、`BOARDLAB_CONFIG`）。没有配置文件时装全部模块；`--modules a,b` 只装这几个。例如一台只接远程 bsp 主机的服务器：

```json
{
  "modules": { "bsp": { "instances": ["bsp"] } },
  "timing": { "boot": { "firstMs": 8000, "laterMs": 3000, "waitMs": 20000 }, "console": { "watchIdleMs": 30000 }, "syncMs": 60000 }
}
```

没装的模块，它的接口、命令和网页上的部分都不存在。`GET /api` 列出所有接口和带来它的模块，别的程序和别的网页都用这套接口；`serve --ui <目录>` 换一个网页，`--no-ui` 只提供 `/api`。

## 用 SDK 启动和刷机

实验室的板子可以直接用 SDK 编好的产物启动：`boardlab boot <板子> --sdk <SDK> [--method load|download] [--variant V]`，刷机是 `boardlab flash <板子> --sdk <SDK>`；网页卡片上拿着锁时点「用 SDK 启动」。这是远程下载口这条路：板子所在的主机自己去构建服务器取产物、按 SDK 的启动流程加载或烧录（bsp 是 `bsp dut boot --sdk`），文件不经过 boardd，进度显示在卡片上。本机的板子走本机下载口，用 `boardlab boot <板子> <文件>…`。

## SDK：在构建服务器上开发

`boardlab sdk <操作> …` 由 boardd 那边的 bsp 执行（`bsp sdk …`，用 boardd 所在机器的 bsp site 和它到构建服务器的 ssh），开发机上不用装 bsp、不用配 site：租源码树（`acquire --task`、`release`）、编译（`build`，输出实时传回）、跑命令（`exec -- …`）、读写文件（`get … -o 本机文件`、`put … 本机文件`，文件经 boardd 中转）。每个持有人在 boardd 上有自己的 bsp 配置目录，SDK 租约凭证互不相混。boardd 所在用户要能免密 ssh 到 site 里写的构建服务器账号。

## 在别的机器上用 boards

boardd 跑在一台机器上（例如一台内网服务器），别的机器（构建服务器、笔记本）上的 `boardlab` 命令行可以远程用它，命令和本机完全一样：

```sh
boardlab remote set ssh://boardlab@boardd.example     # 网络只通 ssh 时：每个连接是 ssh -W 到 boardd 的回环端口
boardlab remote set https://example.org/boardlab/ --user <名字> --password-stdin   # 能直接访问网页时，走代理和它的登录
boardlab list
```

装到一台机器上用 `scripts/install-client.sh`（在这个仓库里、构建过以后运行）：它装 `boardlab`（目标机的 Node 低于 24 时带一份过去，目标机不用联网）、连上 boardd。skill 由 agent 工作的目录自己装：在那个目录里运行 `boardlab install`，写出 `SKILL.md`（和 bsp install 一样；原来的 SKILL.md 不是 boardlab 的会备份成 SKILL.md.bak）。开发机上不装 bsp：板子和 SDK 都经 boardlab，bsp 命令行只在 boardd 所在机器上。只通 ssh 的网络里，`--grant <管理员>@<boardd 主机>` 把目标机的 ssh 公钥加给 boardd 主机上的隧道账号（默认 `boardlab`），这把钥匙只能转发到 boardd 的端口，不能登录：

```sh
scripts/install-client.sh me@build-server --remote ssh://boardlab@boardd-host --grant root@boardd-host
```

用 install.sh 装的 boardd 也可以在网页上做这件事：设置 →「客户端配置」→「添加机器」，填机器地址、那边的普通用户（不能是 root）和这台 boardd 的地址，密码可选、只用一次（之后用 boardd 自己的密钥）。boardd 把自己运行的版本传过去，以那个用户装在 `~/.local` 下（那边的 Node 低于 24、架构又相同时，带上 boardd 自己的 Node），让那台机器的 ssh 密钥只能经隧道用户转发到 boardd 的端口，再 `boardlab remote set`、`boardlab status` 检查。boardd 以 root 运行时隧道用户默认是 `boardlab`（没有就建一个不能登录的），否则是 boardd 自己的用户；boardd 改不了那个用户的 `authorized_keys` 时，会给出要在它的机器上运行的命令。列表里每台机器显示装的版本、连不连得上（每半小时看一次，也可以点「检查」）；「更新」用这台 boardd 的版本重装，「删除」让那边不再连过来、收回隧道授权，可以连命令行一起卸掉。boardd 的机器要允许隧道用户 ssh 登录和 TCP 转发（`AllowTcpForwarding`）。

设置存在 `~/.config/boardlab/remote.json`（权限 600；老版本写在 `~/.config/boards/` 的照样读），也可以用环境变量 `BOARDS_REMOTE`（加 `BOARDS_USER`、`BOARDS_PASSWORD`）临时指定；`boardlab remote show` 看当前用的是哪个，`boardlab remote clear` 改回本机。远程时你在 boardd 那边是 `user:<登录名>`（ssh 方式是 `--user` 或本机的 `$USER`），agent 照常用 `BOARDS_HOLDER=claude:<会话>`，代表的就是这个人。远程拿到的锁凭证存在同一目录的 `tokens.json`。`boardlab boot` 给的本机文件会先传到 boardd（`PUT /api/files/<sha256>`，按内容核对，同一个文件只传一次，3 天没用的删掉），再按 sha256 启动，所以在构建服务器上编完直接 `boardlab boot <板子> fsbl u-boot-opensbi ./Image.itb` 就行。

## 放在反向代理后面

网页的请求都用相对路径，可以挂在别的网站的子路径下（例如 `https://example.org/boardlab/`）。代理把请求转给 boardd 的回环地址，`Host` 写成 boardd 自己的地址，用 `serve --origin https://example.org`（或 `BOARDS_ORIGINS`）让 boardd 接受从这个地址来的写请求。代理做了登录时，可以用 `X-Boards-User` 头把登录名交给 boardd，排队和锁就按这个名字区分。nginx 的例子：

```nginx
location = /boardlab { return 301 /boardlab/; }
location /boardlab/ {
    auth_basic "boardlab";
    auth_basic_user_file /etc/nginx/boardlab.htpasswd;
    proxy_pass http://127.0.0.1:38127/;
    proxy_set_header Host 127.0.0.1:38127;
    proxy_set_header X-Boards-User $remote_user;
    proxy_http_version 1.1;
    proxy_buffering off;              # 事件流和串口输出要实时
    proxy_read_timeout 1h;
}
```

