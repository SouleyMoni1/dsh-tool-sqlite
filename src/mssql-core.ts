/**
 * dsh-tool-mssql 核心逻辑（纯函数、可单测）。
 *
 * 安全边界：
 * - 只读白名单：只读通道仅放行 SELECT / WITH / VALUES 开头的单条语句；
 * - 危险词拦截：SELECT ... INTO / EXEC / OPENROWSET / 各类 DDL 一律拒绝；
 * - 单语句判定：先剥离字符串、注释与带引号标识符，再判断是否存在分号分隔的多语句；
 * - 写通道双闸门：源必须 writable: true，调用方还要显式传 allowWrite: true；
 * - 输出预算：默认 100 行、硬上限 500 行；
 * - 凭据边界：describeSource 只输出主机/端口/库名/账号与「是否已配密码」，永不返回密码。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const MAX_ROWS = 500
export const DEFAULT_ROWS = 100
export const DEFAULT_PORT = 1433
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

export interface SourceConfig {
  id: string
  description?: string
  server: string
  port?: number
  database?: string
  user?: string
  password?: string
  passwordEnv?: string
  /** 默认 false（只读）。只有显式 writable: true 才开放写通道。 */
  writable?: boolean
  /** 允许 DDL（CREATE / ALTER / DROP / TRUNCATE）。默认 false。 */
  allowDdl?: boolean
  /** 写通道允许分号分隔的批量语句。默认 false。 */
  allowBatch?: boolean
  /** TLS 加密。局域网 SQL Server 默认 false，公网/云库请置 true。 */
  encrypt?: boolean
  trustServerCertificate?: boolean
  requestTimeoutMs?: number
}

/** 传给 mssql 驱动的最小配置（不含任何插件自有字段）。 */
export interface MssqlPoolOptions {
  server: string
  port: number
  database?: string
  user?: string
  password?: string
  options: {
    encrypt: boolean
    trustServerCertificate: boolean
    enableArithAbort: boolean
  }
  pool: { min: number; max: number; idleTimeoutMillis: number }
  connectionTimeout: number
  requestTimeout: number
}

/** 面向模型的源描述：不含密码，也不含完整 DSN。 */
export interface SourceView {
  id: string
  description?: string
  server: string
  port: number
  database?: string
  user?: string
  hasPassword: boolean
  writable: boolean
  allowDdl: boolean
}

const READONLY_PREFIXES = ['SELECT', 'WITH', 'VALUES']
const WRITE_PREFIXES = ['INSERT', 'UPDATE', 'DELETE', 'MERGE']
const DDL_PREFIXES = ['CREATE', 'ALTER', 'DROP', 'TRUNCATE']

/** 只读通道的禁词：SELECT INTO、动态执行、跨源读取、DDL/DML 与实例级操作。 */
const READONLY_DENY =
  /\b(INTO|EXEC|EXECUTE|DBCC|WAITFOR|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|SHUTDOWN|RECONFIGURE|KILL|BACKUP|RESTORE|GRANT|REVOKE|DENY|USE|SET|CREATE|ALTER|DROP|TRUNCATE|MERGE|INSERT|UPDATE|DELETE)\b/i

/** 写通道也一律拒绝的提权/外联关键字。 */
const WRITE_DENY =
  /\b(xp_[a-z_]+|sp_configure|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|SHUTDOWN|RECONFIGURE|KILL|BACKUP|RESTORE|GRANT|REVOKE)\b/i

