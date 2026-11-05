# 启动内核：fastboot 内存启动和 TFTP

要在板子上启动一个编好的内核（或 FSBL、U-Boot/OpenSBI）时读这份。锁、复位、串口的基本用法见 [SKILL.md](SKILL.md)。两种方法按用户说的选，一种失败不要悄悄换另一种。

## 启动文件从哪来

- 内核、DTB、initrd 和改过的 FSBL、U-Boot/OpenSBI 都来自 构建机（`ssh <构建机>`）。先在任务的 构建机 产物目录里找 `boot-manifest.toml`（怎么写见 `upstream-build-on-构建机` 技能），有就按它选文件、核对 sha256、照它的加载顺序和 FIT 配置；没有就在报告里写明查过哪里。manifest 里的 `boot-tested` 是历史记录，不代表这次能起来。
- 只改了内核：FSBL 和 U-Boot/OpenSBI 用 boardd 自带的 `fsbl` 和 `u-boot-opensbi`（`boards firmware` 列出，来源见 `<boardlab 仓库>/firmware/README.md`），只有内核从 构建机 拿这次编的。
- 改了 OpenSBI 或 U-Boot：必须用 构建机 上这次编出来的，不能拿旧的顶替。
- 按任务和板子选文件，不要只挑最新的。没指定构建的冒烟测试，选一套互相兼容的并说明选了什么、有什么局限；能起来不等于验证了某个没指定的改动。
- fastboot 的内核要打成 FIT（`Image.itb`：内核加各板的 DTB），见下一节。

## 打内核 FIT（Image.itb）

K3 用 [fit/spacemit/k3/make-its.sh](fit/spacemit/k3/make-its.sh)，在本机跑，通过 `ssh <构建机>` 干活：

```sh
<boardlab 仓库>/skills/boards/fit/spacemit/k3/make-its.sh <构建机上的 O= 目录> <构建机上本任务的新产物目录>
```

- 板子和 DTB 的对应关系在 [fit/spacemit/k3/boards.csv](fit/spacemit/k3/boards.csv)：`product_name,dtb,note` 一行一块板。`product_name` 是板子 EEPROM 里的名字，U-Boot 选 description 等于它的 configuration，找不到就用默认的；第一行是默认。加板子只加一行，不改脚本。
- 脚本照 SDK 的 `kernel_fdt.its` 生成 `Image.its`（内核加载在 0x1_02000000，DTB 在 0x1_28000000，带 sha256），把 `Image` 和这次构建里有的 DTB 拷进产物目录，用 SDK 自己的 `~/k3-sdk/uboot-2022.10/tools/mkimage` 打包，最后打印 `dumpimage -l` 和各文件的 sha256，抄进 `boot-manifest.toml`。
- 表里有但这次没编出来的 DTB 跳过并告警；编出来了但表里没有的也告警，需要就加一行。产物目录里已有 FIT、或目录在 `~/k3-sdk` 下，脚本拒绝执行，不会覆盖 SDK 的 output。
- 2026-11-01 用这个脚本打过 v7.3-rc1，三块板的 configuration 都在；com260 之前用 `k3_com260` + `k3-com260-ifx.dtb` 的包实际起过，pico 的还没起过。

## 冒烟 initramfs

只看内核起不起来、设备树对不对时，把共享的冒烟 initramfs 内嵌进测试内核，不用根文件系统：

