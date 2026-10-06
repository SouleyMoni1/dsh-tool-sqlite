# dsh-tool-mssql

DeepSeek Harness 的 **SQL Server 原生工具插件**：模型直接读（可选写）你配置的 SQL Server，**不经过 MCP、不 spawn dbhub 进程**。

> 由 [WODE25500/dsh-tool-sqlite](https://github.com/WODE25500/dsh-tool-sqlite) 的骨架 fork 而来：去掉 SQLite 工作区语义，换成 `mssql`（tedious）驱动 + 多数据源 + 凭据边界。定位是**替代 dbhub MCP 那一层**：连接与凭据留在宿主侧，模型只看到源句柄与数据。

## 相比 dbhub MCP 的差异

| | dbhub MCP | 本插件 |
| --- | --- | --- |
| 运行形态 | 宿主 spawn 一个子进程，stdio 通信 | 进程内 host 插件，无子进程 |
| 启动依赖 | 首次可能要 `npx` 联网解析包；代理挂了会反复重连直到工具被注销 | 纯本地依赖，无网络解析 |
| 凭据位置 | 明文写在 `dbhub.toml` 的 DSN 里 | `passwordEnv` 环境变量优先；模型永远看不到密码 |
| 工具数量 | 每个源 × 每个 tool 一组 | 恒定 6 个，源再多也不膨胀上下文 |
| 只读护栏 | 靠 `[[tools]] readonly` 关键字过滤 | 语句白名单 + 单语句判定 + 写通道双闸门 |

## 注册工具

| 工具 | 功能 |
| --- | --- |
| `mssql_sources` | 列出已配置的源（id / 主机 / 端口 / 库 / 账号 / 是否只读），可 `probe: true` 实测连通性 |
| `mssql_databases` | 列出该实例上的数据库 |
| `mssql_tables` | 列出表与视图（schema / 类型 / 行数估算），支持 `schema` / `filter` 过滤 |
| `mssql_schema` | 单表列结构：类型（带长度精度）/ 可空 / 自增 / 主键 / 默认值 |
| `mssql_query` | **只读**查询，单条语句，`@p0` 绑定参数，返回 `{ columns, rows, truncated, rowCount }` |
| `mssql_execute` | **写**通道，需源开启 `writable` **且**显式 `allowWrite: true` |

> 省 token 工作流：`mssql_sources` → `mssql_tables filter:` → `mssql_schema` → `mssql_query`。先看结构再取数，避免 `SELECT *` 全表灌进上下文。

## 安全模型

- **只读白名单**：只读通道仅放行以 `SELECT` / `WITH` / `VALUES` 开头的语句；
- **危险词拦截**：`SELECT ... INTO`、`EXEC`、`OPENROWSET`、`DBCC`、`WAITFOR`、DDL/DML 关键字直接拒绝（判定前先剥离字符串、注释与 `[]`/`""` 标识符，不会误伤字面量里的关键字）；
- **单语句**：只读通道出现分号分隔的多语句即拒绝；
- **写通道双闸门**：源必须 `writable: true`，调用方还要显式 `allowWrite: true`；DDL 另需源开启 `allowDdl`；`xp_*` / `OPENROWSET` / `BACKUP` / `GRANT` 等提权关键字一律拒绝；
- **参数绑定**：`mssql_query` / `mssql_execute` 用 `@p0, @p1 …` 占位 + `params` 数组绑定，不做字符串拼接；
- **输出预算**：默认 100 行、硬上限 500 行，超限明确标注 `truncated`；
- **凭据边界**：`mssql_sources` 只输出「是否已配密码」，不含密码、不含 `passwordEnv` 的取值、不含完整连接串。

## 安装

装完**重启 DSH** 生效（`sources.json` 的改动不用重启）。

### Web profile（CLI 可直接管理）

```bash
# 本地目录（开发调试；link: 不跑 prepack，先 npm run build 出 lib/）
dsh plugin --profile web add "link:F:\\EdenOS\\AI\\dsh-tool-mssql"

# npm（发布后）
dsh plugin --profile web add dsh-tool-mssql

# GitHub 源码（会执行 prepack 构建）——本仓库在 fork SouleyMoni1/dsh-tool-sqlite
dsh plugin --profile web add "github:SouleyMoni1/dsh-tool-sqlite"
```

### 桌面端（desktop profile，由 Electron 应用独占管理）

`dsh plugin --profile desktop ...` 会被 CLI 直接拒绝：
`profile "desktop" is managed exclusively by the Electron application`。
桌面端要么走市场面板装 npm 上的包，要么手工做一遍 CLI 的等价操作：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加
   `"dsh-tool-mssql": "link:F:\\EdenOS\\AI\\dsh-tool-mssql"`；
2. 同一文件的 `dsh.profile.bundles` 数组加 `"dsh-tool-mssql"`；
3. 在 profile 目录里用应用自带的 pnpm（`nodeLinker: hoisted`）安装，然后重启 DSH。

- 两种 profile 插件不互通，各自装各自的。
- 安装前把 `@deepseek-ai/dsh-tools` 的 peer 范围与你的 DSH 版本对一下（见 `package.json`）。

## 配置

源清单两种配法，**`config.sources` 非空时优先**：

### 方式一：插件 config（profile 的 cordis.patch.yml）

```yaml
- insert:
    - id: tool-mssql
      name: 'dsh-tool-mssql'
      config:
        defaultSource: prod_WMS
        sources:
          - id: prod_WMS
            description: 【正式·只读】172.16.10.99/DAYA_WMS
            server: 172.16.10.99
            port: 1433
            database: DAYA_WMS
            user: dyscm
            passwordEnv: MSSQL_PROD_PW
            writable: false
          - id: dev
            description: 【开发】192.168.1.98/DAYA_DEV
            server: 192.168.1.98
            database: DAYA_DEV
            user: dyscm
            passwordEnv: MSSQL_DEV_PW
            writable: true
```

### 方式二：独立 JSON 文件（推荐，改完即时生效）

`$DSH_HOME/mssql-tool/sources.json`（默认 `C:\\Users\\<你>\\.dsh\\mssql-tool\\sources.json`）：

```json
[
  {
    "id": "prod_WMS",
    "description": "【正式·只读】172.16.10.99/DAYA_WMS",
    "server": "172.16.10.99",
    "port": 1433,
    "database": "DAYA_WMS",
    "user": "dyscm",
    "passwordEnv": "MSSQL_PROD_PW",
    "writable": false
  }
]
```

文件按 mtime 热加载：**改完不用重启**，下一次工具调用即生效。插件启动时若 `sources.json` 不存在也不报错，只是没有可用源。

### 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 源句柄，模型用它在各工具里选库；清单内不可重复 |
| `server` | ✅ | 主机名或 IP |
| `port` | | 默认 `1433` |
| `database` | | 默认库；不填则由账号默认库决定 |
| `user` | | 登录名 |
| `passwordEnv` | | **推荐**：环境变量名，密码从 `process.env` 取 |
| `password` | | 备选：明文写在配置里（仍只在宿主侧，但会落盘） |
| `writable` | | 默认 `false`。只有 `true` 才允许 `mssql_execute` |
| `allowDdl` | | 默认 `false`。允许 `CREATE/ALTER/DROP/TRUNCATE` |
| `allowBatch` | | 默认 `false`。写通道允许分号分隔的批量语句 |
| `encrypt` | | 默认 `false`（局域网）。公网/云 SQL Server 请置 `true` |
| `trustServerCertificate` | | 默认 `true`。`encrypt: true` 且用自签证书时保留 `true` |
| `requestTimeoutMs` | | 单语句超时，默认 `15000` |

密码用环境变量时要让 DSH 进程能读到（桌面端可在启动前设置系统环境变量，或改用 `password`）。

## 从 dbhub 迁移

1. 把 `~/.dsh/mcp-servers/dbhub.toml` 里每个 `[[sources]]` 转成一条 `sources.json`：`dsn` 里的 `user:password@host:port/database` 拆成 `user` / `passwordEnv`（或 `password`）/ `server` / `port` / `database`；
2. 正式库保留 `writable: false`，开发/测试库按原来的策略设 `writable: true`；
3. **删掉** `~/.dsh/profiles/{desktop,web}/cordis.patch.yml` 里的 `mcp-dbhub` 条目（否则两套工具并存）；
4. 重启 DSH，用 `mssql_sources probe: true` 验证连通。

工具名对照：`execute_sql` → `mssql_query`（读）/ `mssql_execute`（写）；`search_objects` → `mssql_tables` + `mssql_schema`。

## 使用示例

```
mssql_sources probe: true
mssql_tables source: "prod_WMS" filter: "Order"
mssql_schema source: "prod_WMS" table: "dbo.Sys_Log"
mssql_query source: "prod_WMS" sql: "SELECT TOP 10 Url, CreateTime FROM Sys_Log WHERE CreateTime >= @p0 ORDER BY CreateTime DESC" params: ["2026-01-01"]
```

## 真机验证（2026-10-06）

| 项 | 实测值 |
| --- | --- |
| DSH 桌面端 | 0.2.0-rc.1（Electron，profile: desktop） |
| Web profile / dsh CLI | @deepseek-ai/dsh 0.1.7-rc.2、@deepseek-ai/cordis 4.0.4 |
| 插件驱动 | mssql 12.7.4（@types/mssql 12.3.0） |
| 生产库 172.16.10.99 | Microsoft SQL Server 2012 (SP1) 11.0.3128.0 |
| 开发库 192.168.1.98 | Microsoft SQL Server 2012 11.0.2100.60 |
| 测试库 172.16.10.57 | Microsoft SQL Server 2019 (RTM) 15.0.2000.5 |

peerDependencies 按上表对齐：`@deepseek-ai/dsh-tools: ^0.1.0-rc.7 || ^0.2.0-rc.1`
（覆盖 0.1.7-rc.2 的 Web CLI 与 0.2.0-rc.1 的桌面端）；`@deepseek-ai/cordis: ^4.0.1` 覆盖 4.0.4。

只读验证（在生产库 `prod_WMS` / `DAYA_WMS` 上完成，期间**没有任何写操作**）：

- `mssql_sources`：12 个源；输出键为 id/description/server/port/database/user/hasPassword/writable/allowDdl，无 `password` 字段、无密码值；
- `mssql_sources probe: true`：12/12 `reachable: true`，版本如上表；
- `mssql_databases`：列出 31 个库；
- `mssql_tables filter: "Log"`：14 张表/视图（含 `Sys_Interface_log_2026W38`～`W41` 及行数估算）；
- `mssql_schema dbo.Sys_Log`：16 列完整结构（类型/长度/可空/IDENTITY/默认值）；
- `mssql_query`：`@p0` 绑定参数正确回传；单条 SELECT 返回 `{ columns, rows, truncated, rowCount }`。

守卫链验证（写通道只用「被拒绝」验证，未对任何库执行写）：

| 用例 | 结果 |
| --- | --- |
| 只读源 + `mssql_query` 传 `INSERT` | 拒绝：只读通道仅放行 SELECT / WITH / VALUES |
| 只读源 + `mssql_execute(allowWrite: true)` | 拒绝：源是只读的（writable 未开启） |
| writable 源 + `mssql_execute` 传 `SELECT` | 拒绝：写通道只接受 INSERT / UPDATE / DELETE / MERGE |
| writable 源 + DDL 但源未开 `allowDdl` | 拒绝：当前源未开启 allowDdl |
| `mssql_execute` 缺 `allowWrite` | `ToolArgsError: missing required property "allowWrite"`（dsh-tools 参数校验层直接拦下） |
| 分号分隔的多语句 | 拒绝：只读通道只接受单条语句 |
| 字面量里的分号（`SELECT ';'`） | 放行（先剥离字符串/注释再判定，不误伤） |
| 未知 source | `未知数据源 nope；可用: …` |

## 已知限制

- **写通道默认单条语句**：需要批量脚本时给源开 `allowBatch: true`；
- 元数据查询依赖 `sys.*` 视图，账号若无 `VIEW DEFINITION` 会返回空列表；
- 连接池按源缓存，改配置里的主机/账号后需重启 DSH 才换池（`sources.json` 变更只影响源清单，不影响已建立的池）；
- `encrypt: false` 时流量不加密，跨公网请用 `encrypt: true`。

## 开发

```sh
npm install
npm run check   # typecheck + vitest + tsc 构建
```

- `src/mssql-core.ts` —— 纯函数：SQL 白名单/禁词、标识符与类型格式化、源清单校验、凭据解析（全部可单测）；
- `src/pool.ts` —— 连接池、查询/写执行、系统目录元数据查询；
- `src/index.ts` —— 插件入口，注册 6 个工具。

## 许可

MIT（继承上游 dsh-tool-sqlite 的 MIT 许可）。
