# 启动内核：SDK、fastboot 内存启动和 TFTP

要在板子上启动一个编好的内核（或 FSBL、U-Boot/OpenSBI）时读这份。锁、复位、串口的基本用法见 [SKILL.md](SKILL.md)。几种方法按用户说的选，一种失败不要悄悄换另一种。

## 选方法

- **SDK 的构建**：板子在能取构建产物的实验室里（bsp 主机，`boardlab list` 的卡片上列着能跑的 SDK）时，`boardlab boot <板子> --sdk <SDK>` 内存启动、`boardlab flash <板子> --sdk <SDK>` 刷机。板子所在的主机自己去构建服务器取产物，按 SDK 登记的流程走，不经过你这台机器。SDK 本身怎么编见 `boardlab sdk help`，流程怎么登记见 `boardlab registry help`。
- **文件内存启动**：手上有这次编出来的文件（FSBL、U-Boot/OpenSBI、内核 FIT），按下面「fastboot 内存启动」一个个加载。不烧录。
- **网络启动**：板子上的 U-Boot 从 TFTP 取内核，见最后一节。

## 启动文件从哪来

- 内核、DTB、initrd 和改过的 FSBL、U-Boot/OpenSBI 来自这次任务的构建产物目录。先找产物目录里的 `boot-manifest.toml`，有就按它选文件、核对 sha256、照它的加载顺序和 FIT 配置；没有就在报告里写明查过哪里。manifest 里的 `boot-tested` 是历史记录，不代表这次能起来。
- 只改了内核：FSBL 和 U-Boot/OpenSBI 用 boardd 自带的 `fsbl` 和 `u-boot-opensbi`（`boardlab firmware` 列出，来源见仓库的 `firmware/README.md`），只有内核用这次编的。
- 改了 OpenSBI 或 U-Boot：必须用这次编出来的，不能拿旧的顶替。
- 按任务和板子选文件，不要只挑最新的。没指定构建的冒烟测试，选一套互相兼容的并说明选了什么、有什么局限；能起来不等于验证了某个没指定的改动。
- fastboot 的内核要打成 FIT（`Image.itb`：内核加各板的 DTB），见下一节。

## 打内核 FIT（Image.itb）

K3 用 [fit/spacemit/k3/make-its.sh](fit/spacemit/k3/make-its.sh)。默认在本机跑；构建在别的机器上时设 `FIT_HOST=<ssh 主机>`，脚本通过 ssh 在那边干活：

```sh
FIT_HOST=<构建主机> skills/boardlab/fit/spacemit/k3/make-its.sh <内核的 O= 目录> <本任务的新产物目录>
```

- 板子和 DTB 的对应关系在 [fit/spacemit/k3/boards.csv](fit/spacemit/k3/boards.csv)：`product_name,dtb,note` 一行一块板。`product_name` 是板子 EEPROM 里的名字，U-Boot 选 description 等于它的 configuration，找不到就用默认的；第一行是默认。加板子只加一行，不改脚本。
- 脚本照 SDK 的 `kernel_fdt.its` 生成 `Image.its`（内核加载在 0x1_02000000，DTB 在 0x1_28000000，带 sha256），把 `Image` 和这次构建里有的 DTB 拷进产物目录，用 SDK 自己的 mkimage（`$K3_SDK/uboot-2022.10/tools`，`K3_SDK` 默认 `~/k3-sdk`）打包，最后打印 `dumpimage -l` 和各文件的 sha256，抄进 `boot-manifest.toml`。
- 表里有但这次没编出来的 DTB 跳过并告警；编出来了但表里没有的也告警，需要就加一行。产物目录里已有 FIT、或目录在 SDK 下，脚本拒绝执行，不会覆盖 SDK 的 output。

## 冒烟 initramfs

只看内核起不起来、设备树对不对时，把冒烟 initramfs 内嵌进测试内核，不用根文件系统：

- 用 [fit/spacemit/k3/make-smoke-initramfs.sh](fit/spacemit/k3/make-smoke-initramfs.sh) 从 SDK 的 BusyBox rootfs 做一个（构建在别的机器上时设 `SMOKE_HOST`），输出到新的日期目录，同目录的 `SOURCE` 记着来源和 sha256。它换掉 `/init`：在 `=== K3_SMOKE_BEGIN ===` 和 `=== K3_SMOKE_READY ===` 之间打印内核看到的 model、compatible、cmdline、CPU 数、内存、分区、网口和 MMC 控制器，然后在串口上开一个 shell；不挂载持久存储，不起服务。
  ```sh
  SMOKE_HOST=<构建主机> skills/boardlab/fit/spacemit/k3/make-smoke-initramfs.sh <SDK 的 rootfs .cpio.gz> <新的输出目录>
  ```
- 测试内核单开一个 profile，`CONFIG_INITRAMFS_SOURCE` 指向它；需要时再加 `CMDLINE_FORCE` 和 earlycon。这套配置只用于测试，不进补丁。
- 串口里看到 `K3_SMOKE_READY` 才算起来了。
- 已有的冒烟 initramfs 有任务在用就留着；不要借别的任务的，那些是为它们的板子改过的，标记也是它们的。

## fastboot 内存启动

boardd 管下载口，不要直接跑 `fastboot`，也不要跑别的加载脚本。

