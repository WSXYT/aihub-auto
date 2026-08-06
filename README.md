# aihub-auto

让 OpenAI 兼容客户端通过本地地址使用 [AIHub](https://aihub.top)，并自动选择合适分组的跨平台反向代理。Windows 和 macOS 提供带托盘与 minisign 验证更新的 Tauri 桌面应用；Debian/Ubuntu 提供原生桌面包，所有平台也保留无需安装的 standalone 路由器。

它适合已经有 AIHub 账号、希望减少手动切组，同时保留连续对话缓存的人。启动后，客户端只需要访问本机 `http://127.0.0.1:8787/v1`；登录、Key 创建、分组选择、故障转移和运行日志由 aihub-auto 在本机处理。

> 仅支持 AIHub 的公开分组统计和 API，不是适配任意 OpenAI 兼容站点的通用代理。

## 五分钟开始

1. 从 [Releases](https://github.com/WSXYT/aihub-auto/releases/latest) 下载匹配的包：大多数 Windows x64 用户用 NSIS 安装器；免安装桌面版用 `aihub-auto-desktop-windows-x64.zip`；macOS 用对应架构的 DMG；Debian/Ubuntu x64 用 `.deb`。`aihub-auto-headless-<platform>-<arch>.zip` 是不带窗口的 standalone 路由器，适合无界面部署和其他 Linux 发行版。
2. 启动 `aihub-auto` 桌面应用。它会启动内置路由器并在健康检查通过后打开窗口；关闭窗口后仍在系统托盘运行。standalone 版本则直接运行压缩包中的 `aihub-auto`/`aihub-auto.exe`。
3. 按首次使用向导登录 AIHub 账号或粘贴 Access Token。standalone 版本也可打开 <http://127.0.0.1:8787/ui>。
4. 将你的 OpenAI 兼容客户端指向本地代理：

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="local-proxy"
```

`OPENAI_API_KEY` 在本机默认可以是任意非空值；代理会使用你在控制台登录的 AIHub 凭据。客户端已经设置过 `OPENAI_BASE_URL` 时，只需替换成上面的本地地址后照常使用。

需要修改本次启动的监听端口时，可以使用环境变量或命令行参数：

```bash
AIHUB_AUTO_PORT=9000 ./aihub-auto
./aihub-auto --port 9000
```

端口优先级为 `--port` > `AIHUB_AUTO_PORT` > `config.json` 中的
`listen.port` > 默认值 `8787`。命令行和环境变量只覆盖本次启动，不会写回
`config.json`。运行 `./aihub-auto --help` 可查看启动参数。

启动后可访问：

| 地址 | 用途 |
| --- | --- |
| <http://127.0.0.1:8787/ui> | 登录、配置和实时运维控制台 |
| <http://127.0.0.1:8787/healthz> | 存活检查 |
| <http://127.0.0.1:8787/v1/models> | 验证客户端可通过代理读取模型 |
| <http://127.0.0.1:8787/v1> | 本地 API 状态响应，不会转发到上游 |

## 桌面应用

桌面窗口复用同一套本地控制台，不复制代理或路由逻辑。应用启动时先拉起 bundled Bun sidecar，再等待 `/healthz` 返回 200；端口占用或 sidecar 启动失败时显示本地诊断页。开发构建默认使用 8798，正式构建使用 8787，避免调试时打断正在使用的正式路由器。

关闭主窗口只会隐藏到托盘。托盘菜单提供显示窗口、运行日志、检查更新和明确退出；退出时同时停止 sidecar。日志页通过已鉴权的 `/ctl/logs` 读取 `app.log` 最近 500 行，服务端限制为最多 1000 行/512 KiB 并再次脱敏，支持级别/文本筛选与暂停自动刷新。

Windows 和 macOS 桌面应用启动后会检查 GitHub Releases。发现新版时由用户点击确认，Tauri 校验 minisign 签名后下载并安装，显示进度，成功后自动重启。Debian/Ubuntu `.deb` 由系统包管理器更新；发布同时附带免安装的 Windows 桌面 ZIP 和文件名带 `-headless` 的无窗口 standalone ZIP，桌面环境或更新器不可用时可直接回退。`*.sig` 与 `latest.json` 只供更新器使用，不需要手动打开。当前自动更新包已做 minisign 验证；Windows Authenticode 与 macOS Developer ID/公证尚未配置，系统可能仍显示发行方提示。

## 日常使用

通常只需要在控制台完成三件事：

1. **登录 AIHub**：代理保存凭据在本机配置目录，不会把 Key 返回给控制台接口或写入普通日志。
2. **选择策略**：默认“均衡”；想控制成本可选“省钱”，优先速度可选“速度”。
3. **让客户端持续使用本机 `/v1` 地址**：会话、Responses 对话链和稳定提示前缀会保持同组亲和，避免每个请求重新切组。

控制台会分别显示官网真实用户、标准化云端探测和本机风险 TTFT，以及融合值、待命升档层、熔断/黑名单/延迟等排除原因、近 3 小时稳定率、会话数量、在飞请求及 Key 池状态。无头 standalone 版本会在右上角标记“无头路由器”。候选行可一键锁定/解除某个组,策略区也可自定义发往模型 API 的 User-Agent。右上角提供官方 Sentry 用户反馈入口。运行中的配置可直接保存；`keyMode` 和 `poolMaxGroups` 属于启动级配置，修改后重启生效。

AIHub 无法直连时，打开“设置 → 出站代理”，选择“系统代理”或“自定义代理”。自定义代理填写完整的 HTTP(S) 地址，例如 `http://127.0.0.1:7890`；可先点击“测试连接”验证当前输入，再保存。保存后新的 AIHub 与模型请求立即使用该设置，无需重启。当前不支持 SOCKS 或 PAC。

## 路由策略

| 模式 | 行为 |
| --- | --- |
| `economy` 省钱 | 只在最低健康倍率层为新会话选组；高价健康层留作故障或健康退化时的升档候选 |
| `balanced` 均衡 | 对数价格和对数保守延迟等权折中，默认模式 |
| `speed` 速度 | 对数保守延迟权重更高，更早使用快速组 |

省钱模式的默认健康门槛为：最近 3 小时至少 3 条结果后成功率不低于 80%，保守 TTFT 不超过 20 秒。已有结果且成功率为 0% 的组会立即视为不稳定，不能显示为可用升档。官网真实用户均值与云端探测先做几何融合，再按本地置信度融合本机 Peak/P90；缺失或 0 值来源不参与，不把“无数据”误当成快速或失败。

所有模式都使用同一尺度无关的对数效用和无上限负载惩罚：统一放大倍率或延迟不会改变相对排序，某组积压足够高时可使用池内其他健康容量。负载计数不是单槽锁，一个分组可同时承载多个并发请求；省钱模式仍只在同一最低价格层内分流，不会因为负载单独加价。

手动锁定优先作用于新会话和无状态请求；已有显式会话、conversation、Responses 分支与热缓存亲和仍回原组。锁组在首字节前遇到 429、5xx、超时、模型不兼容或熔断时仅本请求临时故障转移，不会自动解除锁定；一旦开始回传内容，绝不透明重放，避免重复输出和计费。

## Key 模式

- **`pool`（默认）**：按需创建并复用 `aihub-auto-g{groupId}` Key。同一组可并发处理多个请求，新会话在当前候选层内动态均衡，已绑定会话保持原组。默认目标池大小为 4，短缓存窗口外的空闲 Key 可以回收；不会触碰手动创建的 Key。
- **`single`（兼容模式）**：复用已有的一把 Key，通过上游切组。代理长流和控制面切组共享 FIFO 租约，不会在响应中途改组；因为上游的单 Key 切组仍是全局行为，无法像 pool 一样并行使用不同组，仅适用于不能创建自动 Key 的账号。

## 配置、日志与安全

配置和日志目录：

| 系统 | 目录 |
| --- | --- |
| Windows | `%LocalAppData%\\aihub-auto` |
| Linux | `~/.config/aihub-auto` |
| macOS | `~/Library/Application Support/aihub-auto` |

其中 `config.json` 保存路由配置和会话状态，`app.log` 记录脱敏运行日志，`crash.log` 记录启动、退出和异常事件，均会自动轮转。可通过 `AIHUB_AUTO_CONFIG_DIR` 指定其他目录。

默认使用 `xytime/aihub` 的公共 Sentry DSN，也可在 `config.json` 设置 `sentryDsn` 或用 `SENTRY_DSN` 环境变量覆盖。启用后只上报路由器自身异常，不把 AIHub/OpenAI 响应错误、超时、连接中断或客户端取消当成 Sentry 错误；tracing、session、fetch、console、请求内容及各类敏感数据自动采集均关闭。登录邮箱仅在账号已验证时用于 Sentry user 与反馈表单预填，未登录保持匿名。

默认只监听 `127.0.0.1`。如需监听局域网地址，必须设置 `proxyToken` 和 `uiPassword`；客户端随后以 `OPENAI_API_KEY=<proxyToken>` 访问代理。公网部署应在可信反向代理和 TLS 后运行，并把 `publicOrigin` 配置为对外 HTTPS origin。

完整配置项、池回收规则和安全边界见 [router 使用说明](apps/router/README.md)。

Linux x64 发行包使用 Bun 的 baseline CPU 目标，以兼容不支持 AVX2 的较旧
x86-64 处理器；已验证 CentOS 7（glibc 2.17）和 Debian 9（glibc 2.24），
不支持 glibc 2.12 及更早版本。完整矩阵见仓库安全审计报告。

## Koishi 查询插件

[`koishi-plugin-aihub-auto`](packages/koishi-plugin-aihub-auto) 是独立的只读推荐插件，不会操作路由器或 AIHub Key：

```bash
npm i koishi-plugin-aihub-auto
```

- `最优分组`：返回 1 到 6 个接近最佳的公开统计候选。
- `最烂分组`：固定返回 1 个候选，先取最高有效倍率层，再取该层保守首字延迟最高的分组。

详细配置和群聊触发范围见 [插件说明](packages/koishi-plugin-aihub-auto/README.md)。

## 项目结构

| 目录 | 说明 |
| --- | --- |
| [`apps/router`](apps/router) | 跨平台单文件反代、自动 Key 池、会话亲和、请求内故障转移和 Web 控制台 |
| [`apps/desktop`](apps/desktop) | Tauri 2 原生窗口、sidecar 生命周期、托盘与 minisign 验证更新 |
| [`packages/koishi-plugin-aihub-auto`](packages/koishi-plugin-aihub-auto) | Koishi 最优/最烂分组查询插件 |
| [`packages/core`](packages/core) | 共享评分、决策、熔断和本地观测核心，无运行时依赖 |

## 开发

```bash
bun install
bun run check          # 全部 Bun 测试和 TypeScript 检查
bun run desktop:sidecar # 构建当前 Rust target 的 bundled router
bun run desktop:dev     # Tauri 开发窗口，默认路由端口 8798
bun run desktop:build   # Tauri 安装包；更新签名需要 TAURI_SIGNING_PRIVATE_KEY
bun scripts/build.ts   # 构建 standalone 六目标到 artifacts/
```

算法、并发语义和故障转移细节见 [核心算法说明](packages/core/ALGORITHM.md)。
