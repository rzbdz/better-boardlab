# 分层知识（guidance）

agent 从 `skills/boardlab` 学到的是**开发板这个对象**和 boardlab 的规矩。这套板子、这颗芯片、这份 SDK 各自的
知识由站点分层提供，随站点更新，所以用命令问，不要写死在任何地方：

```sh
boardlab guidance --list          # 有哪些可问：通用提示、有笔记的 SoC、有 skill 的 SDK
boardlab guidance                 # 第一层：站点和 platform 的通用提示
boardlab guidance --soc <soc>     # 第二层：socs/<soc>/*.md 的笔记，和它的资料在哪
boardlab guidance --sdk <sdk>     # 第三层：skills/<sdk>.md，这个 SDK 自己的 SKILL.md
boardlab guidance --dut <board>   # 问板子所在主机它的 SoC 和 SDK，自动带上适用的各层
```

## 层级与归属

| 层 | 文件 | 回答什么 | 归谁 |
| --- | --- | --- | --- |
| 通用 | `<layer>/hints/*.md` | 这一屋子板子共同的注意事项 | 站点或 platform |
| SoC | `<layer>/socs/<soc>/*.md` | 这颗芯片的复位方式、电平、boot ROM 行为 | SoC facts 的同一层 |
| SDK | `<layer>/skills/<id>.md` | 这份源码树怎么编译、启动、有哪些变形 | SDK 条目所在的层 |

后一层（site）的同名文件盖住前一层（platform）的，和站点里的其他数据一样。`--dut` 由板子所在主机回答它的 SoC 和
SDK，**agent 不需要先知道该问哪一层**；`--list` 回答“有没有可问的”，没有时就在回答里说明缺什么，用
`boardlab feedback --kind design` 提交，而不是反复问用户。

只读配置层，不碰板子，所以随时可问，每台主机给同一个答案。
