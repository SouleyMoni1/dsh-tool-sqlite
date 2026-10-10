# dsh-tool-mssql 使用与排错

## 1. 源清单放哪儿

| 位置 | 生效时机 | 适用 |
| --- | --- | --- |
| `cordis.patch.yml` 的 `config.sources` | 重启 DSH | 源很少、想跟 profile 一起版本化 |
| `$DSH_HOME/mssql-tool/sources.json` | 改文件即时生效（按 mtime 热加载） | 日常推荐；密码可只放环境变量名 |

两者都在时以 `config.sources` 为准（非空即接管）。

## 1.5 图形化维护（设置页）

设置 → 左侧 **SQL Server 数据源**：列清单、新增、编辑、删除、逐条「测试连接」，写的就是上面那个 `sources.json`。

- 连接字符串两种写法：`sqlserver://user:password@host:1433/database`、`Server=host,1433;Database=db;User Id=u;Password=p`；
- 密码里的 `@ : / ? #` 要百分号编码（`p@ss` → `p%40ss`）；
- 编辑表单里是明文连接串（列表里仍是 `******`），改完保存即生效；填 `${MSSQL_PW}` 这种形式则把密码放到环境变量；
- 列表可按别名 / 描述排序（再点一次切升/降序，「文件顺序」还原）；「编辑」就在那一行就地展开，新增卡片在工具条下方；
- 页面顶部出现「数据源来自 config.sources」提示，说明 profile 的 `cordis.patch.yml` 里有非空 `config.sources`，本页改动不生效；
- 标签页要**重启 DSH** 后才出现（客户端半区随宿主启动组装）；没有 Web 服务的部署（headless）没有这个页面。

## 2. 最小可用配置

```json
[
  {
    "id": "prod_WMS",
    "server": "172.16.10.99",
    "port": 1433,
    "database": "DAYA_WMS",
    "user": "dyscm",
    "passwordEnv": "MSSQL_PROD_PW"
  }
]
```

先 `mssql_sources` 确认清单被读到，再 `mssql_sources probe: true` 确认能连上：

```json
[
  {
    "id": "prod_WMS",
    "server": "172.16.10.99",
    "port": 1433,
    "database": "DAYA_WMS",
    "user": "dyscm",
    "hasPassword": true,
    "writable": false,
    "allowDdl": false,
    "reachable": true,
    "version": "Microsoft SQL Server 2016 ...",
    "currentDatabase": "DAYA_WMS"
  }
]
```

## 3. 只读 vs 可写

- 只读（默认）：`mssql_query` 只放行 `SELECT` / `WITH` / `VALUES` 单条语句；
- 可写：源设 `writable: true`，且每次调用 `mssql_execute` 必须带 `allowWrite: true`；
- 生产库建议 **既不开 `writable`，也用只读数据库账号**（配置里的只读是护栏，不是数据库权限）。

## 4. 参数绑定

```
mssql_query
  sql:    "SELECT * FROM Sys_Log WHERE Url = @p0 AND CreateTime >= @p1"
  params: ["/api/order", "2026-01-01"]
```

- 按顺序对应 `@p0`、`@p1`…；
- 不要把值拼进 SQL 文本——白名单不拦注入，绑定才拦。

## 5. 中文与编码

- 驱动返回的字符串已是 UTF-8；`nvarchar` 列无需额外处理；
- 若返回中出现乱码，先确认列类型是 `varchar` 且库排序规则为中文排序规则（`Chinese_PRC_*`），`varchar` 存中文本身就会丢字，改用 `nvarchar`。

## 6. 常见报错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `未配置任何数据源` | 两处配置都没读到 | 检查 `sources.json` 路径与 JSON 合法性；`config.sources` 不能是空数组以外的类型 |
| `引用的环境变量 X 未设置或为空` | DSH 进程没有该环境变量 | 设系统环境变量后重启 DSH，或改用 `password` |
| `Login failed for user` | 账号/密码错，或只允许 SQL 登录 | 用 `mssql_sources probe: true` 复现；确认账号未被禁用 |
| `self signed certificate` / TLS 握手失败 | 服务端强制加密或证书自签 | `encrypt: true` + `trustServerCertificate: true` |
| `Failed to connect ... ECONNREFUSED` | 端口/防火墙/TCP 协议未启用 | 确认 `1433` 可达，SQL Server 配置管理器里 TCP/IP 已启用 |
| `mssql_schema` 返回空 | 账号无 `VIEW DEFINITION` 权限 | 授予该库的 `VIEW DEFINITION`，或改用有权限的账号 |
| `Timeout: Request failed to complete` | 查询超过 `requestTimeoutMs` | 加大该源的 `requestTimeoutMs`，或优化 SQL |
| `只读通道仅放行 ...` | 语句不是 SELECT 白名单 | 读用 `mssql_query`，写用 `mssql_execute` |
| `当前源未开启 allowDdl` | 源没开 DDL | 源配置加 `"allowDdl": true`（仅限非生产库） |
| 设置里看不到「SQL Server 数据源」 | 客户端半区随 DSH 启动组装 | 重启 DSH；确认包内有 `client/client.js` 且 `package.json` 声明了 `exports["./client"]` 与 `dsh.client` |
| `connection: exact Fetch route "/api/dsh-tool-mssql" is already registered` | 路由被重复注册（插件被装了两份） | 检查 profile 里是否同时存在两份 dsh-tool-mssql |
| 页面提示「数据源来自 config.sources」 | profile 的 `cordis.patch.yml` 里有非空 `config.sources` | 清空该数组（`sources: []`）后重启，再用设置页维护 |
| `别名只能用字母/数字/下划线/点/连字符` | id 里有空格或中文 | 换成 ASCII 别名 |
| `不支持的协议 postgres://` | DSN 协议头不是 SQL Server | 用 `sqlserver://` / `mssql://` / `tds://`，或 ADO 风格 |

## 7. 卸载与回滚

```sh
# Web profile（CLI 可直接管理）
dsh plugin --profile web remove dsh-tool-mssql
```

桌面端 profile 由 Electron 应用独占管理，`dsh plugin --profile desktop ...` 会被 CLI 拒绝。
手工卸载：从 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与
`dsh.profile.bundles` 里删掉 `dsh-tool-mssql`，在 profile 目录里重跑一次 pnpm install，
再重启 DSH。

回滚到 dbhub：把之前备份的 `mcp-dbhub` 条目贴回 `cordis.patch.yml` 并重启即可；两边互不修改对方的数据。
