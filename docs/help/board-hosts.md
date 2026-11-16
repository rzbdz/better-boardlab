# bsp 板卡主机

板卡主机是接着开发板的机器：它的 GPIO 接着板子的复位线和下载（FDL）线，USB 接着串口和下载口。每台板卡主机装上 bspd（一个 Python 服务），在 boardlab 里就是一个实验室；锁和排队都在 boardd 这里。

## 添加一台

设置 → bsp 板卡主机 → 添加板卡主机：

| 项 | 说明 |
|---|---|
| 实验室名 | 字母、数字、横线；板子会登记成 `<实验室名>-<设备名>` |
| 主机地址 | IP、域名、这台机器 ssh 配置里的名字，或者 `localhost`（就是 boardd 这台机器） |
| 登录用户 | 默认 root，要能装系统服务 |
| 密码 | 可选。不填时先试 boardd 自己的密钥，再试这台机器的 ssh 设置；填了只用一次，boardd 会把自己的密钥放过去，之后都用密钥 |
| 跳板机 | 可选，`user@jumphost` |
| 主机型号 | 可选，见下面的 GPIO |

boardd 会 ssh 过去，传一份 bsp，装好 bspd 服务，再把站点同步过去。主机上要有 Python 3 和 `fastboot`。装好以后点「发现」，boardd 会按复位线、看串口，认出接着的板子；扫描会复位它触及的板子，只在明确要发现时才运行。

装好以后，boardd 通过 bsp CLI 使用这台主机的 bspd HTTP API。实验室地址可以填 `bspd+http://<主机>:8765`，让 boardd 直连主机；直连不可达时才需要 `bspd+ssh://<用户>@<主机>:8765` 的 SSH 隧道，或 bsp registry 的主机 rendezvous。安装用 SSH 不代表每次普通读请求都要走 SSH。实验室的 token 保存在 boardd 的设置里，主机只监听回环地址时仍需 SSH 隧道。

「重新安装」用于升级或修复；「删除」会卸掉主机上的 bspd（板子记录留在主机上），并从 boardlab 删掉这个实验室。有人拿着锁时不能删除。

## 主机型号和 GPIO

主机型号决定 GPIO 排针的布局：哪个物理引脚是哪个 GPIO 号，哪些是电源和地。不填时，安装脚本读主机的 `/proc/device-tree/model`，和 bsp 自带的排针图（`packs/*/boards/<id>.yaml` 里的 `name:`）匹配。认不出来时，这台主机没有复位线，只能靠人按复位（页面上会请人按 RESET，确认后继续）。

自己的主机型号，可以照 bsp 的 `examples/site/boards/example-40pin.yaml` 写一份排针图，放进 bsp 的 pack，然后在「主机型号」里填它的 id。

## 接线

开发板的复位键和 FDL 键大多是把一个信号拉到地：

- 主机的地接板子的地；
- 主机的一个 GPIO 接按键不接地的那一端；
- bsp 把这个引脚当成“按键”用：只会拉低或者松开，从不主动拉高。所以 3.3 V 的主机也能安全地按逻辑电压更低的板子上的键，只要板子自己有上拉。

拿着一块板子的锁时，在板子页面的「bsp 登记」里从下拉框选它的复位线、FDL 线和下载口，以及型号和 SoC。reset 可以是 human 或主机的 GPIO；FDL 可以是 human、strapped（复位本来就会进下载模式）或 GPIO/button。执行动作的是人还是继电器，和板子的 FDL 拓扑是两个独立设置：human 只增加人工请求、自动检测、幂等确认和相应 timeout，不会把 strapped 改成另一种拓扑。已经在下载模式的板子可以用现有 USB 和保留的 ROM 证据，不要求每次请求都产生新 banner。

这些选项来自主机的 GPIO 清单和持续运行的 port watcher 快照，普通 GET 不会执行 probe 或复位。boardd 短暂共享主机选项，表单先显示已有数据再后台刷新；保存时仍重新验证 GPIO 和 USB 是否有效。

## 站点

每台主机都读同一个站点：SDK、编译服务器、SoC 资料、钩子。每台主机当前用的站点版本显示在列表里；不是最新时，在「SDK 与站点」里点「同步到所有主机」。主机自己的配置（`hosts/<id>.yaml`）由安装脚本生成，同步不会动它，重装也会保留已有的 registry announce 设置。

bsp registry（若使用）负责主机 rendezvous 和 SDK/catalog 分发；boardd 的板子、锁、队列、页面和人工请求不放在 registry 里，也不在客户端另建一份。SDK 的大文件默认由板卡主机通过 SSH/SCP、HTTP(S) 或显式 `host:/absolute/path` 获取；工作站上传只是回退。recipe 可以在 download 或 fastboot load 前执行显式的 `scp` 等步骤。

## 命令行

```sh
boardlab bsp hosts                    # 主机和它们的状态（由 boardd 那边的 bsp 执行）
boardlab list                         # 板子
boardlab site sync                    # 把站点同步到所有主机
```