/** 剥离字符串字面量、注释与带引号标识符，只留下可判定的 SQL 骨架。 */
export function stripLiterals(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i] as string
    if (ch === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      out += ' '
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
    } else if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
    } else if (ch === '"' || ch === '[') {
      const close = ch === '"' ? '"' : ']'
      i++
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      out += ' '
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** 单条语句判定：结尾分号允许，中间出现分号即视为多语句。 */
export function isSingleStatement(sql: string): boolean {
  return !stripLiterals(sql).replace(/;+\s*$/, '').includes(';')
}

function firstKeyword(body: string): string {
  const m = /^\s*([A-Za-z_][A-Za-z_0-9]*)/.exec(body)
  return m?.[1]?.toUpperCase() ?? ''
}

/** 只读通道准入：以只读关键字开头 + 单语句 + 未命中禁词。 */
export function isReadonlySql(sql: string): boolean {
  const body = stripLiterals(sql)
  if (!body.trim()) return false
  if (!READONLY_PREFIXES.includes(firstKeyword(body))) return false
  if (!isSingleStatement(sql)) return false
  return !READONLY_DENY.test(body)
}

export function isWriteSql(sql: string): boolean {
  return WRITE_PREFIXES.includes(firstKeyword(stripLiterals(sql)))
}

export function isDdlSql(sql: string): boolean {
  return DDL_PREFIXES.includes(firstKeyword(stripLiterals(sql)))
}

/** 只读通道断言；不通过直接抛错（错误文案给模型自纠）。 */
export function assertReadonlySql(sql: string): void {
  if (!sql || !sql.trim()) throw new Error('mssql: SQL 不能为空')
  if (!isSingleStatement(sql)) {
    throw new Error('mssql: 只读通道只接受单条语句，检测到分号分隔的多语句')
  }
  if (!isReadonlySql(sql)) {
    throw new Error(
      'mssql: 只读通道仅放行 SELECT / WITH / VALUES 单条查询；写操作请用 mssql_execute',
    )
  }
}

/** 写通道断言：源开关 + 语句类别 + 提权禁词。 */
export function assertWriteSql(sql: string, opts: { allowDdl: boolean; allowBatch: boolean }): void {
  const body = stripLiterals(sql)
  if (!body.trim()) throw new Error('mssql: SQL 不能为空')
  if (!opts.allowBatch && !isSingleStatement(sql)) {
    throw new Error('mssql: 写通道默认只允许单条语句；需要批量执行请在源配置打开 allowBatch')
  }
  const head = firstKeyword(body)
  if (DDL_PREFIXES.includes(head)) {
    if (!opts.allowDdl) throw new Error('mssql: 当前源未开启 allowDdl，拒绝执行 DDL')
  } else if (!WRITE_PREFIXES.includes(head)) {
    throw new Error('mssql: 写通道只接受 INSERT / UPDATE / DELETE / MERGE（或已开启 allowDdl 的 DDL）')
  }
  if (WRITE_DENY.test(body)) throw new Error('mssql: 语句命中提权/外联关键字，已拒绝')
}

/** 标识符加方括号，防止注入（仅用于表名/列名包装）。 */
export function quoteIdent(name: string): string {
  return '[' + String(name).replaceAll(']', ']]') + ']'
}

/** "dbo.users" → "[dbo].[users]"；单段按 dbo 处理。 */
export function quoteQualified(ref: string): string {
  const { schema, name } = parseTableRef(ref)
  return quoteIdent(schema) + '.' + quoteIdent(name)
}

/** 解析 "schema.table" / "table" / "[schema].[table]"。 */
export function parseTableRef(ref: string): { schema: string; name: string } {
  const cleaned = String(ref ?? '').trim()
  if (!cleaned) throw new Error('mssql: 表名不能为空')
  const parts = cleaned
    .split('.')
    .map((p) => p.trim().replace(/^\[|\]$/g, '').replaceAll(']]', ']'))
  if (parts.length === 1) return { schema: 'dbo', name: parts[0] as string }
  const name = parts[parts.length - 1] as string
  const schema = parts[parts.length - 2] as string
  if (!name || !schema) throw new Error(`mssql: 表名无法解析: ${ref}`)
  return { schema, name }
}

/** 列类型格式化：带上长度/精度，便于模型直接写 SQL。 */
export function formatColumnType(row: {
  type: string
  max_length?: number | null
  precision?: number | null
  scale?: number | null
}): string {
  const t = String(row.type ?? '').toLowerCase()
  const len = row.max_length ?? null
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) {
    return `${t}(${len === -1 ? 'max' : String(len ?? '')})`
  }
  if (['nvarchar', 'nchar'].includes(t)) {
    return `${t}(${len === -1 ? 'max' : String(len === null ? '' : len / 2)})`
  }
  if (['decimal', 'numeric'].includes(t)) {
    return `${t}(${String(row.precision ?? '')},${String(row.scale ?? '')})`
  }
  return t
}

