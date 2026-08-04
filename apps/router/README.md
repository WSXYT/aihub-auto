# aihub-auto router

AIHub(sub2api)OpenAI 自动路由反代。本地代理按价格、官网真实用户平均 TTFT、标准化云端探测、本机实时 TTFT/错误率选择分组;新会话动态均衡,已有会话固定回到原组保留 prompt cache,故障时只迁移失败会话。

## 快速开始

1. 从 [Releases](https://github.com/WSXYT/aihub-auto/releases/latest) 下载对应平台压缩包并解压
2. 运行 `aihub-auto`(Windows 双击 `aihub-auto.exe`)
3. 打开控制台 <http://127.0.0.1:8787/ui>,登录 AIHub 账号(或直接粘贴 token)
4. 把你的客户端指向本地代理:

```bash
# OpenAI 系(Codex CLI、OpenAI SDK 等)
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="anything"          # 本地代理自动注入真实 Key,这里随便填
```

之后一切照旧——代理在幕后持续选择最优分组。

桌面用户可直接安装 Release 中的 Tauri 版本：桌面窗口内置本路由器作为 sidecar，启动健康检查通过后打开同一套控制台，关闭窗口后转入托盘。托盘可重新显示窗口、打开实时日志、检查签名更新或明确退出。大多数 Windows x64 用户使用 NSIS；`aihub-auto-desktop-windows-x64.zip` 是可解压直接运行的桌面版。macOS 使用对应架构的 DMG，Debian/Ubuntu x64 使用 `.deb`；`aihub-auto-headless-<platform>-<arch>.zip` 始终是无窗口 standalone 路由器，适合无界面环境和其他 Linux 发行版；控制台右上角会标记“无头路由器”。

## 策略

| 模式 | 选择规则 |
| --- | --- |
| 省钱优先 economy | 从最低健康价格层选择;更高健康层保持可用待命,当前层故障/过慢/不稳定时才升档 |
| 均衡 balanced(默认) | 对数价格 0.5 + 对数保守延迟 0.5,保持稳定的几何折中 |
| 速度优先 speed | 对数价格 0.2 + 对数保守延迟 0.8,更早使用快速组 |

价格区间硬约束默认 `0 ~ 0.15x`;省钱健康门槛默认是最近至少 3 条结果后成功率不低于 80%、保守 TTFT 不超过 20 秒。已有最近结果但成功率为 0% 的组立即视为不稳定,不会显示为可用升档。官网真实用户均值与云端探测先做几何融合,再按本地置信度融合本机 Peak/P90;缺失或 0 值来源不参与,旧 usage-stats 只作为用户均值回退,不会重复计权。倍率区间、健康门槛和黑名单都可在控制台热调整。已有连续会话仍回到其原分组,不会为了降价破坏上游会话状态。

## 手动锁定与 User-Agent

候选分组表的“锁定”按钮可将一个组持续设为新请求首选,状态跨重启保留,顶部状态带可一键解除。锁定不会破坏已有显式会话、conversation、`previous_response_id` 或热缓存亲和;锁组遇到 TTFB 超时、429/5xx、模型不兼容或熔断时,当前请求临时换组,恢复后锁定继续生效。economy 的过慢/稳定率软门槛可手动覆盖,账号不可用、倍率区间、黑名单、无效延迟和硬错误率不能绕过。

控制台“上游 User-Agent”可覆盖发往模型 API 的请求头,对初次请求和故障重试都生效。留空时原样保留客户端 UA;它不会修改 AIHub 登录、Key 管理等控制 API 的产品标识。

三种模式的静态评分使用统一对数效用,请求调度在 `poolMaxGroups` 内让静态最优组与会话稳定挑战者比较。负载按 `score - latencyWeight * ln(pending + 1)` 连续惩罚,不会再因固定分数窗口丢掉健康容量。

## Key 模式

- **pool(默认)**:按需为每个使用中的组创建 `aihub-auto-g{组id}` Key。新会话用 P2C + Peak EWMA 在当前价格层内分配,已有会话保持组亲和;一个组可同时承载多个请求,同组并发创建 Key 只发一次管理请求。会话映射保留 24 小时,但 Key 只在最近缓存窗口(默认 5 分钟)受亲和保护;之后可由普通 LRU 回收,续接时按原组重建。多个实例共享账号时不会互删未知自动 Key;上游 401 会使失效的 managed Key 原子作废、同组重建并重试。超倍率、用户黑名单、账号不可用、延迟无效、近 3 小时稳定率过低或已不在最新统计中的闲置组可强制回收。当前组、创建中、预留中、在飞组始终受保护。**绝不触碰手动创建的 Key**
- **single(兼容)**:使用现有的一把 Key,切组 = `PUT /api/v1/keys/{id}`。代理流与控制面切组共享 FIFO 租约,长流结束前不会中途改 Key 分组;上游单 Key 的全局语义仍无法像 pool 一样并行使用不同组,仅供账号不能自动创建 Key 时使用。

## 为什么比 AIHubRouter 好

| | AIHubRouter | aihub-auto |
| --- | --- | --- |
| 数据 | 只有公开均值 | 官网真实用户 + 云端探测 + 本机 TTFT/错误率三源融合 |
| 故障 | 无感知 | 请求内换组重试(未回包前),熔断指数退避 |
| 缓存 | 固定粘性 | 会话级组亲和;控制面优化不会迁移热会话 |
| 执行 | 仅 PUT 切组 | 自动 Key 池 + 请求本地 P2C/Peak-EWMA;single 兼容模式 |

算法细节见 [`packages/core/ALGORITHM.md`](../../packages/core/ALGORITHM.md)。

## 配置

配置目录:Windows `%LocalAppData%\aihub-auto`,Linux `~/.config/aihub-auto`,macOS `~/Library/Application Support/aihub-auto`。`config.json` 支持:

监听端口也可只为本次启动覆盖，不修改 `config.json`：

```bash
AIHUB_AUTO_PORT=9000 ./aihub-auto
./aihub-auto --port 9000
```

优先级为 `--port` > `AIHUB_AUTO_PORT` > `config.json` 的 `listen.port` >
默认值 `8787`。端口必须是 1 到 65535 的十进制整数；非法值会在监听前使
启动失败。运行 `./aihub-auto --help` 可查看启动参数。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://aihub.top` | 站点地址(usage-stats 是 aihub 自有接口,不兼容其他站) |
| `publicOrigin` | 空 | 可信反向代理的完整 HTTP(S) origin,例如 `https://router.example.com`;不信任转发头 |
| `sentryDsn` | `xytime/aihub` 公共 DSN | Sentry 错误与反馈项目;可用 `SENTRY_DSN` 覆盖,显式留空时 SDK 与反馈入口均不加载 |
| `upstreamUserAgent` | 空 | 模型代理请求的自定义 UA;空值沿用客户端 UA,可在控制台热更新 |
| `listen.host` / `listen.port` | `127.0.0.1` / `8787` | 监听地址,可改 `0.0.0.0` |
| `mode` | `balanced` | economy / balanced / speed |
| `priceBand.min/max` | 0 / 0.15 | 倍率硬约束 |
| `groups.<来源名>.mode` | 回退 `mode` | sub2api 来源组专用 economy / balanced / speed 策略 |
| `groups.<来源名>.priceBand.min/max` | 回退全局 `priceBand` | sub2api 来源组专用倍率边界 |
| `economyPolicy.minSuccessRate` | 0.8 | 省钱模式最低 3 小时成功率 |
| `economyPolicy.minOutcomeSamples` | 3 | 启用成功率门槛前的最少结果数 |
| `economyPolicy.maxConservativeLatencyMs` | 20000 | 省钱模式最大保守 TTFT |
| `keyMode` | `pool` | pool / single;启动级配置,修改后需重启 |
| `poolMaxGroups` | 4 | 新会话参与均衡的候选/池目标数;安全条件不满足时允许软超限;修改后需重启 |
| `sessionTtlMs` | 86400000 | 会话与模型能力记录保留时间 |
| `sessionMaxEntries` | 10000 | 会话记录上限 |
| `pollIntervalMs` | 60000 | 路由轮询间隔 |
| `proxyToken` | 无 | 反代访问口令;**监听非 127.0.0.1 时必填** |
| `uiPassword` | 无 | 控制台口令;**监听非 127.0.0.1 时必填** |
| `decision.*` | 见 ALGORITHM.md | 粘性/缓存惩罚/空闲阈值/最短驻留 |
| `auditLog` | false | JSONL 决策审计(含每轮全部候选得分) |
| `logLevel` | `info` | `app.log` 最低日志级别:debug / info / warn / error |

## sub2api 多来源接口

`X-Sub2api-Group` 请求头选择来源组策略；缺少该头或名称未配置时，仍使用全局 `mode` 与 `priceBand`。在默认 `pool` 模式下，来源组的会话和 Responses 别名会独立命名，避免不同来源共享缓存亲和；`single` 模式保留原有单个全局 Key 语义，不提供该隔离能力，多来源部署应使用 `pool`。

通过已鉴权的 `POST /ctl/config` 热更新来源组。`groups` 字段是完整映射替换，组内遗漏的 `mode`、`priceBand.min` 或 `priceBand.max` 分别回退全局配置：

```bash
curl -X POST http://127.0.0.1:8787/ctl/config \
  -H 'x-ui-password: <uiPassword>' \
  -H 'content-type: application/json' \
  -d '{"groups":{"budget":{"mode":"economy","priceBand":{"min":0,"max":0.05}},"premium":{"mode":"speed","priceBand":{"min":0.05,"max":0.12}}}}'
```

`GET /ctl/group-prices` 同样使用 `x-ui-password`，供 sub2api 轮询每个来源组的实时最低可用倍率：

```json
{
  "at": 1760000000000,
  "default": { "status": "ready", "lowestRate": 0.03, "groupId": 12 },
  "groups": {
    "budget": { "status": "ready", "lowestRate": 0.03, "groupId": 12 },
    "premium": { "status": "unavailable", "lowestRate": null, "groupId": null }
  }
}
```

`ready` 表示该来源组当前有登录账号、可用分组和未熔断候选；`unauthenticated` 表示未登录或凭据失效，`stale` 表示实时统计无法取得，`unavailable` 表示当前区间内没有可路由候选。该接口只返回倍率和分组 ID，不返回托管 Key。

## Sentry 与用户反馈

默认连接 `xytime/aihub` Sentry 项目,也可通过 `sentryDsn` 或环境变量 `SENTRY_DSN` 覆盖。后端使用 `@sentry/bun` 捕获路由器自身未处理异常,控制台右上角显示 Sentry 官方“用户反馈”表单。已登录且 `/auth/me` 返回有效邮箱时,该邮箱写入 Sentry user 并预填反馈;未登录或没有邮箱时保持 Sentry 默认匿名行为。

AIHub/OpenAI HTTP 错误、429/5xx、TTFB 超时、网络中断和客户端取消属于路由输入,由本地日志、熔断和故障转移处理,不会发送为 Sentry 错误。SDK 不启用 tracing、session、fetch、console 或请求上下文集成,并显式关闭 cookies、headers、body、query、GraphQL/GenAI/数据库参数、本地变量和源码上下文采集;只有路由器自身异常与用户主动提交的反馈会生成 envelope。DSN 是可公开的客户端配置,但控制台状态接口仍受 `uiPassword` 保护。

Linux x64 发行包采用 Bun 的 `bun-linux-x64-baseline` 目标，支持不具备 AVX2 的较旧 x86-64 CPU。已验证 CentOS 7（glibc 2.17）和 Debian 9（glibc 2.24）；glibc 2.12 及更早版本不受支持。完整结果见根目录 `security_best_practices_report.md`；容器测试共享宿主机内核，不代表旧内核兼容性。

## 安全边界

- 默认仅监听 127.0.0.1,凭据仅存本机(POSIX 下 0600),日志脱敏;`/ctl/status` 只返回 Key 元数据,不返回 `sk`
- 配置目录内 `app.log` 默认记录运行日志(5 MiB × 当前+3 个历史),`crash.log` 记录生命周期和未处理异常(1 MiB × 当前+3 个历史)。控制台日志页通过受 `uiPassword` 保护的 `/ctl/logs` 最多读取 1000 行/512 KiB，并在返回前再次脱敏。直接双击 Windows EXE 使用 `%LocalAppData%\\aihub-auto`;通过 `AIHUB_AUTO_CONFIG_DIR` 可显式指定其他目录
- 监听 `0.0.0.0` 时强制要求 `proxyToken` + `uiPassword`,否则拒绝启动(防止别人烧你的额度);客户端此时用 `OPENAI_API_KEY=<proxyToken>` 访问
- 无 TLS:公网部署建议前置反代(Caddy/Nginx)或仅在可信内网使用;反向代理需保留原始 Host,并将 `publicOrigin` 设置为唯一对外 HTTPS origin
