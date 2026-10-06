/**
 * dsh-tool-mssql 插件入口。
 *
 * 注册 6 个 mssql_* 工具，让模型直接读（可选写）SQL Server：
 *   mssql_sources / mssql_databases / mssql_tables / mssql_schema / mssql_query / mssql_execute
 *
 * 数据源配置（config.sources 优先，否则读文件——改文件即时生效，按 mtime 热加载）：
 *   1. 插件 config.sources：cordis.patch.yml 里的数组；
 *   2. $DSH_HOME/mssql-tool/sources.json。
 *
 * 凭据边界：密码只经 passwordEnv（推荐）或宿主侧文件进入进程，任何工具返回值都不含密码。
 */

import { readFileSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  assertReadonlySql,
  assertWriteSql,
  clampLimit,
  defaultSourcesPath,
  describeSource,
  formatColumnType,
  parseSources,
  resolvePassword,
  type SourceConfig,
} from './mssql-core.js'
import {
  closeAllPools,
  listDatabases,
  listTables,
  probe,
  runExecute,
  runQuery,
  tableColumns,
} from './pool.js'

export const name = 'dsh-tool-mssql'
export const inject = ['tools']

export interface Config {
  /** 直接在该字段写源数组；非空时忽略配置文件。 */
  sources?: SourceConfig[]
  /** 源清单配置文件路径，默认 $DSH_HOME/mssql-tool/sources.json。 */
  configFile?: string
  /** 工具未显式传 source 时使用的默认源 id；缺省取清单第一条。 */
  defaultSource?: string
}

const TOOL_TIMEOUT_MS = 30_000

