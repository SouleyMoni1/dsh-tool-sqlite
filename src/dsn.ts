/**
 * 连接字符串 ⇄ 源配置的互转（纯函数，可单测）。
 *
 * 支持两种写法：
 *   sqlserver://user:pass@host:1433/db          （推荐；mssql:// / tds:// 亦可）
 *   Server=host,1433;Database=db;User Id=u;Password=p;   （ADO / ODBC 风格）
 *
 * 密码里的特殊字符请用百分号编码：p@ss → p%40ss。
 * 展示时密码换成 PASSWORD_SENTINEL、环境变量引用换成 ${ENV} 占位；原样回传即表示「密码不变」。
 */

import { DEFAULT_PORT, type SourceConfig } from './mssql-core.js'

/** 掩码哨兵：设置页回传该值时保留原密码。 */
export const PASSWORD_SENTINEL = '******'

/** ${ENV_NAME} 形式的密码引用。 */
const ENV_SECRET = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

export interface ParsedDsn {
  server: string
  port: number
  database?: string
  user?: string
  /** 明文密码、PASSWORD_SENTINEL 或 ${ENV_NAME}。 */
  password?: string
}

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function checkPort(raw: string | undefined, dsn: string): number {
  if (!str(raw)) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('mssql: 连接字符串里的端口非法: ' + dsn)
  }
  return port
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error('mssql: 连接字符串里的百分号编码非法')
  }
}

/** Server=host,1433;Database=db;User Id=u;Password=p 形式。 */
function parseAdoDsn(raw: string): ParsedDsn {
  const parts = new Map<string, string>()
  for (const segment of raw.split(';')) {
    const at = segment.indexOf('=')
    if (at <= 0) continue
    const key = segment.slice(0, at).trim().toLowerCase().replace(/[\s_]/g, '')
    const value = segment.slice(at + 1).trim()
    if (value) parts.set(key, value)
  }
  const address = str(parts.get('server') ?? parts.get('datasource') ?? parts.get('address'))
  if (!address) throw new Error('mssql: 连接字符串缺少 Server= 主机: ' + raw)
  const comma = address.lastIndexOf(',')
  const host = comma > 0 ? address.slice(0, comma).trim() : address
  const port = comma > 0 ? address.slice(comma + 1) : (parts.get('port') ?? undefined)
  if (!host) throw new Error('mssql: 连接字符串缺少主机名: ' + raw)
  return {
    server: host,
    port: checkPort(port, raw),
    database: str(parts.get('database') ?? parts.get('initialcatalog')),
    user: str(parts.get('userid') ?? parts.get('uid') ?? parts.get('user')),
    password: str(parts.get('password') ?? parts.get('pwd')),
  }
}

/** 解析连接字符串。 */
export function parseDsn(dsn: string): ParsedDsn {
  const raw = String(dsn ?? '').trim()
  if (!raw) throw new Error('mssql: 连接字符串不能为空')
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) return parseAdoDsn(raw)

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('mssql: 连接字符串无法解析: ' + raw)
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  if (!['sqlserver', 'mssql', 'tds'].includes(scheme)) {
    throw new Error('mssql: 不支持的协议 ' + scheme + '://；请用 sqlserver://')
  }
  if (!url.hostname) throw new Error('mssql: 连接字符串缺少主机名: ' + raw)
  const encodedPassword = url.password
  return {
    server: url.hostname,
    port: checkPort(url.port, raw),
    database: str(decode(url.pathname.replace(/^\//, ''))),
    user: str(url.username ? decode(url.username) : undefined),
    password: encodedPassword ? decode(encodedPassword) : undefined,
  }
}

/** 源配置组装成连接字符串：mask 时只回显占位，明文密码不下发浏览器。 */
export function formatDsn(source: SourceConfig, opts: { mask?: boolean } = {}): string {
  const port = source.port ?? DEFAULT_PORT
  const envOpen = '$' + '{'
  // ${ENV} 占位不做百分号编码，否则回传时解析不回环境变量名。
  let secret: string | undefined
  if (source.passwordEnv) {
    secret = envOpen + source.passwordEnv + '}'
  } else if (source.password !== undefined) {
    secret = opts.mask ? PASSWORD_SENTINEL : encodeURIComponent(source.password)
  }
  const user = source.user ? encodeURIComponent(source.user) : ''
  const auth = user ? user + (secret === undefined ? '' : ':' + secret) + '@' : ''
  const database = source.database ? '/' + encodeURIComponent(source.database) : ''
  return 'sqlserver://' + auth + source.server + ':' + String(port) + database
}

/** ${ENV} 密码引用 → 变量名；不是引用则返回 undefined。 */
export function envNameOf(password: string | undefined): string | undefined {
  return password === undefined ? undefined : ENV_SECRET.exec(password)?.[1]
}
