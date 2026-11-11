# dsh-remote-agent

**远程 Agent 工作台** —— 把一台 Linux 服务器上的目录、文件、终端和已安装的 Agent harness 直接搬进 DeepSeek Harness（DSH）的 Web 界面。

![status](https://img.shields.io/badge/DSH-0.2.x-247bbf) ![license](https://img.shields.io/badge/license-MIT-green)

## 它解决什么

本机（macOS / Linux）已经配置好 `~/.ssh/config`，服务器上已经装好 `kimi`、`claude`、`codex` 等 CLI。
装上这个插件后，不需要在服务器上安装 DSH、agent server 或同步目录：

1. 在 DSH 左侧栏点击 **远程 Agent**；
2. 选择一个 SSH 连接（自动读取 `~/.ssh/config`，也可手动添加）；
3. 浏览并选择一个远程目录作为工作区；
4. 在 Agent 面板里点击已检测到的 harness，或输入任意自定义命令；
5. 右侧文件树直接浏览 / 编辑 / 渲染远程文件。

所有流量都走本机已有的 OpenSSH 客户端，因此密钥、`ssh-agent`、`ProxyJump`、`Host *` 默认项、`Include`、`known_hosts` 都按你原来的配置生效。

## 功能

| 能力 | 实现 |
| --- | --- |
| 直连远程 Linux | 系统 `ssh` 客户端 + `ControlMaster` 复用；支持密钥、ssh-agent、密码（内存保存）、ProxyJump |
| 自动识别 SSH 配置 | 解析 `~/.ssh/config`（含 `Include`、`Host` 多别名、`Host *` 默认项），列出主机、用户、端口 |
| 任意目录作为工作区 | 远程目录选择器（浏览 / 输入 / 新建目录），工作区保存在插件状态里，左侧栏随时切换 |
| 左侧工作区 | 面板左侧常驻连接、工作区、已检测 Agent、运行中的会话列表 |
| 任意 Agent harness | 通过登录 shell 的 PATH 检测 Kimi Code、Claude Code、Codex、Gemini、OpenCode、Aider、Qwen、Crush、Goose、Amp、Droid、Cursor Agent、Copilot、Continue、DSH；也可输入任意命令 |
| 远程终端 | 真实远程 PTY（`ssh -tt` + Host 的 PTY 后端），xterm.js 渲染，支持调整尺寸、颜色、滚动、复制粘贴、Ctrl+C |
| 远程文件 | 右侧文件树、文本编辑、Markdown 渲染、图片 / PDF / HTML / 音视频预览、上传、下载 |
| 文件操作 | 新建文件 / 目录、重命名、删除、复制、剪切、粘贴、复制绝对路径、复制相对路径、在终端中定位 |
| 并发安全 | 保存时带 mtime 乐观锁；服务端文件被改动时拒绝覆盖并提示重新加载 |
| Git 更改面板 | 分支 / ahead / behind、已暂存与未暂存文件、逐文件 diff、暂存/取消暂存、提交 |
| Git worktree | 一键创建独立分支 + 独立目录的 worktree，自动成为工作区，用来并行运行多个 Agent；支持列出/打开/删除 |
| 端口转发 | 把远端端口转发到本机 127.0.0.1；终端输出里出现 `localhost:3000` 时自动显示快捷入口，一键转发并打开预览 |
| 快速打开 | `⌘P` / `Ctrl+P` 在远程工作区内按文件名搜索并打开文件（不依赖本地镜像） |
| 快捷键 | `⌘⌥R` / `Ctrl+Alt+R` 直接打开远程工作台 |
| 会话持久化 | 名称、连接、目录和最近的终端输出保存到本地，DSH 重启仍保留；服务器已有 tmux 时，新会话的远端进程也可断线保留并重新连接；只有主动删除才移除记录 |
| 完成通知 | Host 端监测已知 Agent 的“工作中→可输入”状态，通过本机 macOS 通知提醒；后台会话也会监测，可在设置中关闭与测试。终端状态推断可能漏报，不等同于 harness 结构化事件 |
| 会话重命名 | 远程工作台的终端/Agent 会话：双击左侧会话或页签，或点行内铅笔；DSH 原生聊天：悬停会话行点铅笔，标题写入 Session 日志，不会被自动标题覆盖 |
| 中英文 | 跟随 DSH 当前语言（zh / en） |

## 安装

### 预构建版本（无需执行构建脚本）

```bash
# Desktop 用户请在 DSH 插件管理中安装对应 Desktop profile 的包。
dsh plugin --profile <profile> add https://github.com/BeastyZ/dsh-remote-agent/releases/latest/download/dsh-remote-agent.tgz
```

安装后重新加载 DSH 页面；首次使用或在 Host 端更新后按提示重启。源码、Issue 和发行版位于 [BeastyZ/dsh-remote-agent](https://github.com/BeastyZ/dsh-remote-agent)。

### 从工作区目录安装（开发 / 本地）

```bash
# 在 DSH 里通过 plugin_manager 安装（推荐）
# action: install_bundle, target: /absolute/path/to/dsh-remote-agent
```

或使用 CLI：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-remote-agent
```

安装后重载页面。插件会出现在左侧栏的图标列表中（**远程 Agent**），点击进入工作台。

### 构建浏览器半边

仓库已经包含构建后的 `client.js`。修改 `client-src/` 后重新构建：

```bash
npm install
npm run build
```

构建产物是自包含的 IIFE（含 xterm.js），React 由 DSH 页面注入，不引入第二份 React。

## 使用

1. **连接**：左侧「连接」列出 `~/.ssh/config` 中的主机。点击即可连接；密码 / 密钥口令会弹窗询问（只保存在 Host 进程内存中）。
2. **工作区**：点击「工作区」右侧 `+`，在远程目录选择器中浏览服务器目录，选中后设为工作区。工作区会出现在左侧列表，下次打开自动恢复。切换工作区（或 Git worktree）时，会话列表和当前标签同步切换到该目录；各工作区保留上次选中的会话，其他目录的程序继续在后台运行。
3. **启动 Agent**：选中工作区后，插件会通过登录 shell 扫描 PATH 并列出已安装 harness。点击卡片即在远程 PTY 中启动，工作目录就是当前工作区。没有列出的 CLI 用「自定义命令…」。
4. **终端**：左侧「会话」按当前工作区显示会话；切换工作区或 Git worktree 时，仍在后台运行的其他目录会话不会显示在当前页签里，各自保持运行。退出页面、DSH 重启、进程退出都不会删除它们。服务器已有 `tmux` 时，新建会话自动放入插件专用的 tmux server；重新进入后自动重连原进程，无需手动点击；连接失败时仍可点「重试重连」。没有 tmux 时仍保留名称、目录和最近输出，可点「重新启动程序」在原记录下重开进程（恢复模型对话需用 Agent 自身的恢复命令）。会话上的 `×` 是**删除会话及历史**，会先确认；不会因达到数量限制而淘汰旧记录。

   **终端滚动**：在会话终端内用滚轮或触控板上下浏览，不会自动打开历史弹窗。Kimi Code 会话会只读匹配当前终端对应的原生对话记录，在同一终端区域分批载入更早的用户消息与 Agent 回复，越过 tmux 的屏幕回滚边界；不包含思考、工具内部数据或注入上下文。向下滑到底部后再滑一次，或按 Esc，回到原来的实时终端；输入文字也会回到原终端，并只发送刚输入的文字。远端 Agent 继续运行，未提交输入保持原样。匹配不到可靠原生记录的 CLI 使用原有 tmux/本地滚动缓冲区，历史范围受其保留量限制，不能补回已经丢失的内容。手动历史按钮仍可查看保留的终端输出。
5. **文件**：右侧树支持右键菜单：
   - 打开 / 编辑 / 渲染
   - 重命名 / 删除 / 新建文件 / 新建目录
   - 复制 / 剪切 / 粘贴
   - 复制绝对路径 / 复制相对路径
   - 下载 / 上传 / 在终端中定位
6. **编辑**：文本用内置编辑器，`Cmd/Ctrl+S` 保存；Markdown 可切换「编辑 / 渲染」；图片、PDF、HTML、音视频直接预览。
7. **Git**：右侧「更改」页签查看分支和改动；点文件看 diff；可暂存、取消暂存、提交。点「新建 worktree」输入分支名，会创建独立目录并自动切换为工作区，随后即可在新工作区启动另一个 Agent，实现 Emdash 式的并行隔离。
8. **端口预览**：终端里启动 `python -m http.server 3000`、`npm run dev` 等后，输出中的 `localhost:3000` 会出现在终端上方；点 `:3000` 即建立 SSH 本地转发并打开 `http://127.0.0.1:3000`。也可在顶栏链图标里手动添加/删除转发。
9. **重命名会话**：远程工作台里双击左侧「会话」或终端页签即可改名；DSH 左侧原生聊天行悬停时会出现铅笔按钮，可给聊天会话改名。
10. **快速打开**：在文件面板按 `⌘P` / `Ctrl+P`，输入文件名，远程搜索并打开。
11. **设置**：面板右上角齿轮可修改 SSH 配置路径、主机密钥策略、连接保持时长，以及打开或关闭 macOS 完成通知。
12. **完成通知**：Host 端针对已知 Agent 命令观察当前终端界面；仅在可识别的“运行中”状态变为“可输入”状态时发送本机通知，普通 shell、历史回看、断线和自定义程序不会仅凭闲置就发送通知。相关检测不会改远端配置、写入 input 或追加通知转义序列，已连接的 Agent 离开当前页签后仍可监测。由于 PTY 没有统一完成事件，这是尽力检测，Agent 版本或界面变化可能导致漏报；“设置 → 测试通知”可验证本机通知通道，不代表各 Agent 完成事件均已端到端证实。系统通知权限被禁用时，还需在 macOS“通知”设置中允许对应宿主程序。

## SSH 配置示例

```sshconfig
Host gpu-lab
    HostName 10.0.0.12
    User root
    Port 2222
    IdentityFile ~/.ssh/id_ed25519
    ProxyJump bastion
```

插件启动时会自动列出 `gpu-lab`，连接时由 OpenSSH 自己解析完整配置（包括 `ProxyCommand`、`Match`、`Include`）。手动添加的连接会写入插件自己的状态文件，不改动你的 `~/.ssh/config`。

## 状态与安全

- 状态文件：`$DSH_HOME/remote-agent/state.json`（默认 `~/.dsh/remote-agent/state.json`），保存手动连接、工作区、最近选择和 harness 缓存；**不保存密码**。
- 终端存档：`$DSH_HOME/remote-agent/terminals/`，每个会话一个权限为 `0600` 的原子 JSON 检查点，保存名称、启动信息、尺寸以及最近 512K 字符的原始终端输出。输出每秒合并落盘，创建/改名/退出立即保存；强制结束 DSH 时可能丢失最后一批尚未落盘的输出，已保存记录仍在。输出中可能含终端曾显示的敏感内容，按本地聊天历史同样管理。
- 记录数量不设自动淘汰；最多同时连接 12 个 PTY。远端 tmux 会话在关闭 DSH 后继续运行，除非进程自行退出、服务器重启或用户删除会话。插件使用独立的 `tmux -L dsh-remote-agent` server，不接管用户其他 tmux 会话；不会自动安装 tmux。
- 旧版本已经丢失的内存会话无法凭空找回；升级时备份的旧会话会导入为可查看历史，但其进程不能追溯转换为 tmux。
- SSH 密码 / 密钥口令：仅保存在 Host 进程内存，插件卸载或进程重启即清除。
- 主机密钥：默认 `StrictHostKeyChecking=accept-new`（TOFU），可在设置中改为 `yes` / `no`。
- HTTP 路由：`/remote-agent/api/rpc` 由 Host 注册在 DSH Web 服务上，要求同源 + `x-requested-with` 头；和 DSH 自身一样默认只监听 loopback。若通过 `--trusted-host` 对外提供服务，请自行评估这条路由的访问边界。
- 远程命令只执行你显式发起的操作；路径全部做 POSIX 单引号转义，文件名里的空格 / 引号 / 换行不会注入命令。

## 与 Emdash 的关系

本插件参考了 [Emdash](https://github.com/generalaction/emdash)（Apache-2.0）的远程架构（`machines` / `workspaces` / Git worktree / `source-control` / `preview-servers` / `files`），复刻了它的核心**远程工作区 + 并行 Agent**体验：连接、工作区、Agent 启动、远程终端、文件树/编辑器/预览、Git 更改与 diff、worktree 并行隔离、端口预览。

它**不是** Emdash 的完整替代：

- 不做 PR / CI / 合并面板，不做 Linear/GitHub issue 集成；
- 不做 ACP / 对话式的结构化 Agent 聊天（Agent 运行在真实终端里，任意 TUI CLI 都能用）；
- 不做任务、自动化或团队协作；只提供基于终端界面的本机 Agent 完成通知；
- 不做双向文件镜像（文件操作直接发生在远端）。

这样换来的是：服务器上**不需要安装任何额外服务**，任何能在终端里跑的 harness 都能立即使用。

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `⌘⌥R` / `Ctrl+Alt+R` | 打开远程 Agent 工作台 |
| `⌘P` / `Ctrl+P` | 在远程工作区中快速打开文件 |
| `⌘⌥G` / `Ctrl+Alt+G` | 在文件与 Git 更改面板之间切换 |
| `⌘S` / `Ctrl+S` | 保存当前远程文件 |

## 兼容性

- DSH Web / Desktop（开发验证于 0.2.2-rc.1）；
- 本机：macOS / Linux，需要 OpenSSH 客户端；
- 远端：标准 Linux sshd、GNU coreutils；文件列表使用 GNU `ls`/`stat`。已有 `tmux` 时自动启用进程级持久化，不会安装远程服务。

## 目录结构

```
index.js              Host 半部：路由 + RPC 方法
host/sshconfig.js     ~/.ssh/config 解析
host/ssh.js           OpenSSH ControlMaster / exec / PTY argv
host/files.js         远程文件操作
host/git.js           Git 状态 / diff / stage / commit / worktree
host/forwards.js      SSH 端口转发（-O forward）
host/harness.js       Agent harness 检测
host/terminal.js      远程 PTY 会话与输出环形缓冲
host/state.js         持久化状态
client-src/           Web 半部源码（React + xterm.js）
client.js             构建后的浏览器 bundle
```

## 许可

MIT
