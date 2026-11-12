# 编译服务器

编译服务器是编 SDK 的机器。bsp 通过 ssh（`user@host`）登录上去，在源码树里编译、跑命令、取产物。服务器上不用装任何东西，只要有 Python 3.6 以上（bsp 会通过 ssh 带一个只用标准库的小程序过去）。

boardd 所在的机器，以及要从这台服务器取产物的每台板卡主机，都要能用密钥免密 ssh 到 `user@host`。

## 文件

`sdk/servers/<id>.yaml`：

```yaml
id: build-a
host: 192.0.2.10              # IP、域名，或 ssh 配置里的名字
user: dev
description: 共用的编译机
home_aliases: [/home/dev, /data/home/dev]   # 同一个家目录的两种写法（可选）
env:                          # 编译任务的环境，相当于交互登录时会设好的东西（可选）
  path_prepend: ["~/toolchains/riscv/bin"]
  vars: {LD_LIBRARY_PATH: "~/.local/lib"}
```

| 键 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 名字，SDK 的 `server:` 指的就是它 |
| `host` | 是 | 地址 |
| `user` | 是 | 登录用户 |
| `description` | 否 | 说明 |
| `home_aliases` | 否 | 家目录的别名 |
| `env.path_prepend` | 否 | 加在 PATH 前面的目录 |
| `env.vars` | 否 | 额外的环境变量 |

页面上的表单只改 `id`、`host`、`user` 和 `description`，文件里的其他键和注释都会原样保留。

## 在页面上

设置 → SDK 与站点：每台编译服务器是一组，下面列着它上面的 SDK。「添加 SDK」会把服务器预先填好。删除服务器前，要先删掉或移走用它的 SDK 和源码树。

## 命令行

```sh
boardlab site set server build-a --file build-a.yaml
boardlab site remove server build-a
boardlab sdk list                     # 能不能连上、有哪些 SDK
```
