# 编译方式和源码树

## 编译方式

编译方式（family）说明一类源码树怎么编、产物放在哪。很多 SDK 可以共用同一个编译方式。bsp 自带了一些编译方式，标着「bsp 自带」，站点里同名的会覆盖它们。

`sdk/families/<id>.yaml`：

```yaml
id: make-bsp
description: 顶层有 Makefile 的 BSP 树，产物都在 output/
build:
  runner: make                 # make | envsetup | script
  targets: {all: all, uboot: uboot, kernel: kernel, pack-image: pack_image}   # 组件 -> 目标
  clean: {uboot: clean_uboot, kernel: clean_kernel, all: clean}
artifacts:
  dir: output                  # 相对源码树；可以带 {plat}
  roles:                       # 角色 -> 文件名；启动步骤里按角色引用
    fsbl: FSBL.bin
    uboot-sbi: u-boot-opensbi.itb
    uboot-itb: u-boot.itb
    kernel-fit: Image.itb
    flash-zip: "flash_image_*.zip"   # 通配符取最新的一个
dev_projects: [linux]          # 树里的 git 仓库：租用时在这些仓库里建任务分支
env: {path_prepend: [], vars: {}}   # 加到编译服务器的任务环境里
console: {prompt: "# $"}       # 板子启动后 shell 的提示符
```

| runner | 编组件 C 的命令 |
|---|---|
| `make` | `cd <树> && make <targets[C]>` |
| `envsetup` | `cd <树> && source <build.envsetup> <plat> && <targets[C]>`：`build.envsetup` 是环境脚本，SDK 的 `plat:` 是平台，目标是脚本里定义的 shell 函数 |
| `script` | `cd <树> && <targets[C]>`，`{键}` 换成 SDK 里的同名键，比如 `./build.sh -b {board}` |

envsetup 的例子：

```yaml
id: env-bsp
build:
  runner: envsetup
  envsetup: scripts/envsetup.sh
  targets: {linux: build-linux, uboot: build-uboot, all: build-all}
artifacts:
  dir: "out/{plat}"
  roles: {kernel: Image, dtb: "board_{plat}.dtb"}
```

SDK 可以覆盖编译方式的设置：`build.targets` 和 `artifacts` 按键合并，`artifacts_dir`、`dev_projects`、`env`、`console` 整个替换。

## 源码树

源码树（workspace）是一台服务器上的一份检出，也是租用的单位：几个 SDK 共用一棵树时，租其中任何一个就锁住整棵树。不写 `workspace` 的 SDK 自己占一棵（它的服务器加路径）。

`sdk/workspaces/<id>.yaml`：

```yaml
id: kernel-tree
server: build-a
path: /home/dev/work/kernel-tree
dev_projects: ["."]
```

用它的 SDK 写 `workspace: kernel-tree`，不写 `server` 和 `path`。

## 在页面上

设置 → SDK 与站点 → 高级：编译方式和源码树都用 YAML 编辑。删除前要先改掉用它的 SDK。
