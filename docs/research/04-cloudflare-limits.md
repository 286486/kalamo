# 调研四：Cloudflare 平台限额与定价（Kalamo 托管相关）

> 事实核查：Sonnet subagent，2026-09-22，仅取 developers.cloudflare.com 官方文档与定价页。未能核实处见文末。数字会随 Cloudflare 调价变化，实施前复核。

## 1. Workers

| 项目 | Free | Paid | 来源 |
|---|---|---|---|
| 脚本大小（未压缩） | 64 MiB | 64 MiB（CLI 显示的 gzip 大小仅供参考，无单独压缩限制） | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| CPU 时间 / 请求 | 10 ms（固定） | 默认 30 s，可配到 5 min（`limits.cpu_ms`）；Cron / Queue consumer 最高 15 min | [limits](https://developers.cloudflare.com/workers/platform/limits/)、[pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| 内存 / isolate | 128 MB（JS heap + Wasm） | 128 MB | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| 子请求 / 调用 | 50 | 更高（页面措辞不明确，见未核实） | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| 环境变量 / Worker | 64 | 128 | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| WASM 是否计入脚本大小 | 是，64 MiB 覆盖全部打包模块 | 同 | [limits](https://developers.cloudflare.com/workers/platform/limits/) |

**对 Kalamo 的含义**：CanvasKit（约 7 MB 未压缩）+ resvg + HarfBuzz 放进 Worker 完全在 64 MiB 之内，包体不是问题；真正的约束是 **128 MB 内存**与 **Free 档 10 ms CPU**。Headless 渲染必须在 Paid 档运行。

## 2. Durable Objects

| 项目 | Free | Paid | 来源 |
|---|---|---|---|
| 是否可用 | 是（仅 SQLite 后端） | 是（SQLite + KV 后端） | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| 存储 | 账户合计 5 GB | 每个 DO 10 GB | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| 单键值大小 | 2 MB | 2 MB | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| 单 DO 并发 WebSocket | 无数值上限（文档称"数千"） | 同 | [WS best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) |
| WebSocket Hibernation | 可用；休眠期间不计费时长 | 同 | 同上 |
| 请求 | 100,000 / 天 | 含 1M / 月，之后 $0.15 / M | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| 时长 | 13,000 GB-s / 天 | 含 400,000 GB-s / 月，之后 $12.50 / M GB-s | 同上 |
| SQLite 行读 / 写 | 5M 读、100K 写 / 天 | 含 25B 读（$0.001 / M）、50M 写（$1.00 / M） | 同上 |

**对 Kalamo 的含义**：每文档一个 DO 的模型在 Free 档就能跑通开发；单键 2 MB 意味着文档 JSON 不能整块存一个键，事务日志按行写 SQLite、快照分片或直接放 R2。

## 3. R2

| 项目 | Free | Paid | 来源 |
|---|---|---|---|
| 存储 | 10 GB-月 | $0.015 / GB-月 | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Class A 操作 | 1M / 月 | $4.50 / M | 同上 |
| Class B 操作 | 10M / 月 | $0.36 / M | 同上 |
| 出站流量 | 免费 | 免费 | 同上 |
| 预签名 URL | 支持（仅 S3 API 域名，不支持自定义域名） | 同 | [presigned-urls](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| 单对象上限 | 约 5 TiB | 同 | [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) |

## 4. D1

| 项目 | Free | Paid | 来源 |
|---|---|---|---|
| 行读 | 5M / 天 | 含 25B / 月，$0.001 / M | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| 行写 | 100,000 / 天 | 含 50M / 月，$1.00 / M | 同上 |
| 单库存储 | 500 MB | 10 GB | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| 账户存储 | 5 GB | 最高 1 TB，超 5 GB 部分 $0.75 / GB-月 | 同上 |
| 库数量 | 10 | 50,000 | 同上 |

## 5. KV

| 项目 | Free | Paid | 来源 |
|---|---|---|---|
| 读 | 100,000 / 天 | 未核实 | [KV limits](https://developers.cloudflare.com/kv/platform/limits/) |
| 写 | 1,000 / 天（每 namespace） | 未核实 | 同上 |
| 存储 | 1 GB | 未核实 | 同上 |
| 单值上限 | 25 MiB | 25 MiB | 同上 |
| 键长上限 | 512 B | 512 B | 同上 |

## 6. Queues

| 项目 | Free | Paid | 来源 |
|---|---|---|---|
| 可用性 | 是 | 是 | [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) |
| 消息大小 | 128 KB | 128 KB | 同上 |
| 保留 | 固定 24 h | 可配至 14 天 | 同上 |
| 定价 | 含 10,000 ops / 天 | 含 1M ops / 月，$0.40 / M（每 64 KB 读 / 写 / 删为 1 op） | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |

## 7. Browser Rendering

| 项目 | Free | Paid | 来源 |
|---|---|---|---|
| 可用性 | 是，限制很紧 | 完整 | [BR limits](https://developers.cloudflare.com/browser-rendering/platform/limits/) |
| 并发浏览器 | 3 | 含 10（月均），之后 $2.00 / 个 | [BR pricing](https://developers.cloudflare.com/browser-rendering/platform/pricing/) |
| 浏览器时长 | 10 min / 天 | 含 10 h / 月，之后 $0.09 / h | 同上 |
| 速率 | 1 请求 / 10 s | 30 / s（Quick Actions）；3 / s 新实例 | [BR limits](https://developers.cloudflare.com/browser-rendering/platform/limits/) |

**对 Kalamo 的含义**：Browser Rendering 只能做低频回退，不能做主渲染路径；主路径必须是 Worker 内的 resvg / CanvasKit WASM。

## 8. Workers Paid 基础价

$5 / 月 / 账户，含 10M 请求 / 月（超 $0.30 / M）与 30M CPU-ms / 月（超 $0.02 / M）。来源：[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)。

## 9. Dynamic Workers / Worker Loaders

文档位于 [developers.cloudflare.com/dynamic-workers/](https://developers.cloudflare.com/dynamic-workers/)，定位为"运行时指定代码、无限数量 Worker 的沙箱执行"，是容器之外的隔离方案。**页面未明确 GA / beta 状态**，视为未核实。

## 10. Workers Static Assets

| 项目 | Free | Paid | 来源 |
|---|---|---|---|
| 文件数 / 版本 | 20,000 | 100,000 | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| 单文件上限 | 25 MiB | 25 MiB | 同上 |

## 未核实

- Workers Paid 档子请求上限的确切数字。
- KV Paid 档读 / 写 / 存储限额。
- DO Free 档"账户合计 5 GB"是否另有单 DO 上限。
- Dynamic Workers 的 GA / beta 状态。
- 单 DO 并发 WebSocket 的数值上限（官方未公布）。
