# dsh-peer-link

DeepSeek Harness 的点对点消息插件：**本机按会话分端点** + **跨机器 SSH 端点**，一套 `peer_list` / `peer_send` 同时覆盖两者。

版本：0.1.0（新插件 `dsh-peer-link`，合并了原 `@deepseek-ai/dsh-peer-link` 与 `dsh-peer-ssh` 的全部功能）

## 能力

| 范围 | 说明 |
|---|---|
| 本机 | 每个**打开着的** dsh 会话注册为独立 peer：`dsh-<会话短id>`；入站消息按端点归属直接注入对应会话，正文不需要任何标签 |
| 跨机器 | 每个 `remotes` 条目代表另一台机器上的一个 agent 端点（Claude Code 会话 / 另一个 DSH）；出站 `ssh -L`，入站 `ssh -R` + 本地 inbox，远端无需安装任何东西 |
| 失败语义 | 目标不存在 / 会话已关 / 隧道不通 → **显式失败**，不会 `delivered:true` 假装成功 |

## 工具

### `peer_list [cwd]`

```
本地 peers(2,最新→最旧):
  - dsh-1261253b (pid=36032, D:\...\Harness, 2026/11/6 14:49:12)(当前会话)
  - dsh-5cf25795 (pid=36032, D:\...\Harness, 2026/11/6 13:43:36)
跨机器 remotes(1):
  - cc-wsl [ssh] up/up inbox=17901 received=2 回复地址=uds:/tmp/dsh-peer-cc-wsl.sock
```

`cwd` 只过滤本地 peers（子串匹配）。

### `peer_send target=... text=...`

target 三种写法：

| 写法 | 目标 |
|---|---|
| `dsh-5cf25795` | 本地会话端点（名字取自 `peer_list`） |
| `cc-wsl`（或 `remote:cc-wsl`） | 配置里的 remote |
| `\\.\pipe\LOCAL\dsh-...` / `/tmp/xxx.sock` | 直接给地址 |

远端发来的消息以如下形式进入会话：

```
📨 [peer] <发送者名> 说:
<正文>
(回复:peer_send,target 填 "<remote 名>"。仅寒暄/确认时无需回复)
```

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-peer-link
      name: dsh-peer-link
      config:
        # ---- 本地 ----
        name: dsh                  # 本地 peer 名前缀 → dsh-<会话短id>
        injectInbound: true        # 入站注入会话
        registerTool: true         # 注册 peer_send / peer_list
        # ---- 跨机器 ----
        bindHost: '127.0.0.1'      # inbox 只监听回环
        restartDelayMs: 1000       # 隧道退避:1s,2s,4s...
        maxRestartDelayMs: 30000
        remotes:
          - name: cc-wsl
            sshTarget: 'leon@localhost'
            sshArgs: [ '-o', 'StrictHostKeyChecking=accept-new' ]
            remoteSocket: '/run/user/1000/cc-socks/*.sock'   # 支持通配符,取最新
            localPort: 17902        # 0 = 自动分配
            remoteListenPath: '/tmp/dsh-peer-cc-wsl.sock'    # 远端回信端点(ssh -R)
            inboxPort: 17901        # 0 = 自动分配
            # peerName: dsh-cc-wsl   # 默认 dsh-<name>
            # autoRegister: true     # 启动时把本机 peer 写进远端 ~/.claude/sessions/
            # remoteSessionDir: '~/.claude/sessions'
            # transport: tcp         # 或走普通 TCP(remoteHost/remotePort)
```

## 命令行

```powershell
# 手动在远端写/删 peer 记录(通常由 autoRegister: true 自动完成)
dsh-peer-link-register --ssh leon@localhost --name dsh-cc-wsl --socket /tmp/dsh-peer-cc-wsl.sock
dsh-peer-link-register --ssh leon@localhost --name dsh-cc-wsl --remove
```

> 若这个 profile 是手工拷贝安装的(没有经过 pnpm 链接 bin),命令不在 PATH 上,直接调脚本:
> `node "<profile>\node_modules\dsh-peer-link\bin\remote-register.mjs" --help`

## 工作原理

```
本机会话 A ──pipe/unix──┐
本机会话 B ──pipe/unix──┤ peer-link(host) ── ssh -L ──> 远端 agent socket
                        └─ inbox(127.0.0.1:17901) <── ssh -R ── 远端 DSH socket
```

- 本地：`\\.\pipe\LOCAL\dsh-<pid>-<短id>`（Windows）/ `<sockDir>/<pid>-<短id>.sock`（其它平台），注册文件 `~/.claude/sessions/<pid>-<短id>.json`。
- 远端：`ssh -N -L bindHost:<localPort>:<remoteSocket>` 出站；`ssh -N -R <remoteListenPath>:bindHost:<inboxPort>` 入站。

## 限制与排错

- **本地只有打开着的会话才有端点**；会话关闭即注销，发给它的消息会报 `ENOENT`。
- 远端需要 SSH 通路（`ssh <target>` 能免交互登录）。`peer_list` 里 `outbound/inbound` 显示 `down` 时看 `lastError`。
- `remoteSocket` 用通配符时按修改时间取最新的 socket；注意 CC 的 socket 目录在 WSL 是 `/run/user/<uid>/cc-socks/`。
- `autoRegister` 只写 peer 记录，不负责启动远端进程；远端 agent 仍需在运行。
- 端口冲突（`localPort` / `inboxPort`）会让隧道起不来，改成 `0` 让它自动分配。

## 安装

```powershell
dsh plugin --profile desktop add --registry http://172.27.30.100:8765 "file:D:\Leon\Deepseek\Workpsace\plugins-src\dsh-peer-link-0.1.0\dsh-peer-link-0.1.0.tgz"
```

装进 profile 的 `dsh.profile.bundles` 后重启 DSH 生效。
