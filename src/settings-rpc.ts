/**
 * 设置页（浏览器侧标签页）到宿主的 RPC。
 *
 * 浏览器侧用 fetch 打 POST /api/dsh-tool-mssql，信封 { channel, endpoint, payload }；
 * 通道在宿主侧由 connection.fetch 承载（headless 等没有 connection 的部署自动跳过，
 * 工具照常可用，只是没有设置页）。
 *
 * 端点：
 *   sources/list    列出源（密码只回显占位）
 *   sources/save    新增/修改一个源（写 sources.json）
 *   sources/remove  删除一个源
 *   sources/test    试连一个源（已保存的 id，或表单里还没保存的 DSN）
 */

import type { Context } from '@deepseek-ai/cordis'
import { PASSWORD_SENTINEL, envNameOf, formatDsn, parseDsn } from './dsn.js'
import { DEFAULT_PORT, type SourceConfig } from './mssql-core.js'
import { readSourcesFile, removeSource, upsertSource, writeSourcesFile } from './settings-store.js'

/**
 * 浏览器侧要打的路由与通道名（两边必须一致）。
 * 路由必须落在 /api 下 —— connection 的 assertFetchRoute 只接受 /api/<endpoint>。
 */
export const RPC_PATH = '/api/dsh-tool-mssql'
const CHANNEL = RPC_PATH

interface FetchRouteSpec {
  path: string
  methods: string[]
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}

interface ConnectionLike {
  fetch: { register: (spec: FetchRouteSpec) => () => void }
}

export interface SettingsRpcDeps {
  /** sources.json 路径。 */
  filePath: () => string
  /** 源是不是来自插件 config.sources（true 时设置页改动不生效，页面要提示）。 */
  configDriven: () => boolean
  /** 当前生效的源列表。 */
  list: () => SourceConfig[]
  /** 清掉宿主侧缓存，让下一次读重新解析文件。 */
  invalidate: () => void
  /** 试连。 */
  probe: (source: SourceConfig) => Promise<{ version: string; database?: string }>
}

interface SourceInput {
  id?: unknown
  description?: unknown
  dsn?: unknown
  writable?: unknown
  allowDdl?: unknown
}

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { message: string } }

const ok = (value: unknown): RpcResult => ({ ok: true, value })
const fail = (error: unknown): RpcResult => ({
  ok: false,
  error: { message: error instanceof Error ? error.message : String(error) },
})

function text(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : undefined
}

/** 源 → 设置页视图：密码换成占位，明文永不下发。 */
function viewOf(source: SourceConfig): Record<string, unknown> {
  return {
    id: source.id,
    description: source.description ?? '',
    dsn: formatDsn(source, { mask: true }),
    server: source.server,
    port: source.port ?? DEFAULT_PORT,
    database: source.database ?? '',
    user: source.user ?? '',
    writable: source.writable === true,
    allowDdl: source.allowDdl === true,
    hasPassword: Boolean(source.passwordEnv || source.password),
    passwordEnv: source.passwordEnv ?? '',
  }
}

/** 密码三态：占位=沿用原值，\${ENV}=改用环境变量，其余=明文；DSN 不带密码即清空。 */
function secretOf(
  password: string | undefined,
  existing: SourceConfig | undefined,
): Pick<SourceConfig, 'password' | 'passwordEnv'> {
  if (password === undefined) return {}
  if (password === PASSWORD_SENTINEL) {
    return existing ? { password: existing.password, passwordEnv: existing.passwordEnv } : {}
  }
  const env = envNameOf(password)
  if (env) return { passwordEnv: env }
  return { password }
}

