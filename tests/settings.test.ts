/**
 * 连接字符串互转 + 清单文件增删改的单测（不碰网络、不碰真实数据库）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PASSWORD_SENTINEL, envNameOf, formatDsn, parseDsn } from '../src/dsn.js'
import { readSourcesFile, removeSource, upsertSource, writeSourcesFile } from '../src/settings-store.js'
import type { SourceConfig } from '../src/mssql-core.js'

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mssql-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const SAMPLE: SourceConfig = {
  id: 'prod_WMS',
  description: '【正式·只读】',
  server: '172.16.10.99',
  port: 1433,
  database: 'DAYA_WMS',
  user: 'dyscm',
  password: 'p@ss word',
  writable: false,
  allowDdl: false,
}

describe('parseDsn', () => {
  it('解析 sqlserver:// 形式并还原百分号编码', () => {
    expect(parseDsn('sqlserver://dyscm:p%40ss@172.16.10.99:1433/DAYA_WMS')).toEqual({
      server: '172.16.10.99',
      port: 1433,
      database: 'DAYA_WMS',
      user: 'dyscm',
      password: 'p@ss',
    })
  })

  it('省略端口取 1433，省略库名/账号也成立', () => {
    expect(parseDsn('mssql://192.168.1.98/SHSDBarCode')).toEqual({
      server: '192.168.1.98',
      port: 1433,
      database: 'SHSDBarCode',
      user: undefined,
      password: undefined,
    })
  })

  it('支持 ADO 风格 Server=host,port;Database=…;User Id=…;Password=…', () => {
    expect(parseDsn('Server=172.16.10.57,1533;Database=DLBarCode_Test;User Id=dymes;Password=abc')).toEqual({
      server: '172.16.10.57',
      port: 1533,
      database: 'DLBarCode_Test',
      user: 'dymes',
      password: 'abc',
    })
  })

  it('拒绝空串、非法协议、非法端口', () => {
    expect(() => parseDsn('  ')).toThrow(/不能为空/)
    expect(() => parseDsn('postgres://a@b/c')).toThrow(/不支持的协议/)
    expect(() => parseDsn('sqlserver://h:99999/db')).toThrow(/无法解析|端口非法/)
  })
})

describe('formatDsn', () => {
  it('mask 时只回显哨兵，明文密码不外泄', () => {
    const masked = formatDsn(SAMPLE, { mask: true })
    expect(masked).toBe('sqlserver://dyscm:' + PASSWORD_SENTINEL + '@172.16.10.99:1433/DAYA_WMS')
    expect(masked).not.toContain('p@ss')
  })

  it('非 mask 时明文可被 parseDsn 读回（密码含特殊字符也成立）', () => {
    const plain = formatDsn(SAMPLE)
    expect(parseDsn(plain).password).toBe('p@ss word')
  })

  it('passwordEnv 回显为 \${ENV} 占位而不是编码后的乱码', () => {
    const viaEnv: SourceConfig = { id: 'x', server: 'h', user: 'u', passwordEnv: 'MSSQL_PW' }
    const text = formatDsn(viaEnv, { mask: true })
    expect(text).toBe('sqlserver://u:\${MSSQL_PW}@h:1433')
    expect(envNameOf(parseDsn(text).password)).toBe('MSSQL_PW')
  })

  it('没有账号时不输出 @', () => {
    expect(formatDsn({ id: 'x', server: 'h', database: 'd' })).toBe('sqlserver://h:1433/d')
  })
})

describe('settings-store', () => {
  it('文件不存在时视为空清单', () => {
    expect(readSourcesFile(join(scratch(), 'nope.json'))).toEqual([])
  })

  it('写回后可读回，且字段顺序稳定、无 undefined', () => {
    const file = join(scratch(), 'sources.json')
    writeSourcesFile(file, [SAMPLE])
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text).not.toContain('undefined')
    expect(Object.keys(JSON.parse(text)[0])).toEqual([
      'id',
      'description',
      'server',
      'port',
      'database',
      'user',
      'password',
      'writable',
    ])
    const back = readSourcesFile(file)[0] as SourceConfig
    expect(back).toMatchObject(SAMPLE)
    expect(back.port).toBe(1433)
    expect(back.writable).toBe(false)
  })

  it('upsert 追加 / 改名 / 撞 id 报错', () => {
    const list: SourceConfig[] = [{ id: 'a', server: 'h1' }]
    const added = upsertSource(list, { id: 'b', server: 'h2' })
    expect(added.map((item) => item.id)).toEqual(['a', 'b'])
    const renamed = upsertSource(added, { id: 'c', server: 'h2' }, 'b')
    expect(renamed.map((item) => item.id)).toEqual(['a', 'c'])
    // 改名到已被占用的 id：index 找不到 originalId，clash 命中 → 拒绝
    expect(() => upsertSource(renamed, { id: 'a', server: 'h3' }, 'zzz')).toThrow(/已存在/)
    // 不带 originalId 时是「按 id 更新」，允许覆盖自身
    expect(upsertSource(renamed, { id: 'a', server: 'h3' })[0]).toEqual({ id: 'a', server: 'h3' })
  })

  it('remove 删除，删不存在的 id 报错', () => {
    const list: SourceConfig[] = [{ id: 'a', server: 'h1' }, { id: 'b', server: 'h2' }]
    expect(removeSource(list, 'a').map((item) => item.id)).toEqual(['b'])
    expect(() => removeSource(list, 'zzz')).toThrow(/不存在/)
  })

  it('JSON 非法时报可读错误', () => {
    const file = join(scratch(), 'bad.json')
    writeFileSync(file, '{ oops', 'utf8')
    expect(() => readSourcesFile(file)).toThrow(/不是合法 JSON/)
  })
})
