# 发布源和更新

boardlab 从一个发布源安装，以后也从那里更新。安装时用的发布源记在 `/opt/boardlab/release-source`；私有项目的令牌记在 `/opt/boardlab/release-token`（只有 root 能读）。

## 发布源的几种写法

```sh
# 一个发布目录（URL 或路径），里面有 release.json 和 tarball
curl -fsSL <发布目录>/install.sh | sh
curl -fsSL <发布目录>/install.sh | sh -s -- --from https://example.org/boardlab/releases/latest

# 一个 tarball（只装这一次，不记成发布源）
sh install.sh --from ./boardlab-1.2.3.tar.gz

# git 仓库的一个分支（只能 ssh 访问的服务器）
sh install.sh --from git@git.example:group/boardlab-releases.git#release

# git 服务器的项目 API 上的一个分支；私有项目要令牌
sh install.sh --from 'https://git.example/api/v4/projects/<id>#release' --token <令牌>
```

令牌只发给发布源指向的那个项目 API。也可以用环境变量 `BOARDLAB_TOKEN` 给令牌。

## 更新

- 页面：设置 → 版本 → 检查更新 / 升级。
- 命令行：`boardlab update`（`--check` 只看有没有新版，`--force` 不等锁）。

boardd 每隔几个小时检查一次发布源。有新版时，它会等到没有人拿着锁再装上并重启；锁、排队和设置都会保留，页面会自己刷新。

## 换发布源

用新的 `--from`（私有项目再加 `--token`）重新运行一次 install.sh。新的发布源会记下来，以后的更新都从那里来。

## 其他选项

| 选项 | 说明 |
|---|---|
| `--host <地址>` | 在网络上开放页面 |
| `--origin https://代理/` | 放在反向代理后面 |
| `--port <端口>` | boardd 的端口，默认 38127 |
| `--node <node 或 tarball>` | 离线时自己给 Node 24 |
| `--cli` | 只装命令行（非 root 运行时也是只装命令行，装在 `~/.local`） |
| `--uninstall [--purge]` | 卸载；`--purge` 连状态一起删 |