/** 表单输入 → 源配置。 */
function buildSource(input: SourceInput, existing: SourceConfig | undefined): SourceConfig {
  const id = text(input.id)
  if (!id) throw new Error('mssql: 别名（id）不能为空')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error('mssql: 别名只能用字母/数字/下划线/点/连字符，且以字母或数字开头')
  }
  const dsn = text(input.dsn)
  if (!dsn) throw new Error('mssql: 连接字符串不能为空')
  const parsed = parseDsn(dsn)
  return {
    id,
    description: text(input.description),
    server: parsed.server,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    ...secretOf(parsed.password, existing),
    writable: input.writable === true,
    allowDdl: input.allowDdl === true,
    allowBatch: existing?.allowBatch === true,
    encrypt: existing?.encrypt === true,
    trustServerCertificate: existing?.trustServerCertificate,
    requestTimeoutMs: existing?.requestTimeoutMs,
  }
}

async function dispatch(deps: SettingsRpcDeps, endpoint: string, payload: unknown): Promise<RpcResult> {
  const file = deps.filePath()
  const body = (payload ?? {}) as Record<string, unknown>
  switch (endpoint) {
    case 'sources/list':
      return ok({
        file,
        configDriven: deps.configDriven(),
        sources: deps.list().map(viewOf),
      })

    case 'sources/save': {
      if (deps.configDriven()) {
        throw new Error('mssql: 当前源来自插件 config.sources，改这里不生效；请先清空 config.sources')
      }
      const current = readSourcesFile(file)
      const originalId = text(body.originalId)
      const existing = current.find((item) => item.id === (originalId ?? '')) ?? current.find((item) => item.id === text((body.source as SourceInput | undefined)?.id))
      const source = buildSource((body.source ?? {}) as SourceInput, existing)
      const next = upsertSource(current, source, originalId)
      writeSourcesFile(file, next)
      deps.invalidate()
      return ok({ file, sources: next.map(viewOf) })
    }

    case 'sources/remove': {
      if (deps.configDriven()) {
        throw new Error('mssql: 当前源来自插件 config.sources，改这里不生效；请先清空 config.sources')
      }
      const id = text(body.id)
      if (!id) throw new Error('mssql: 缺少要删除的源 id')
      const next = removeSource(readSourcesFile(file), id)
      writeSourcesFile(file, next)
      deps.invalidate()
      return ok({ file, sources: next.map(viewOf) })
    }

    case 'sources/test': {
      const input = body.source as SourceInput | undefined
      let target: SourceConfig
      if (input && text(input.dsn)) {
        const originalId = text(body.originalId)
        const existing =
          deps.list().find((item) => item.id === (originalId ?? '')) ??
          deps.list().find((item) => item.id === text(input.id))
        target = buildSource(input, existing)
      } else {
        const id = text(body.id)
        const found = deps.list().find((item) => item.id === id)
        if (!found) throw new Error('mssql: 源不存在: ' + String(id ?? ''))
        target = found
      }
      const info = await deps.probe(target)
      return ok({ version: info.version, database: info.database ?? '' })
    }

    default:
      throw new Error('mssql: 未知的 RPC 端点 ' + endpoint)
  }
}

async function handleRequest(deps: SettingsRpcDeps, request: Request): Promise<Response> {
  const json = (result: RpcResult): Response =>
    new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  let envelope: { channel?: unknown; endpoint?: unknown; payload?: unknown }
  try {
    envelope = (await request.json()) as typeof envelope
  } catch {
    return json(fail('mssql: 请求体不是合法 JSON'))
  }
  if (envelope.channel !== CHANNEL) {
    return json(fail('mssql: 未知 RPC 通道 ' + String(envelope.channel ?? '')))
  }
  try {
    return json(await dispatch(deps, String(envelope.endpoint ?? ''), envelope.payload))
  } catch (error) {
    return json(fail(error))
  }
}

/** 挂上设置页用的 RPC 路由；部署里没有 connection 服务时静默跳过。 */
export function applySettingsRpc(ctx: Context, deps: SettingsRpcDeps): void {
  ctx.inject(['connection'], (rpcCtx: Context) => {
    const connection = (rpcCtx as unknown as { connection: ConnectionLike }).connection
    rpcCtx.effect(
      () =>
        connection.fetch.register({
          path: RPC_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request: Request) => handleRequest(deps, request),
        }),
      'dsh-tool-mssql: settings rpc route',
    )
  })
}