/** 把驱动返回值收敛成 JSON 可序列化形态。 */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'bigint') return (value as bigint).toString()
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return '0x' + value.toString('hex')
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 行数收敛：默认 100、硬上限 500。 */
export function clampLimit(limit?: number, fallback = DEFAULT_ROWS): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback
  return Math.max(1, Math.min(n, MAX_ROWS))
}

export interface SerializedRows {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
  rowCount: number
}

export function serializeRows(
  rows: Record<string, unknown>[],
  columns: string[],
  cap: number,
): SerializedRows {
  const cols = columns.length > 0 ? columns : Object.keys(rows[0] ?? {})
  return {
    columns: cols,
    rows: rows.slice(0, cap).map((r) => cols.map((c) => normalizeValue(r[c]))),
    truncated: rows.length > cap,
    rowCount: rows.length,
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 校验并归一化源清单；任何非法项都直接抛错（启动即暴露，不静默降级）。 */
export function parseSources(raw: unknown): SourceConfig[] {
  if (!Array.isArray(raw)) throw new Error('mssql: sources 必须是数组')
  const seen = new Set<string>()
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`mssql: sources[${index}] 必须是对象`)
    }
    const s = item as Record<string, unknown>
    const id = str(s.id)
    if (!id) throw new Error(`mssql: sources[${index}].id 不能为空`)
    if (seen.has(id)) throw new Error(`mssql: sources 里 id 重复: ${id}`)
    seen.add(id)
    const server = str(s.server)
    if (!server) throw new Error(`mssql: 源 ${id} 缺少 server`)
    const port = s.port === undefined ? DEFAULT_PORT : Number(s.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`mssql: 源 ${id} 的 port 非法: ${String(s.port)}`)
    }
    return {
      id,
      description: str(s.description),
      server,
      port,
      database: str(s.database),
      user: str(s.user),
      password: str(s.password),
      passwordEnv: str(s.passwordEnv),
      writable: s.writable === true,
      allowDdl: s.allowDdl === true,
      allowBatch: s.allowBatch === true,
      encrypt: s.encrypt === true,
      trustServerCertificate: s.trustServerCertificate !== false,
      requestTimeoutMs:
        typeof s.requestTimeoutMs === 'number' && s.requestTimeoutMs > 0
          ? Math.floor(s.requestTimeoutMs)
          : undefined,
    } satisfies SourceConfig
  })
}

/** 面向模型的源视图：刻意不含 password，也不含 passwordEnv 的取值。 */
export function describeSource(source: SourceConfig): SourceView {
  return {
    id: source.id,
    description: source.description,
    server: source.server,
    port: source.port ?? DEFAULT_PORT,
    database: source.database,
    user: source.user,
    hasPassword: Boolean(source.passwordEnv || source.password),
    writable: source.writable === true,
    allowDdl: source.allowDdl === true,
  }
}

/** 取密码：passwordEnv 优先（推荐），否则用明文 password（仅存于宿主侧）。 */
export function resolvePassword(
  source: SourceConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (source.passwordEnv) {
    const value = env[source.passwordEnv]
    if (!value) {
      throw new Error(`mssql: 源 ${source.id} 引用的环境变量 ${source.passwordEnv} 未设置或为空`)
    }
    return value
  }
  return source.password
}

export function toMssqlConfig(source: SourceConfig, password?: string): MssqlPoolOptions {
  return {
    server: source.server,
    port: source.port ?? DEFAULT_PORT,
    database: source.database,
    user: source.user,
    password,
    options: {
      encrypt: source.encrypt === true,
      trustServerCertificate: source.trustServerCertificate !== false,
      enableArithAbort: true,
    },
    pool: { min: 0, max: 4, idleTimeoutMillis: 30_000 },
    connectionTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeout: source.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  }
}

export function dshHome(env: Record<string, string | undefined> = process.env): string {
  return env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
}

/** 源清单默认落盘位置：$DSH_HOME/mssql-tool/sources.json。 */
export function defaultSourcesPath(env: Record<string, string | undefined> = process.env): string {
  return join(dshHome(env), 'mssql-tool', 'sources.json')
}
