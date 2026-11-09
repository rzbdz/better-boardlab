# boardlab

开发板实验室：人和 AI agent 通过同一个服务、同一个命令行和同一个网页，对开发板拿锁、复位、看串口、从内存启动。

boardlab 是 [boardlab-core](https://github.com/rzbdz/boardlab-core) 加上一组常用模块的发行版：

- **本机的板子**：用 Home Assistant 开关或自己的脚本复位的槽位、serial-mux 串口、fastboot，以及一键扫描（发现并识别板子）。
- **远程板卡主机**：经 [bsp](https://github.com/rzbdz/bsp-remote-dev-workflow) 使用别处实验室的板子，并在构建服务器上编译、启动 SDK。
- **Claude skill**（`skills/boardlab`）：教 agent 使用命令行。

## 功能

- 开发板锁和先来先得的排队，人和 agent 共用。
- 每块板子都能 `reset`、`fastboot`、`console`、`send`、`log`、`boot`（把 FSBL、U-Boot、内核加载到内存启动），不管它在哪。
- 槽位：按位置称呼板子（`host1/s3`），换板子不用重新登记。
- 网页：板子、串口、历史和设置；HTTP API 给别的程序用。
- 在任何机器上通过 ssh 或反向代理使用中心的 boardd。

## 快速开始

需要 Node.js ≥ 24 和 pnpm。

```sh
git clone --recurse-submodules https://github.com/rzbdz/better-boardlab.git boardlab
cd boardlab
pnpm install
pnpm run build
node dist/cli.js serve             # http://127.0.0.1:38127/
```

打开网页，在「设置」里配置槽位，然后扫描。命令行：

```sh
boardlab list
boardlab lock board1 --for "调试 U-Boot"
boardlab reset board1
boardlab console board1
boardlab unlock board1
```

给 agent 装 skill：在它的工作目录运行 `boardlab install`，或 `boardlab install -g`。

## 配置

boardd 默认加载全部模块。只要其中一些时，在状态目录（`~/.local/state/boardlab`）写 `boardd.json`：

```json
{ "modules": { "bsp": { "instances": ["bsp"] } } }
```

远程 bsp 实验室需要 bsp 命令行（`externals/bsp`）和写着你的主机的 bsp site，见 bsp 的文档。

## 文档

- [使用指南](docs/guide.md)：槽位、实验室、锁、内存启动、扫描、模块、远程使用
- [安全边界](docs/security.md)
- `boardlab help` 列出全部命令

## 开发

```sh
pnpm run typecheck
pnpm check     # 分层和模块登记表检查
pnpm test
```

模块在 `src/modules/<id>/`：`index.ts` 把它装到核心上，`catalog.ts` 交给 boardd，`cli.ts` 加命令，`ui.tsx` 加网页上的部分。增删模块后运行 `pnpm modules`。核心的改动在 boardlab-core 里做。

## 致谢

boardlab 最初由 [Troy Mitchell](https://github.com/TroyMitchell911) 创建，本项目在他的工作基础上重构而来。

## 许可证

MIT，见 [LICENSE](LICENSE)。
