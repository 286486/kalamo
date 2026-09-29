# docs/

| 文件 | 内容 |
|---|---|
| [REQUIREMENTS.md](./REQUIREMENTS.md) | **需求文档 v0.1**：项目概述、调研结论、用户场景、产品原则、功能需求（5.1–5.18）、MCP 接口需求（工具 / 资源 / schema / 回执 / 错误码）、非功能需求、架构建议、里程碑、风险与开放问题、Illustrator 功能映射表、场景图 JSON 草案 |
| [research/01-illustrator-core-features.md](./research/01-illustrator-core-features.md) | 调研一：Adobe Illustrator 工具箱、面板、工作流、文件格式、脚本 DOM 盘点，以及教程共识的"核心功能"分梯队清单（Opus subagent，基于 helpx.adobe.com 40+ 页与 Scripting Guide） |
| [research/02-web-vector-tech-landscape.md](./research/02-web-vector-tech-landscape.md) | 调研二：Figma / Penpot / Excalidraw / tldraw / Graphite 等竞品架构与许可，渲染 / 布尔 / 文字 / 手绘 / CRDT / 导入导出等技术选型，性能经验数字（Sonnet subagent） |
| [research/03-mcp-design-tool-patterns.md](./research/03-mcp-design-tool-patterns.md) | 调研三：Figma / Canva / Excalidraw / Blender / antvis 等 MCP server 的工具设计、接口粒度对比、反馈回路模式、常见坑（Sonnet subagent） |
| [research/04-cloudflare-limits.md](./research/04-cloudflare-limits.md) | 调研四：Cloudflare Workers / Durable Objects / R2 / D1 / KV / Queues / Browser Rendering 的限额与定价核查（Sonnet subagent，官方文档） |
| [research/06-illustrator-drawing-tools.md](./research/06-illustrator-drawing-tools.md) | 调研六：Illustrator 绘图工具的行为核查 |
| [research/07-kalamo-name-check.md](./research/07-kalamo-name-check.md) | 调研七：Kalamo 与其他候选名在含义、包名、域名、商标上的核查，以及未核查的范围（ADR-0069） |

调研日期：2026-09-22。调研报告中标注"未核实"的条目在需求文档 §10.1 风险表中有对应缓解措施。