- 在 构建机 的 `~/upstream-tools/initramfs/k3-smoke-<日期>/rootfs-smoke.cpio.gz`，同目录的 `SOURCE` 记着来源和 sha256。它是 SDK 的 BusyBox rootfs 换了 `/init`：在 `=== K3_SMOKE_BEGIN ===` 和 `=== K3_SMOKE_READY ===` 之间打印内核看到的 model、compatible、cmdline、CPU 数、内存、分区、网口和 MMC 控制器，然后在串口上开一个 shell；不挂载持久存储，不起服务。
- 测试内核单开一个 profile，`CONFIG_INITRAMFS_SOURCE` 指向它；需要时再加 `CMDLINE_FORCE` 和 earlycon。这套配置只用于测试，不进补丁。
- 串口里看到 `K3_SMOKE_READY` 才算起来了。
- 要重做（换 SDK rootfs、改 `/init`）就用 [fit/spacemit/k3/make-smoke-initramfs.sh](fit/spacemit/k3/make-smoke-initramfs.sh)，在本机跑，通过 `ssh <构建机>` 干活，输出到新的日期目录；旧的有任务在用就留着：
  ```sh
  <boardlab 仓库>/skills/boards/fit/spacemit/k3/make-smoke-initramfs.sh ~/k3-sdk/linux-6.18/rootfs-self.cpio.gz ~/upstream-tools/initramfs/k3-smoke-<日期>
  ```
- 不要借别的任务的 initramfs：那些是为它们的板子改过的，标记也是它们的。

## fastboot 内存启动

boardd 管下载口，不要直接跑 `fastboot`，也不要另跑别的加载脚本。

1. 把这次要用的 构建机 产物（只改内核时就是 `Image.itb`）拷到本机一个新目录，例如 `~/.local/share/boards/boot/<板子>-<时间>/`，两边各算一次 sha256 对上：
   ```sh
   ssh <构建机> 'sha256sum <构建机产物目录>/Image.itb'
   scp <构建机>:<构建机产物目录>/Image.itb "$dir"/ && sha256sum "$dir"/*
   ```
   boardd 自带的固件不用拷，直接写名字，boardd 自己核对 sha256。
2. 拿锁，让板子进下载模式，确认这颗芯片的下载口在：
   ```sh
   boards lock k3_com260-slot1 --for "内存启动 <内核版本>"
   boards fastboot k3_com260-slot1
   boards show k3_com260-slot1 --json
   ```
3. 按顺序加载。参数是固件名或绝对路径；boardd 每加载一个就等下载口重新出现再加载下一个（FSBL 后先等 8 秒，之后等 3 秒，最多再等 20 秒），每个文件的路径和 sha256 记进操作记录：
   ```sh
   boards boot k3_com260-slot1 fsbl u-boot-opensbi "$dir"/Image.itb                          # 只改了内核
   boards boot k3_com260-slot1 "$dir"/FSBL.bin "$dir"/u-boot-opensbi.itb "$dir"/Image.itb    # 改了 FSBL/U-Boot/OpenSBI
   ```
   某一步失败就停下，报告是第几个文件、输出和串口日志，不要无限重试。
4. 看串口确认真的起来了：`boards log k3_com260-slot1 --lines 300`。加载命令成功不算启动成功。
5. 用完放锁，删掉第 1 步的本机目录（结论和 sha256 已经在报告和操作记录里）。

内存启动不烧录、不 `saveenv`、不改启动脚本或根文件系统；但 boardd 自带的 SDK FSBL 每次都会把 DDR training 写进 SPI NOR（offset 64 KiB，38912 字节，串口里是 `save DDR training info`），起来的系统自己也可能写存储，不要说整个过程一定无持久影响。

## 实验室的板子

`boards list` 里标着 `[实验室 …]` 的板子（例如 `bmc-sub1-0`）按上面同样的步骤内存启动，命令不变。不同的地方：

- 下载口在实验室的跳板机上。`boards boot` 照样给本机的绝对路径或固件名，boardd 按 sha256 把文件传过去再加载，所以第 1 步照做。
- 这些板子平时跑着自己的系统，别人也会用。用完先 `boards reset`，看到它自己系统的登录提示再放锁。

## 报告

分别报告：文件传输（每个文件的来源路径、sha256）、进入内核（看到的版本和板子）、用户态或根文件系统是否就绪。挂在挂根文件系统上的内核不算完整启动成功。附上 `boards log` 的相关输出、用的 manifest 路径（或没有 manifest）、没解决的不确定项。