export function apply(ctx: Context, config: Config = {}): void {
  const filePath = config.configFile ?? defaultSourcesPath()
  let fromFile: { mtimeMs: number; sources: SourceConfig[] } | null = null
  let fromConfig: SourceConfig[] | null = null

  const listSources = (): SourceConfig[] => {
    const inline = config.sources
    if (Array.isArray(inline) && inline.length > 0) {
      fromConfig ??= parseSources(inline)
      return fromConfig
    }
    let mtimeMs = 0
    try {
      mtimeMs = statSync(filePath).mtimeMs
    } catch {
      return []
    }
    if (fromFile && fromFile.mtimeMs === mtimeMs) return fromFile.sources
    const parsed = parseSources(JSON.parse(readFileSync(filePath, 'utf8')))
    fromFile = { mtimeMs, sources: parsed }
    return parsed
  }

  const pick = (id?: string): SourceConfig => {
    const all = listSources()
    if (all.length === 0) {
      throw new Error(
        `未配置任何数据源：请在 ${filePath} 写 JSON 数组，或配置插件 config.sources`,
      )
    }
    const wanted = id ?? config.defaultSource ?? (all[0] as SourceConfig).id
    const found = all.find((s) => s.id === wanted)
    if (!found) {
      throw new Error(`未知数据源 ${wanted}；可用: ${all.map((s) => s.id).join(', ')}`)
    }
    return found
  }

  const fail = (error: unknown): string =>
    `mssql 错误: ${error instanceof Error ? error.message : String(error)}`

  ctx.tools.register(
    defineTool({
      name: 'mssql_sources',
      description:
        'List configured SQL Server data sources (id / host / port / database / user / readonly). ' +
        'Never returns passwords. Call this first to learn the "source" id used by other mssql_* tools. ' +
        'Pass probe: true to also test connectivity and print the server version.',
      parameters: {
        probe: {
          type: 'boolean',
          description: 'Test each source with a real connection (SELECT @@VERSION). Default false.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        try {
          const all = listSources()
          if (all.length === 0) {
            return `mssql: 未配置数据源。请在 ${filePath} 写 JSON 数组，或配置插件 config.sources`
          }
          if (args.probe !== true) return JSON.stringify(all.map(describeSource), null, 2)
          const probed = []
          for (const source of all) {
            const view = describeSource(source)
            try {
              const info = await probe(source, resolvePassword(source))
              probed.push({
                ...view,
                reachable: true,
                version: info.version,
                currentDatabase: info.database,
              })
            } catch (error) {
              probed.push({
                ...view,
                reachable: false,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
          return JSON.stringify(probed, null, 2)
        } catch (error) {
          return fail(error)
        }
      },
      timeoutMs: 60_000,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'mssql_databases',
      description:
        'List databases on one SQL Server source (read-only, uses sys.databases). ' +
        'Omit source to use the default one.',
      parameters: {
        source: { type: 'string', description: 'Source id from mssql_sources; optional.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        try {
          const source = pick(args.source)
          const names = await listDatabases(source, resolvePassword(source))
          return JSON.stringify({ source: source.id, databases: names })
        } catch (error) {
          return fail(error)
        }
      },
      timeoutMs: TOOL_TIMEOUT_MS,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'mssql_tables',
      description:
        'List tables and views of one source with schema, object kind and row count estimate ' +
        '(read-only). Filter by schema or name substring before writing SQL — much cheaper than SELECT *.',
      parameters: {
        source: { type: 'string', description: 'Source id from mssql_sources; optional.' },
        schema: { type: 'string', description: 'Restrict to one schema, e.g. dbo.' },
        filter: { type: 'string', description: 'Case-insensitive substring match on the table name.' },
        limit: { type: 'integer', description: 'Max rows to return (default 100, hard cap 500).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        try {
          const source = pick(args.source)
          const rows = await listTables(source, resolvePassword(source), {
            schema: args.schema,
            filter: args.filter,
            limit: clampLimit(args.limit),
          })
          return JSON.stringify({ source: source.id, count: rows.length, tables: rows }, null, 2)
        } catch (error) {
          return fail(error)
        }
      },
      timeoutMs: TOOL_TIMEOUT_MS,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'mssql_schema',
      description:
        'Show column definitions of one table (read-only): name, type with length/precision, ' +
        'nullable, identity, primary key and default expression. ' +
        'Accepts "table" or "schema.table".',
      parameters: {
        source: { type: 'string', description: 'Source id from mssql_sources; optional.' },
        table: { type: 'string', required: true, description: 'Table name, e.g. users or dbo.users.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        try {
          const source = pick(args.source)
          const columns = await tableColumns(source, resolvePassword(source), args.table)
          if (columns.length === 0) {
            return `mssql: 表 ${args.table} 不存在或当前账号无元数据权限`
          }
          const lines = columns.map((c) =>
            [
              c.column,
              formatColumnType(c),
              c.nullable ? 'NULL' : 'NOT NULL',
              c.identity ? 'IDENTITY' : '',
              c.primaryKey ? 'PK' : '',
              c.default ? `DEFAULT ${c.default}` : '',
            ]
              .filter(Boolean)
              .join(' '),
          )
          return JSON.stringify({ source: source.id, table: args.table, columns: lines }, null, 2)
        } catch (error) {
          return fail(error)
        }
      },
      timeoutMs: TOOL_TIMEOUT_MS,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'mssql_query',
      description:
        'Run ONE read-only statement against a source (SELECT / WITH / VALUES). Writes are rejected. ' +
        'Use @p0, @p1 placeholders and pass params: [v0, v1] — never interpolate values into SQL. ' +
        'Results come back as { columns, rows, truncated, rowCount }.',
      parameters: {
        source: { type: 'string', description: 'Source id from mssql_sources; optional.' },
        sql: {
          type: 'string',
          required: true,
          description: 'Single read-only T-SQL statement with @p0-style placeholders.',
        },
        params: {
          type: 'array',
          items: { type: 'json' },
          description: 'Bound values for @p0, @p1 … in order.',
        },
        limit: { type: 'integer', description: 'Max rows to return (default 100, hard cap 500).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        try {
          const source = pick(args.source)
          assertReadonlySql(args.sql)
          const result = await runQuery(
            source,
            resolvePassword(source),
            args.sql,
            Array.isArray(args.params) ? args.params : undefined,
            clampLimit(args.limit),
          )
          return JSON.stringify({ source: source.id, ...result }, null, 2)
        } catch (error) {
          return fail(error)
        }
      },
      timeoutMs: TOOL_TIMEOUT_MS,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'mssql_execute',
      description:
        'Run ONE write statement (INSERT / UPDATE / DELETE / MERGE) against a writable source. ' +
        'Requires the source to be configured writable AND an explicit allowWrite: true. ' +
        'DDL needs allowDdl on the source. Read data with mssql_query instead.',
      parameters: {
        source: { type: 'string', description: 'Source id from mssql_sources; optional.' },
        sql: { type: 'string', required: true, description: 'Single write statement.' },
        allowWrite: {
          type: 'boolean',
          required: true,
          description: 'Must be true — the explicit confirmation gate for any write.',
        },
        params: {
          type: 'array',
          items: { type: 'json' },
          description: 'Bound values for @p0, @p1 … in order.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        try {
          const source = pick(args.source)
          if (source.writable !== true) {
            return `mssql: 源 ${source.id} 是只读的（writable 未开启），拒绝写操作`
          }
          if (args.allowWrite !== true) {
            return `mssql: 写操作需要显式 allowWrite: true（源 ${source.id}）`
          }
          assertWriteSql(args.sql, {
            allowDdl: source.allowDdl === true,
            allowBatch: source.allowBatch === true,
          })
          const result = await runExecute(
            source,
            resolvePassword(source),
            args.sql,
            Array.isArray(args.params) ? args.params : undefined,
          )
          return JSON.stringify({ source: source.id, ...result }, null, 2)
        } catch (error) {
          return fail(error)
        }
      },
      timeoutMs: TOOL_TIMEOUT_MS,
    }),
  )

  // 插件卸载/重载时关闭连接池；disposer 由 cordis 在 fiber 卸载时调用。
  ctx.effect(() => () => {
    void closeAllPools()
  })
}
