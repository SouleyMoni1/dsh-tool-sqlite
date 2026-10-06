/**
 * SQL Server 连接池与执行层。
 *
 * - 连接按「源 id + 主机 + 端口 + 库 + 账号」缓存复用，插件卸载时统一关闭；
 * - 密码每次取池时解析（passwordEnv → process.env），只存在于宿主进程内；
 * - 元数据查询全部走参数绑定，不做字符串拼接。
 */

import sql from 'mssql'
import {
  parseTableRef,
  serializeRows,
  toMssqlConfig,
  type SerializedRows,
  type SourceConfig,
} from './mssql-core.js'

const pools = new Map<string, Promise<sql.ConnectionPool>>()

function poolKey(source: SourceConfig): string {
  return [
    source.id,
    source.server,
    String(source.port ?? 1433),
    source.database ?? '',
    source.user ?? '',
  ].join('|')
}

export function getPool(source: SourceConfig, password?: string): Promise<sql.ConnectionPool> {
  const key = poolKey(source)
  const cached = pools.get(key)
  if (cached) return cached
  const created = new sql.ConnectionPool(toMssqlConfig(source, password)).connect()
  pools.set(key, created)
  created.catch(() => pools.delete(key))
  return created
}

export async function closeAllPools(): Promise<void> {
  const all = [...pools.values()]
  pools.clear()
  await Promise.allSettled(all.map(async (p) => (await p).close()))
}

function bind(request: sql.Request, params?: unknown[]): void {
  if (!Array.isArray(params)) return
  params.forEach((value, index) => request.input(`p${index}`, value as never))
}

function columnsOf(result: sql.IResult<unknown>): string[] {
  const recordset = result.recordset as
    | (Record<string, unknown>[] & { columns?: Record<string, unknown> })
    | undefined
  return recordset?.columns ? Object.keys(recordset.columns) : []
}

/** 只读查询：调用方负责先过 assertReadonlySql。 */
export async function runQuery(
  source: SourceConfig,
  password: string | undefined,
  text: string,
  params: unknown[] | undefined,
  limit: number,
): Promise<SerializedRows> {
  const pool = await getPool(source, password)
  const request = pool.request()
  bind(request, params)
  const result = await request.query(text)
  const rows = (result.recordset ?? []) as Record<string, unknown>[]
  return serializeRows(rows, columnsOf(result), limit)
}

export interface ExecuteResult {
  rowsAffected: number[]
  resultSets: number
}

/** 写执行：调用方负责先过 assertWriteSql 与双闸门。 */
export async function runExecute(
  source: SourceConfig,
  password: string | undefined,
  text: string,
  params: unknown[] | undefined,
): Promise<ExecuteResult> {
  const pool = await getPool(source, password)
  const request = pool.request()
  bind(request, params)
  const result = await request.query(text)
  const rowsAffected = Array.isArray(result.rowsAffected) ? result.rowsAffected : []
  return {
    rowsAffected,
    resultSets: Array.isArray(result.recordsets) ? result.recordsets.length : 0,
  }
}

export interface ProbeResult {
  version: string
  database: string
}

export async function probe(
  source: SourceConfig,
  password: string | undefined,
): Promise<ProbeResult> {
  const pool = await getPool(source, password)
  const result = await pool.request().query<{ v: string; d: string }>(
    'SELECT @@VERSION AS v, DB_NAME() AS d',
  )
  const row = result.recordset[0]
  return {
    version: String(row?.v ?? '').split('\n')[0] ?? '',
    database: String(row?.d ?? ''),
  }
}

export async function listDatabases(
  source: SourceConfig,
  password: string | undefined,
): Promise<string[]> {
  const pool = await getPool(source, password)
  const result = await pool.request().query<{ name: string }>(
    "SELECT name FROM sys.databases WHERE state = 0 ORDER BY database_id",
  )
  return (result.recordset ?? []).map((r) => String(r.name))
}

export interface TableRow {
  schema: string
  name: string
  kind: string
  rows: number | null
}

export async function listTables(
  source: SourceConfig,
  password: string | undefined,
  opts: { schema?: string; filter?: string; limit: number },
): Promise<TableRow[]> {
  const pool = await getPool(source, password)
  const request = pool.request()
  const where: string[] = ["o.type IN ('U','V')"]
  if (opts.schema) {
    where.push('s.name = @schema')
    request.input('schema', opts.schema)
  }
  if (opts.filter) {
    where.push("o.name LIKE '%' + @filter + '%'")
    request.input('filter', opts.filter)
  }
  const text =
    'SELECT s.name AS [schema], o.name AS [name], o.type_desc AS [kind], p.[rows] AS [rows]\n' +
    'FROM sys.objects AS o\n' +
    'JOIN sys.schemas AS s ON s.schema_id = o.schema_id\n' +
    'LEFT JOIN (SELECT object_id, SUM([rows]) AS [rows] FROM sys.partitions\n' +
    '           WHERE index_id IN (0, 1) GROUP BY object_id) AS p ON p.object_id = o.object_id\n' +
    `WHERE ${where.join(' AND ')}\n` +
    'ORDER BY s.name, o.name'
  const result = await request.query<{
    schema: string
    name: string
    kind: string
    rows: number | null
  }>(text)
  return (result.recordset ?? []).slice(0, opts.limit).map((r) => ({
    schema: String(r.schema),
    name: String(r.name),
    kind: String(r.kind),
    rows: r.rows === null || r.rows === undefined ? null : Number(r.rows),
  }))
}

export interface ColumnRow {
  column: string
  type: string
  max_length: number | null
  precision: number | null
  scale: number | null
  nullable: boolean
  identity: boolean
  primaryKey: boolean
  default: string | null
}

export async function tableColumns(
  source: SourceConfig,
  password: string | undefined,
  ref: string,
): Promise<ColumnRow[]> {
  const pool = await getPool(source, password)
  const { schema, name } = parseTableRef(ref)
  const request = pool.request()
  request.input('table', `${schema}.${name}`)
  const text =
    'SELECT c.name AS [column], t.name AS [type], c.max_length, c.[precision], c.scale,\n' +
    '       c.is_nullable, c.is_identity, dc.definition AS [default],\n' +
    '       CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS is_pk\n' +
    'FROM sys.columns AS c\n' +
    'JOIN sys.types AS t ON t.user_type_id = c.user_type_id\n' +
    'LEFT JOIN sys.default_constraints AS dc\n' +
    '       ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id\n' +
    'LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.indexes AS i\n' +
    '           JOIN sys.index_columns AS ic\n' +
    '             ON ic.object_id = i.object_id AND ic.index_id = i.index_id\n' +
    '           WHERE i.is_primary_key = 1) AS pk\n' +
    '       ON pk.object_id = c.object_id AND pk.column_id = c.column_id\n' +
    'WHERE c.object_id = OBJECT_ID(@table)\n' +
    'ORDER BY c.column_id'
  const result = await request.query<{
    column: string
    type: string
    max_length: number | null
    precision: number | null
    scale: number | null
    is_nullable: boolean
    is_identity: boolean
    default: string | null
    is_pk: number
  }>(text)
  return (result.recordset ?? []).map((r) => ({
    column: String(r.column),
    type: r.type,
    max_length: r.max_length ?? null,
    precision: r.precision ?? null,
    scale: r.scale ?? null,
    nullable: r.is_nullable === true,
    identity: r.is_identity === true,
    primaryKey: Number(r.is_pk) === 1,
    default: r.default ?? null,
  }))
}

export { parseTableRef }
