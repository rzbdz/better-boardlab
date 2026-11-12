# SDK

一个 SDK 是一样能编译、能启动的东西：编译服务器上的一棵源码树、它的编译方式、它对应的 SoC、产物在哪，以及怎么把产物放到板子上。用 SDK 启动板子是 `boardlab boot <板子> --sdk <SDK>`，刷机是 `boardlab flash <板子> --sdk <SDK>`。板子所在的板卡主机会自己去编译服务器取产物，再按下面写的步骤执行。

## 文件

`sdk/instances/<id>.yaml`，一个完整的例子：

```yaml
id: vendor-bsp-a
family: make-bsp               # 编译方式（sdk/families/ 或 bsp 自带的）
server: build-a                # 编译服务器
path: /home/dev/work/bsp-a     # 源码在服务器上的目录
soc: soc-a                     # 这个 SoC 的板子能跑它
description: soc-a 的厂商 BSP
boot:
  load:                        # 内存启动：用 fastboot 加载，什么都不写进存储
    status: ready              # ready 或 todo
    steps:
      - {do: enter-fdl}                       # 复位进下载模式
      - {do: stage, artifact: fsbl}
      - {do: continue}
      - {do: wait, serial: "SPL", fastboot: "Fastboot", timeout: 60}
      - {do: stage, artifact: uboot-sbi}
      - {do: continue}
      - {do: wait, serial: "U-Boot 20", fastboot: "Fastboot", timeout: 60}
      - {do: stage, artifact: kernel-fit, stop_if: uboot-only}
      - {do: continue}
      - {do: wait, serial: "# $|login:", fail: "Kernel panic", timeout: 120, nudge: 10}
    variants: {uboot-only: U-Boot 能用 fastboot 回话就停}
  download:                    # 刷机：写进存储，再冷启动
    status: ready
    steps:
      - {do: enter-fdl}
      - {do: stage, artifact: fsbl}
      - {do: continue}
      - {do: wait, fastboot: "Fastboot", timeout: 60}
      - {do: stage, artifact: uboot-itb}
      - {do: continue}
      - {do: wait, fastboot: "Fastboot", timeout: 60}
      - {do: hook, kind: flash, name: example-pkg, artifacts: [flash-zip], timeout: 1800}
      - {do: reset, when: fdl-not-strapped, why: 从刚刷好的存储冷启动}
      - {do: wait, when: fdl-not-strapped, serial: "login:", timeout: 180}
```

不用 `server` 和 `path`，也可以写 `workspace: <源码树>`，和别的 SDK 共用一棵源码树（见「编译方式」里的源码树）。

## 键

| 键 | 说明 |
|---|---|
| `id` | 名字 |
| `family` | 编译方式：怎么编，产物叫什么（产物的角色名，比如 `fsbl`，在编译方式里定义） |
| `server` + `path` | 源码在哪台服务器的哪个目录；或者写 `workspace` |
| `soc` | SoC，对应 `socs/<soc>/soc.yaml`；只有这个 SoC 的板子能用它 |
| `description` | 说明 |
| `boot.load` | 内存启动 |
| `boot.download` | 刷机 |
| `artifacts`、`artifacts_dir`、`build.targets`、`build.pre`、`plat`、`console` | 覆盖编译方式里的同名设置 |
| 其他键 | 编译方式是 `script` 时，可以在命令里写 `{键}`，比如 `board: x` 对应 `./build.sh -b {board}` |

`load` 和 `download` 两个都要有。还没写好的写成：

```yaml
download: {status: todo, notes: "暂时只能内存启动", steps: []}
```

这时 `boardlab boot` 会显示 `notes` 里的话，不会执行任何步骤。

## 步骤

步骤在板卡主机上按顺序执行，每一步是一个带 `do:` 的映射。

| 步骤 | 选项 | 作用 |
|---|---|---|
| `enter-fdl` | `timeout` | 复位进下载模式，等到 SoC 资料里写的下载模式串口输出和 fastboot 设备出现 |
| `reset` | `why` | 普通复位 |
| `stage` | `artifact` 或 `image`，`timeout`，`stop_if` | `fastboot stage` 一个产物（按角色名），或 SoC 资料里的一个镜像 |
| `continue` | | `fastboot continue` |
| `oem` | `cmd` | `fastboot oem <cmd>` |
| `getvar` | `name`，`match` | `fastboot getvar <name>`，不匹配正则就失败 |
| `flash` | `partition`，`artifact`，`timeout` | `fastboot flash <分区> <文件>` |
| `wait` | `serial`，`fastboot`，`fail`，`timeout`，`stall`，`nudge` | 等串口输出匹配 `serial`，和/或 fastboot 产品名匹配 `fastboot`。`fail` 匹配就中止；串口安静 `stall` 秒算失败；安静 `nudge` 秒就按一次回车（适合不换行的提示符，bootloader 可能把按键当成“停止自动启动”时不要用） |
| `settle` | `seconds`，`why` | 固定等一会儿，写明原因 |
| `hook` | `kind`，`name`，`artifacts`，`args`，`timeout` | 运行站点的 `hooks/<kind>/<name>`，比如厂商刷机工具 |
| `check` | `serial`，`why` | 上一个动作（复位、continue）之后的串口输出要匹配，否则停下 |
| `boot-media` | | 从板子自己的存储启动：普通复位；如果板子拨了 FDL，就用 SoC 的 `media_boot` |

所有步骤都可以加：

- `when: fdl-not-strapped`：这一步需要板子从自己的存储启动，比如刷完以后的冷启动。拨了 FDL 的板子，`reset` 会走 SoC 的 `media_boot`；SoC 没写 `media_boot` 时，这些步骤会被跳过，日志里会写明原因。
- `stop_if: <变体>`：请求了这个变体时，执行到这里就结束（`boardlab boot … --variant <变体>`）。变体写在 `variants` 里，附一句说明。

执行之前，主机会先把步骤用到的所有产物从编译服务器取过来，按校验和缓存，没变的文件不会重复拷贝。

## 检查

写进站点时会先检查：编译方式、服务器、源码树要存在，`status` 只能是 `ready` 或 `todo`，`ready` 的方式要有步骤，步骤的类型要认识，`artifact` 要是编译方式里有的角色。不通过就不写。

## 命令行

```sh
boardlab site set sdk vendor-bsp-a --file vendor-bsp-a.yaml
boardlab sdk plan vendor-bsp-a --boot download    # 不碰硬件，看会执行哪些步骤
boardlab boot <板子> --sdk vendor-bsp-a [--method load|download] [--variant uboot-only]
```
