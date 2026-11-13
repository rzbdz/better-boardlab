# 站点

站点是每台 bsp 板卡主机都读的一套配置：SDK、编译服务器、编译方式、源码树、SoC 资料、钩子，以及 SoC 资料要用的镜像。boardd 保存一份，你在页面上（或者用 `boardlab site …`）改它，再同步到所有主机。

## 来源

- **这台 boardd 管理**：站点就放在 boardd 里（`<状态目录>/bsp/site`，一个 git 仓库）。每次在页面上改，都会以改的人的名义提交一次。
- **git 仓库**：boardd 克隆一个仓库的某个分支，改动也提交在这里，然后由你「推送」回去。「拉取」会把仓库里的新提交取回来，本地的提交接在后面；有冲突时什么都不改。访问仓库先用 boardd 自己的密钥，不行再用这台机器的 ssh 设置。

在「换来源」里切换。如果这里有新来源里没有的改动，默认不让换；勾上「丢掉这里的改动」才会换（那些改动会留在一个本地分支里）。

页面上的「版本」是当前提交的短哈希、提交说明和提交时间；后面带 `-dirty` 表示有文件是在 boardd 之外改的。

## 仓库里有什么

一个站点仓库可以放下整个实验室的配置。同步时只把下面这些发给主机（`skills/` 除外，它留在 boardd 给 agent 用）：

| 目录 | 内容 |
|---|---|
| `sdk/servers/<id>.yaml` | 编译服务器（见帮助页「编译服务器」） |
| `sdk/instances/<id>.yaml` | SDK：源码在哪、怎么编、板子怎么启动和刷机（见「SDK」） |
| `sdk/families/<id>.yaml` | 编译方式（见「编译方式」） |
| `sdk/workspaces/<id>.yaml` | 几个 SDK 共用的一棵源码树 |
| `socs/<soc>/soc.yaml` | SoC 资料，镜像文件也放在同一个目录（见「SoC 资料」） |
| `hooks/<kind>/<name>` | 钩子脚本，比如厂商的刷机工具 |
| `skills/<sdk>.md` | SDK 自己的说明（SKILL.md），给在那个 SDK 的仓库里工作的 agent；同步时不发给主机 |
| `.blobs/<sha256>/<file>` | 取来的镜像（不进 git，boardd 同步前自己去取） |

别的目录，比如 `hosts/`、`deploy/`、`docs/`、`notes/`、`README.md`，可以照样放在仓库里，boardd 不读也不发。每台主机自己的 `hosts/<id>.yaml` 由主机自己保管，同步不会覆盖它。

整个仓库可以从 `examples/catalog/` 抄：一个最小的站点，示范怎么在 bsp 自带的公开 SoC 资料上只叠加这个实验室独有的部分（私有镜像 + 用它的启动步骤），而不是复制一份 SoC 资料。

例子：

```text
my-site/
  sdk/servers/build-a.yaml
  sdk/families/make-bsp.yaml
  sdk/instances/vendor-bsp-a.yaml
  socs/soc-a/soc.yaml
  socs/soc-a/fsbl.bin
  hooks/flash/example-pkg
  hosts/lab-1.yaml        # 不发，主机自己管
  notes/wiring.md         # 不发
  .gitignore              # 里面写 .blobs/
```

## 同步

「同步到所有主机」会先取镜像（`bsp images sync`），再把上面那几样打包发到每台 bsp 主机的 `/etc/bsp/site`，然后让 bspd 重新读取。站点有问题时不让同步，页面上会列出问题；问题都是按 bsp 读取站点的规则检查出来的，所以能同步过去的站点，主机上一定读得进去。

空站点也可以同步：主机拿到的就是一套空配置，只用 bsp 自带的 SoC 资料和编译方式。

每台主机当前用的站点版本显示在「bsp 板卡主机」列表里。

## 可选的镜像

SoC 资料里可以列一些探测用的镜像（例如 K1 的 FSBL 和 U-Boot）。发现板子时，boardd 用它们把板子启动到 U-Boot，读出型号和序列号。这些镜像不在时什么也不会失败，只是发现的板子读不到型号。页面上把它们列在「可选」里。如果某个镜像有 SDK 或者 SoC 的启动步骤要用，它就是缺失，页面会警告。

镜像的加法见帮助页「SoC 资料」。

## SDK 自己的说明（skill）

SDK 可以带一份自己的 `SKILL.md`，说明一份源码树在这个 SDK 里怎么用（例如同一份 bsp 源码的不同启动配置：edk2、u-boot、ACPI）。它放在站点的 `skills/<sdk>.md`；bsp 自带的 pack 也可以放 `<pack>/skills/<sdk>.md`，站点里的同 id 覆盖 pack 的。这是 Markdown，不是目录里的 YAML，所以不参与目录校验，同步时也不发给板卡主机。

在 SDK 的仓库里工作时，agent 可以这样取到它：

```sh
boardlab sdk skill list                      # 有哪些 SDK 带自己的说明
boardlab sdk skill <sdk>                     # 打印 Markdown
boardlab sdk skill <sdk> --install           # 写到当前目录的 .claude/skills/<sdk>/SKILL.md
boardlab sdk skill <sdk> --install --dir DIR # 写到 DIR/.claude/skills/<sdk>/SKILL.md
boardlab sdk skill <sdk> --install -g        # 写到这台机器上每个装了的 agent 的 skill 目录
```

站点里的 skill 用 `boardlab site show skill <id>` 看，用 `boardlab site set skill <id> -f <文件|->` 写（以改的人的名义提交），用 `boardlab site remove skill <id>` 删。

## 命令行

```sh
boardlab site show                    # 来源、版本、问题、SDK 和编译服务器
boardlab site pull | push             # git 来源：拉取、推送
boardlab site sync                    # 同步到所有主机
boardlab site set server build-a --file build-a.yaml
boardlab site set sdk vendor-bsp-a --file vendor-bsp-a.yaml
boardlab site remove sdk vendor-bsp-a
boardlab site set skill vendor-bsp-a -f vendor-bsp-a.md
```

`set` 和 `remove` 的类型是 `sdk`、`server`、`family`、`workspace`；`skill` 是单独的 Markdown 文件（`skills/<id>.md`）。写进去之前会先检查，主机读不进去的改动会被拒绝。
