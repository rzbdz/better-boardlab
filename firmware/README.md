# Firmware

The firmware boardd loads onto boards. `firmware.json` registers each file with its SoC, purpose, path and sha256;
boardd checks the sha256 before every load and refuses a file that does not match.

To replace or add a file: put it here, add or update its entry in `firmware.json` (with the new sha256), and describe
where it comes from in this file.

## SpacemiT K3

| Purpose | File | sha256 | What it does |
| --- | --- | --- | --- |
| `minor-board-info` | `spacemit/k3/minor-board-info.bin` | `eb8c02ebf6dcc64fb8cf0bdd96cf1876b0636859e33520f112c00da56cb4b7c8` | Used by scans to identify a K3 board: staged over USB fastboot, it reads the board's EEPROM, prints the product name on UART0 at 115200 baud (or `UNKNOWN`), then halts until reset. It does not boot an operating system. |
| `fsbl` | `spacemit/k3/FSBL.bin` | `d66c953e1ad2baff929f59bb01f460371414282f569d51256c193b5264f6931f` | First file of `boards boot` when only the kernel changed: the first-stage loader, booted from memory. |
| `u-boot-opensbi` | `spacemit/k3/u-boot-opensbi.itb` | `f9986ccf2acf9165bbec0de3984392e814f76b02ec960f5f43d02e1e6bd03fb6` | Second file of `boards boot` when only the kernel changed: OpenSBI and U-Boot, which then load your kernel FIT. |

`fsbl` and `u-boot-opensbi` together with a self-built kernel FIT have booted to the kernel on a K3 COM260 board. If you
changed OpenSBI or U-Boot, boot your own build instead of these files.

### Rebuilding

All three files are built from SpacemiT's open K3 SDK sources.

`minor-board-info.bin` is the U-Boot SPL of the SDK's U-Boot 2022.10 tree at revision `b2c4a669`, built with a
diagnostic change that adds `k3_minor_board_info_defconfig` (EEPROM probe, print, halt). That change is not shipped
here. With it applied:

```sh
make CROSS_COMPILE=riscv64-unknown-linux-gnu- k3_minor_board_info_defconfig
make CROSS_COMPILE=riscv64-unknown-linux-gnu- spl/u-boot-spl.bin
```

The vendor packaging in the tree wraps the SPL into an FSBL container (`FSBL.bin`), which is `minor-board-info.bin`.
`minor-board-info.manifest.toml` records the toolchain, load addresses and boot sequence.

`FSBL.bin` and `u-boot-opensbi.itb` are the standard outputs of the K3 SDK build (U-Boot and OpenSBI with the SDK's
default configuration). The SDK's U-Boot is now at `b2c4a669` and its OpenSBI at `3a903132`; these files may have been
built from earlier revisions.
