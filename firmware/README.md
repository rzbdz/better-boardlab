# boardd 自带的固件

`firmware.json` 就是登记表：每条写 SoC、用途、文件（相对这个目录）和 sha256。boardd 每次加载前核对 sha256，对不上就拒绝。要换或加固件：把文件放进来，改 `firmware.json`，在这里记下来源，再提交。

| 用途 | 文件 | 谁用 | 来源 |
| --- | --- | --- | --- |
| `minor-board-info` | `spacemit/k3/minor-board-info.bin` | 一键扫描固定用它读 K3 板子的型号，读完停住，起不了系统 | 2026-10-27 在构建机上用 `~/k3-sdk/uboot-2022.10`（b2c4a669，带诊断补丁和 `k3_minor_board_info_defconfig`）编的 SPL 打成的 FSBL 容器；构建记录在 `spacemit/k3/minor-board-info.manifest.toml` |
| `fsbl` | `spacemit/k3/FSBL.bin` | 只改内核时 `boards boot` 的第一个文件 | 构建机 `~/k3-sdk/output/FSBL.bin`，2026-09-08 |
| `u-boot-opensbi` | `spacemit/k3/u-boot-opensbi.itb` | 只改内核时 `boards boot` 的第二个文件 | 构建机 `~/k3-sdk/output/u-boot-opensbi.itb`，2026-09-08；SDK 现在的 U-Boot 是 b2c4a669、OpenSBI 是 3a903132，不一定就是构建时的版本 |

`fsbl` 加 `u-boot-opensbi` 加自己编的内核 FIT，2026-11-01 在 `k3_com260-slot1` 上起到过内核；pico 还没用这套起过。改了 OpenSBI 或 U-Boot 时不要用这里的，用构建机上这次编出来的。