1. 把这次要用的产物（只改内核时就是 `Image.itb`）拷到本机一个新目录，两边各算一次 sha256 对上：
   ```sh
   dir=$(mktemp -d)
   scp <构建主机>:<产物目录>/Image.itb "$dir"/ && sha256sum "$dir"/*
   ```
   boardd 自带的固件不用拷，直接写名字，boardd 自己核对 sha256。boardd 在别的机器上时（`boardlab remote`），`boardlab boot` 会先把本机文件按 sha256 传过去，同一个文件只传一次。
2. 拿锁，让板子进下载模式，确认这颗芯片的下载口在：
   ```sh
   boardlab lock <板子> --for "内存启动 <内核版本>"
   boardlab fastboot <板子>
   boardlab show <板子> --json
   ```
3. 按顺序加载。参数是固件名或文件路径；boardd 每加载一个就等下载口重新出现再加载下一个（FSBL 后先等 8 秒，之后等 3 秒，最多再等 20 秒），每个文件的路径和 sha256 记进操作记录：
   ```sh
   boardlab boot <板子> fsbl u-boot-opensbi "$dir"/Image.itb                          # 只改了内核
   boardlab boot <板子> "$dir"/FSBL.bin "$dir"/u-boot-opensbi.itb "$dir"/Image.itb    # 改了 FSBL/U-Boot/OpenSBI
   ```
   某一步失败就停下，报告是第几个文件、输出和串口日志，不要无限重试。
4. 看串口确认真的起来了：`boardlab log <板子> --lines 300`。加载命令成功不算启动成功。
5. 用完放锁，删掉第 1 步的本机目录（结论和 sha256 已经在报告和操作记录里）。

内存启动不烧录、不 `saveenv`、不改启动脚本或根文件系统；但 boardd 自带的 SDK FSBL 每次都会把 DDR training 写进 SPI NOR（offset 64 KiB，38912 字节，串口里是 `save DDR training info`），起来的系统自己也可能写存储，不要说整个过程一定无持久影响。

## 实验室的板子

`boardlab list` 里标着 `[实验室 …]` 的板子按上面同样的步骤内存启动，命令不变。不同的地方：

- 下载口在实验室那边（例如 bsp 主机）。`boardlab boot` 照样给文件路径或固件名，boardd 按 sha256 把文件传过去再加载。
- 板子 EEPROM 里的型号决定 U-Boot 选 FIT 里哪个 configuration；[boards.csv](fit/spacemit/k3/boards.csv) 里没有它，或内核里没有对应的 DTB 时，打出的 FIT 里就没有它，U-Boot 会用默认的第一项，设备树就不对：先问用户用哪个 DTB。
- 卡片上有「继电器」的实验室板子，还能单独控制它的继电器和按钮（断电重启、按住 BOOT），见 `boardlab relay <板子>`。
- 这些板子平时跑着自己的系统，别人也会用。用完先 `boardlab reset`，看到它自己系统的登录提示再放锁。

## TFTP / PXE 网络启动

网络启动用板子上现有的 SPL/U-Boot，不需要 FSBL 那套文件。TFTP 服务器、它的根目录和按 MAC 选的 `pxelinux.cfg/01-<mac>` 由用户告诉你，或从板子 U-Boot 现有的环境里读出来，不要猜。

1. 用核实过的 MAC（U-Boot `printenv ethaddr`、EEPROM）找到这块板的 PXE 配置，读完它和它 include 的配置以及选中的 label，按 TFTP 根目录解析出每个 kernel/FIT/DTB/initrd 文件（含符号链接）。不要假设默认配置，不要动别的板子的条目。
2. 把这次的产物拷过去覆盖这些目标文件，核对整套文件源和目标的 sha256。拷贝失败或 sha256 不符就停下，报告哪些文件被替换或只写了一半。用户没说要备份时问一句；不要用目标目录里已有的旧文件顶替。被板子保存的环境引用的目录，不能当一次性文件删。
3. 不要重启或改共享的 DHCP/TFTP 服务。
4. 拿锁、复位，按 U-Boot 倒计时的提示打断 autoboot（有的板子要按指定的键，Ctrl-C 没用：`boardlab send <板子> s --raw`；拦下来后先确认出现新的 prompt）。然后用 `boardlab send <板子> '<命令>' --wait '=> '` 查环境、执行 PXE（`dhcp; pxe get; pxe boot`）或直接 `tftpboot` 加载。服务器 IP、MAC、文件名、加载地址、启动参数都从现有配置和环境里来，不要编。命令没回显时先看新输出再决定重发，别自动重发启动命令。
5. 需要的临时环境改动只在内存里改，不 `saveenv`。报缺网卡地址、DHCP 失败或 TFTP 找不到文件时，如实报告这个前提失败，不要编 ethaddr。缺 ethaddr 可以只读查 `printenv`、`net list` 和 `tlv_eeprom`；EEPROM 的 base MAC CRC 正确、和板子序列号型号对得上、并核实了当前网口对应关系时，可以临时设 ethaddr，不 `saveenv`。

## 报告

分别报告：文件传输（每个文件的来源路径、sha256）、进入内核（看到的版本和板子）、用户态或根文件系统是否就绪。卡在挂根文件系统上的内核不算完整启动成功。附上 `boardlab log` 的相关输出、用的 manifest 路径（或没有 manifest）、没解决的不确定项。
