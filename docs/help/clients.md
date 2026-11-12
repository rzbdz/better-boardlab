# 客户端配置

客户端是使用这台 boardd 的 `boardlab` 命令行的机器：编译服务器、笔记本、agent 工作的机器。它们上面的人和 agent 用的命令和 boardd 本机完全一样（`boardlab list`、`lock`、`reset`、`console`、`boot` …）。

## 在页面上添加

设置 → 客户端配置 → 添加机器：

| 项 | 说明 |
|---|---|
| 名字 | 可选，不填就用地址 |
| 机器地址 | IP、域名，或 ssh 配置里的名字 |
| 登录用户 | 在那台机器上用命令行的普通用户，不能是 root |
| 密码 | 可选，只用一次；之后用 boardd 自己的密钥 |
| 跳板机 | 可选，`user@jumphost` |
| boardd 地址 | 那台机器 ssh 到这台 boardd 用的地址 |

boardd 会 ssh 过去，把自己运行的版本装在那个用户的 `~/.local` 下（那边的 Node 低于 24、架构又相同时，带上 boardd 自己的 Node），设成经 ssh 隧道连回这台 boardd，最后在那边跑一次 `boardlab status` 检查。这需要 boardd 是用 install.sh 装的（从源码跑的 boardd 没有发布包可装）。

## 隧道

客户端以隧道用户（boardd 以 root 运行时默认是 `boardlab`，没有就新建一个不能登录的）ssh 到 boardd 的机器。它的密钥只能转发到 boardd 的端口，不能登录 shell。boardd 的机器要允许这个用户 ssh 登录和 TCP 转发（`AllowTcpForwarding`）。「连接设置」里可以改 boardd 地址、隧道用户和 ssh 端口；改了以后要逐台「更新」。

列表里每台机器显示装的版本、连不连得上（每半小时检查一次，也可以点「检查」）。「更新」用这台 boardd 的版本重装；「删除」让那台机器不再连过来，收回隧道授权，也可以顺便卸掉命令行。

## 自己连

在一台已经装了 `boardlab` 的机器上：

```sh
boardlab remote set ssh://boardlab@boardd.example        # 只通 ssh：经隧道
boardlab remote set https://example.org/boardlab/ --user <名字> --password-stdin   # 经反向代理和它的登录
boardlab remote show                                    # 现在连的是哪个
boardlab status
boardlab remote clear                                   # 改回本机
```

设置存在 `~/.config/boardlab/remote.json`（权限 600）。也可以临时用环境变量 `BOARDS_REMOTE`（加上 `BOARDS_USER`、`BOARDS_PASSWORD`）。远程时，你在 boardd 那边的身份是 `user:<登录名>`。

## 给 agent 用

在 agent 工作的目录里运行 `boardlab install`，会写出教 agent 用命令行的 `SKILL.md`。agent 拿锁时用 `BOARDS_HOLDER=claude:<会话>`，代表的就是这台机器上的这个人。
