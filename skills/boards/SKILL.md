---
name: boards
description: 通过 boards CLI 使用实验室开发板：先拿锁，再复位、fastboot、看串口、发命令、往内存加载 boardd 自带的固件，用 fastboot 内存启动或 TFTP 启动内核和固件，用完放锁。要操作开发板、在板子上启动编好的内核、看板子串口输出或找出哪块板接在哪个口上时使用。
---

# 开发板（boards）

所有开发板都由本机的 boardd 统一管理。人、Claude 和 DSH 遵守同一套锁规则；不要绕过它直接用 `smtty`、`serial-mux`、`fastboot` 或 Home Assistant。

## 身份

每条命令都以你的会话身份执行。后台启动的 Claude 已经设好环境变量 `BOARDS_HOLDER`（`claude:<会话 ID>`，协作项目成员是 `workspace:<项目>/<成员>`），不要改它；`echo $BOARDS_HOLDER` 为空时，才自己设：

```sh
export BOARDS_HOLDER=claude:<当前会话 ID>
```

## 基本流程

```sh
boards list --json                         # 先看有哪些板、谁在用
boards lock com260 --for "调试 U-Boot 网络"  # 拿锁；被占用时退出码 3
boards reset com260
boards send com260 'printenv ethaddr' --wait '=> ' --timeout 10s
boards log com260 --lines 200
boards unlock com260                       # 锁没有时间限制，用完一定要放锁，排队的人才能拿到
```

- 别人持有锁时只能看（`list`、`show`、`log`、`console`），不能输入或控制。要等就排队，先到先得：
  - `boards lock <board> --for ... --wait`：一直等到拿到锁；
  - `boards queue <board> --for ...`：只排队不等，轮到你时锁自动归你，再运行 `boards lock <board> --for ...` 取凭证。
- 持锁期间串口有 serial-mux 输入闸门：`boards send` 自动通过；确实需要直接用 `smtty` 时，带上 `boards lock` 打印的 `--token`。不带 token 的输入会被丢弃，`smtty --send` 以退出码 3 报「已锁定」。
- 自定义槽位上没有 fastboot 脚本的板子只能复位，`boards fastboot` 会报「只能复位」；不要为此去改槽位脚本，脚本由用户维护。
- 认板子只看 `boards list` 和扫描结果，不要猜 `/dev/ttyUSBn`。
- `boards list` 里标着 `[实验室 <名字> <设备>]` 的板子在远程实验室（例如 `bmc-sub0-0`），命令完全一样，`boot` 给的仍是本机的绝对路径，boardd 会传到实验室的跳板机。实验室的板子别人也可能在实验室后台直接用，串口没有输入闸门；看到不是你发的输入或复位，停下来告诉用户。
- 多芯片板用 `<board>.<die>` 指定芯片，例如 `boards send evb.die1 ...`。
- 每条命令都支持 `--json`，解析结果用它。

## 规则

- 扫描（`boards scan --yes`）会逐个切换槽位上的板子，并重启所有串口守护进程。只要有任何一块板被拿着锁，boardd 就拒绝扫描；不要为了扫描去放别人的锁。
- 烧录、擦除、修改板上的持久配置（`saveenv`、写 EEPROM 等）可以在持锁时做，结论里写明做了什么、用的什么镜像。
- 抢别人的锁只有人能做，你只能请用户处理。

`boards stage <board> <固件名>` 只往内存加载 boardd 自带、sha256 和 `firmware.json` 一致的固件（`boards firmware` 列出），不会写板子；用之前仍要说明目的。`minor-board-info` 是扫描读型号用的，读完就停住。

要在板子上启动编好的内核、FSBL 或 U-Boot/OpenSBI（`boards boot` 内存启动，或 TFTP/PXE 网络启动），先读 [boot.md](boot.md)。

## 留证据

结论要附上 `boards log` 的相关输出，或扫描记录（`boards show <board>`）。不要只凭记忆说"板子已经启动"。
