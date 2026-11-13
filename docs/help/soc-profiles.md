# SoC 资料

SoC 资料告诉 bsp 一颗 SoC 的情况：复位后启动 ROM 打印什么（用来认出 SoC）、下载模式是什么样子、发现板子时用哪些镜像把板子启动起来读型号，以及板子拨了 FDL 时怎么从存储启动。bsp 自带公开 SoC 的资料（标着「bsp 自带」），站点的 `socs/<soc>/` 叠在上面：同一个文件名，站点里的优先。

## 文件

`socs/<soc>/soc.yaml`：

```yaml
soc: soc-a
fingerprint:                     # 复位后启动 ROM 的串口输出；探测时挑最匹配的 SoC
  - "ROMA: boot start"
  - "ROMA: usb init"
download_mode:                   # 下载（FDL）模式是什么样子
  console: "download handler"    # 串口正则（可选）
  fastboot: "DFU download"       # fastboot 产品名正则
usb_vids: ["1d6b"]               # 下载口、fastboot 设备的 USB 厂商 id
images:                          # 探测用的镜像（只加载到内存）
  fsbl: {file: fsbl.bin, sha256: "…"}
  uboot: {file: uboot.itb, sha256: "…"}
identify:                        # 发现板子时怎么读出它是谁
  sequence:
    - {stage: fsbl, console: "SPL", fastboot: "Fastboot"}
    - {stage: uboot, console: "U-Boot 20", fastboot: "Fastboot"}
  fields:                        # 对之后的串口输出用的正则
    product: "board_name = (.*?)\\s*$"
    serial: "serial# = (.*?)\\s*$"
    mem_gib: "DRAM:\\s*(\\d+) GiB"
  placeholders: {serial: ["0", "none"]}   # 表示“没烧写”的值
  name: [product, mem, serial]            # 建议的板子名由哪些部分组成
media_boot:                      # 可选：拨了 FDL 的板子怎么从存储启动
  name: rom-handoff
  steps:                         # 复位进下载模式后执行；步骤和 SDK 的一样
    - {do: check, serial: "strap: nor"}
    - {do: stage, image: handoff}
    - {do: continue}
    - {do: wait, serial: "SPL 20", timeout: 60}
```

## 镜像

镜像文件通常不能公开，所以 bsp 自带的资料一般只写了镜像的文件名，不带文件。在站点里补上它们，有三种办法：

1. **直接放文件**：放进站点的 `socs/<soc>/`，文件名和资料里写的一样（例如 `socs/k1/fsbl.bin`）。如果要校验，就在站点的 `socs/<soc>/soc.yaml` 里写上：

   ```yaml
   images:
     fsbl: {file: fsbl.bin, sha256: <十六进制>}
   ```

2. **写上从哪取**，文件不进 git：

   ```yaml
   images:
     handoff:
       file: handoff.bin
       sha256: <十六进制>
       source: {git: git@git.example.org:team/tools.git, ref: <提交>, path: boot/handoff.bin}
       # 或者 source: {url: https://…}，或者 source: {file: /boardd 机器上的路径}
   ```

   boardd 在拉取和同步之前会运行 `bsp images sync`，把文件取到站点的 `.blobs/<sha256>/<文件>` 里，哈希对得上才保留；主机随站点拿到它，自己不用去取。在 `.gitignore` 里写上 `.blobs/`。镜像更新了，就换新的 `sha256` 和 `ref`，再同步一次。

3. 什么都不做：只有探测用的镜像（`identify` 用的那些）缺了不要紧，同步照样进行，只是发现的板子读不到型号和序列号；页面上把它们列为「可选」。如果镜像有启动步骤要用（SDK 步骤里的 `image:`，或者 `media_boot` 里的），缺了才会警告。

站点的 `soc.yaml` 只需要写要补充或要改的键；其他的从 bsp 自带的资料来——站点是「叠上去」的，不是复制一份。公开的硬件事实（启动 ROM 打印什么、下载模式、识别字段、探测器用的镜像名）已经随 bsp 的 pack 一起发布，板卡主机上不用再放一份；站点里只放这个实验室独有的东西，比如一个不能公开的启动 ROM 帮助镜像和用它的步骤。`examples/catalog/` 里有一个这样叠在 k3 公开资料上的最小例子（只加一个镜像和 `media_boot` 步骤，其余全部来自 pack）。

## 在哪改

页面上只列出 SoC 资料，不能直接编辑。改 SoC 资料最好把站点放进一个 git 仓库（「换来源」），在仓库里改、提交，再在页面上点「拉取」和「同步到所有主机」。

新 SoC 的移植可以参考 bsp 的 `docs/porting.md`。
