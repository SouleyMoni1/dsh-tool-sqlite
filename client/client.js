/**
 * dsh-tool-mssql 浏览器半区 —— 设置页「SQL Server 数据源」标签页。
 *
 * 形态说明：DSH 客户端插件必须是单文件、且以 window.__ModuleLoader__.load({ id, factory })
 * 注册工厂；运行时只注入 9 个平台 seed（react / react-dom / @deepseek-ai/cordis /
 * @deepseek-ai/dsh-client-ui-* 等），所以这里只 require react 与官方控件库，其余零依赖。
 *
 * 数据流：fetch POST /api/dsh-tool-mssql（connection 的精确 Fetch 路由，自动带同源围栏），
 * 信封 { channel, endpoint, payload }，宿主侧见 src/settings-rpc.ts。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tool-mssql',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const Button = primitives.Button
    const Input = primitives.Input
    const Switch = primitives.Switch

    /** 路由与通道必须与 src/settings-rpc.ts 一致。 */
    const RPC_PATH = '/api/dsh-tool-mssql'
    /** locale 命名空间。 */
    const NS = 'dsh-tool-mssql'
    /** 标签页 id：不要用 official 的 general/models/plugins/account/agent-presets。 */
    const SECTION_ID = 'mssql-sources'

    const zh = {
      nav: 'SQL Server 数据源',
      title: 'SQL Server 数据源',
      intro: 'mssql_* 工具读的就是这份清单。这里的改动直接写回清单文件，即时生效，不用重启。',
      file: '清单文件',
      add: '新增数据源',
      reload: '重新加载',
      loading: '加载中…',
      retry: '重试',
      empty: '还没有数据源，点「新增数据源」开始。',
      configDriven:
        '当前数据源来自插件 config.sources（cordis.patch.yml），本页改动不会生效 —— 先把它清空再用本页维护。',
      readonly: '只读',
      writable: '可写',
      ddlTag: 'DDL',
      test: '测试连接',
      testing: '连接中…',
      edit: '编辑',
      remove: '删除',
      confirmRemove: '确认删除',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      newTitle: '新增数据源',
      editTitle: '编辑数据源',
      idLabel: '别名（id）',
      idHint: '其他工具用 source=<别名> 指定它；字母/数字/下划线/点/连字符。',
      descLabel: '描述',
      descHint: '给人看的一行说明，可留空。',
      dsnLabel: '连接字符串',
      dsnHint:
        'sqlserver://账号:密码@主机:1433/库名。编辑已有源时密码显示为 ******，原样保留即不改密码；也可写 ${环境变量名} 引用密码。',
      writableLabel: '允许写入',
      writableHint: '打开后 mssql_execute 才能对它执行 INSERT/UPDATE/DELETE/MERGE（仍需显式 allowWrite）。',
      ddlLabel: '允许 DDL',
      ddlHint: '额外放行 CREATE/ALTER/DROP/TRUNCATE。',
      saved: '已保存。',
      removed: '已删除。',
      testOK: '连接成功',
    }

    const en = {
      nav: 'SQL Server',
      title: 'SQL Server data sources',
      intro: 'The mssql_* tools read this list. Edits are written straight back to the list file and apply immediately — no restart.',
      file: 'List file',
      add: 'Add source',
      reload: 'Reload',
      loading: 'Loading…',
      retry: 'Retry',
      empty: 'No data source yet — start with “Add source”.',
      configDriven:
        'Sources come from the plugin config.sources (cordis.patch.yml); edits on this page have no effect until that is emptied.',
      readonly: 'read-only',
      writable: 'writable',
      ddlTag: 'DDL',
      test: 'Test',
      testing: 'Connecting…',
      edit: 'Edit',
      remove: 'Delete',
      confirmRemove: 'Confirm',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      newTitle: 'New source',
      editTitle: 'Edit source',
      idLabel: 'Alias (id)',
      idHint: 'Other tools select it with source=<alias>; letters/digits/._- only.',
      descLabel: 'Description',
      descHint: 'One human-readable line; may be empty.',
      dsnLabel: 'Connection string',
      dsnHint:
        'sqlserver://user:password@host:1433/database. An existing password shows as ****** — leave it untouched to keep it, or use ${ENV_VAR}.',
      writableLabel: 'Allow writes',
      writableHint: 'Lets mssql_execute run INSERT/UPDATE/DELETE/MERGE here (allowWrite is still required).',
      ddlLabel: 'Allow DDL',
      ddlHint: 'Additionally allows CREATE/ALTER/DROP/TRUNCATE.',
      saved: 'Saved.',
      removed: 'Deleted.',
      testOK: 'Connected',
    }

    /** 打宿主 RPC；失败一律抛 Error（含宿主给的中文原因）。 */
    async function call(endpoint, payload) {
      const response = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: RPC_PATH, endpoint, payload }),
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const result = await response.json()
      if (!result.ok) throw new Error((result.error && result.error.message) || 'unknown error')
      return result.value
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    let styled = false
    function ensureStyles() {
      if (styled || typeof document === 'undefined') return
      styled = true
      const style = document.createElement('style')
      style.textContent = [
        '.msx-root{display:flex;flex-direction:column;gap:16px;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}',
        '.msx-title{font-size:15px;font-weight:600;margin:0}',
        '.msx-hint{color:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 55%,transparent));font-size:12px;line-height:1.5;margin:4px 0 0}',
        '.msx-path{font-family:var(--dsw-font-markdown-code-block,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 75%,transparent))}',
        '.msx-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.msx-list{display:flex;flex-direction:column;gap:8px}',
        '.msx-row{border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));border-radius:var(--dsw-radius-md,10px);padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
        '.msx-rowhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.msx-id{font-weight:600;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace)}',
        '.msx-desc{color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 75%,transparent))}',
        '.msx-tag{border:1px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 22%,transparent));border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 55%,transparent))}',
        '.msx-tag-write{color:var(--dsw-alias-state-success-primary,#2ea043);border-color:currentColor}',
        '.msx-dsn{font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:12px;word-break:break-all;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 75%,transparent))}',
        '.msx-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
        '.msx-card{border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));border-radius:var(--dsw-radius-md,10px);padding:12px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1,transparent)}',
        '.msx-card-title{font-weight:600}',
        '.msx-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
        '.msx-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
        '.msx-wide{grid-column:1/-1}',
        '.msx-label{font-size:12px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 75%,transparent))}',
        '.msx-note{font-size:12px;line-height:1.5}',
        '.msx-ok{color:var(--dsw-alias-state-success-primary,#2ea043)}',
        '.msx-err{color:var(--dsw-alias-state-error-primary,#d1242f)}',
        '.msx-warn{border:1px solid var(--dsw-alias-state-warn-primary,#d4a72c);border-radius:var(--dsw-radius-sm,8px);padding:8px 10px;font-size:12px}',
        '.msx-inline{display:flex;align-items:center;gap:8px}',
        '.msx-empty{color:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 55%,transparent))}',
      ].join('\n')
      document.head.appendChild(style)
    }

    /** 一个源 → 编辑草稿。 */
    function draftOf(item) {
      return {
        originalId: item ? item.id : '',
        id: item ? item.id : '',
        description: item ? item.description : '',
        dsn: item ? item.dsn : '',
        writable: item ? item.writable : false,
        allowDdl: item ? item.allowDdl : false,
      }
    }

    function Section(props) {
      const t = props.t
      const [phase, setPhase] = React.useState('loading')
      const [error, setError] = React.useState('')
      const [data, setData] = React.useState({ file: '', configDriven: false, sources: [] })
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState(null)
      const [pendingRemove, setPendingRemove] = React.useState('')

      const load = React.useCallback(async () => {
        setPhase('loading')
        setError('')
        try {
          const value = await call('sources/list', {})
          setData(value)
          setPhase('ready')
        } catch (cause) {
          setError(messageOf(cause))
          setPhase('error')
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const applyList = (value) => {
        setData((prev) => ({ ...prev, file: value.file || prev.file, sources: value.sources }))
      }

      const save = async () => {
        setBusy('save')
        setNote(null)
        try {
          const value = await call('sources/save', {
            originalId: draft.originalId,
            source: {
              id: draft.id,
              description: draft.description,
              dsn: draft.dsn,
              writable: draft.writable,
              allowDdl: draft.allowDdl,
            },
          })
          applyList(value)
          setDraft(null)
          setNote({ kind: 'ok', text: t('saved') })
        } catch (cause) {
          setNote({ kind: 'err', text: messageOf(cause) })
        } finally {
          setBusy('')
        }
      }

      const remove = async (id) => {
        setBusy('remove')
        setNote(null)
        try {
          const value = await call('sources/remove', { id })
          applyList(value)
          setPendingRemove('')
          setNote({ kind: 'ok', text: t('removed') })
        } catch (cause) {
          setNote({ kind: 'err', text: messageOf(cause) })
        } finally {
          setBusy('')
        }
      }

      const testRow = async (id) => {
        setBusy('test:' + id)
        setNote(null)
        try {
          const value = await call('sources/test', { id })
          setNote({ kind: 'ok', text: id + ' · ' + t('testOK') + ' · ' + String(value.version).trim() })
        } catch (cause) {
          setNote({ kind: 'err', text: id + ' · ' + messageOf(cause) })
        } finally {
          setBusy('')
        }
      }

      const testDraft = async () => {
        setBusy('test')
        setNote(null)
        try {
          const value = await call('sources/test', {
            originalId: draft.originalId,
            source: {
              id: draft.id,
              description: draft.description,
              dsn: draft.dsn,
              writable: draft.writable,
              allowDdl: draft.allowDdl,
            },
          })
          setNote({ kind: 'ok', text: t('testOK') + ' · ' + String(value.version).trim() })
        } catch (cause) {
          setNote({ kind: 'err', text: messageOf(cause) })
        } finally {
          setBusy('')
        }
      }

      const field = (label, hint, control, wide) =>
        h(
          'label',
          { className: wide ? 'msx-field msx-wide' : 'msx-field' },
          h('span', { className: 'msx-label' }, label),
          control,
          hint ? h('span', { className: 'msx-hint' }, hint) : null,
        )

      const editor = draft
        ? h(
            'div',
            { className: 'msx-card' },
            h('div', { className: 'msx-card-title' }, draft.originalId ? t('editTitle') : t('newTitle')),
            h(
              'div',
              { className: 'msx-grid' },
              field(
                t('idLabel'),
                t('idHint'),
                h(Input, {
                  value: draft.id,
                  disabled: busy !== '',
                  placeholder: 'prod_WMS',
                  onChange: (event) => setDraft((prev) => ({ ...prev, id: event.target.value })),
                }),
              ),
              field(
                t('descLabel'),
                t('descHint'),
                h(Input, {
                  value: draft.description,
                  disabled: busy !== '',
                  onChange: (event) => setDraft((prev) => ({ ...prev, description: event.target.value })),
                }),
              ),
              field(
                t('dsnLabel'),
                t('dsnHint'),
                h(Input, {
                  value: draft.dsn,
                  disabled: busy !== '',
                  placeholder: 'sqlserver://user:password@host:1433/database',
                  onChange: (event) => setDraft((prev) => ({ ...prev, dsn: event.target.value })),
                }),
                true,
              ),
              field(
                t('writableLabel'),
                t('writableHint'),
                h(Switch, {
                  checked: draft.writable,
                  disabled: busy !== '',
                  label: t('writableLabel'),
                  onChange: (next) => setDraft((prev) => ({ ...prev, writable: next })),
                }),
              ),
              field(
                t('ddlLabel'),
                t('ddlHint'),
                h(Switch, {
                  checked: draft.allowDdl,
                  disabled: busy !== '',
                  label: t('ddlLabel'),
                  onChange: (next) => setDraft((prev) => ({ ...prev, allowDdl: next })),
                }),
              ),
            ),
            h(
              'div',
              { className: 'msx-actions' },
              h(
                Button,
                { size: 'sm', variant: 'primary', disabled: busy !== '', onClick: () => void save() },
                busy === 'save' ? t('saving') : t('save'),
              ),
              h(
                Button,
                { size: 'sm', variant: 'outline', disabled: busy !== '', onClick: () => void testDraft() },
                busy === 'test' ? t('testing') : t('test'),
              ),
              h(
                Button,
                { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: () => setDraft(null) },
                t('cancel'),
              ),
            ),
          )
        : null

      const row = (item) =>
        h(
          'div',
          { className: 'msx-row', key: item.id },
          h(
            'div',
            { className: 'msx-rowhead' },
            h('span', { className: 'msx-id' }, item.id),
            item.description ? h('span', { className: 'msx-desc' }, item.description) : null,
            h(
              'span',
              { className: item.writable ? 'msx-tag msx-tag-write' : 'msx-tag' },
              item.writable ? t('writable') : t('readonly'),
            ),
            item.allowDdl ? h('span', { className: 'msx-tag' }, t('ddlTag')) : null,
          ),
          h('div', { className: 'msx-dsn' }, item.dsn),
          h(
            'div',
            { className: 'msx-actions' },
            h(
              Button,
              { size: 'sm', variant: 'outline', disabled: busy !== '', onClick: () => void testRow(item.id) },
              busy === 'test:' + item.id ? t('testing') : t('test'),
            ),
            h(
              Button,
              { size: 'sm', variant: 'outline', disabled: busy !== '', onClick: () => setDraft(draftOf(item)) },
              t('edit'),
            ),
            pendingRemove === item.id
              ? h(
                  React.Fragment,
                  null,
                  h(
                    Button,
                    { size: 'sm', variant: 'primary', disabled: busy !== '', onClick: () => void remove(item.id) },
                    t('confirmRemove'),
                  ),
                  h(
                    Button,
                    { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: () => setPendingRemove('') },
                    t('cancel'),
                  ),
                )
              : h(
                  Button,
                  { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: () => setPendingRemove(item.id) },
                  t('remove'),
                ),
          ),
        )

      const body = () => {
        if (phase === 'loading') return h('div', { className: 'msx-hint' }, t('loading'))
        if (phase === 'error') {
          return h(
            'div',
            null,
            h('div', { className: 'msx-note msx-err' }, error),
            h(
              'div',
              { className: 'msx-actions' },
              h(Button, { size: 'sm', variant: 'outline', onClick: () => void load() }, t('retry')),
            ),
          )
        }
        return h(
          React.Fragment,
          null,
          data.configDriven ? h('div', { className: 'msx-warn' }, t('configDriven')) : null,
          h(
            'div',
            { className: 'msx-bar' },
            h(
              Button,
              { size: 'sm', variant: 'primary', disabled: busy !== '', onClick: () => setDraft(draftOf(null)) },
              t('add'),
            ),
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy !== '', onClick: () => void load() }, t('reload')),
            note ? h('span', { className: note.kind === 'ok' ? 'msx-note msx-ok' : 'msx-note msx-err' }, note.text) : null,
          ),
          editor,
          data.sources.length === 0
            ? h('div', { className: 'msx-empty' }, t('empty'))
            : h('div', { className: 'msx-list' }, data.sources.map(row)),
        )
      }

      return h(
        'div',
        { className: 'msx-root' },
        h(
          'div',
          null,
          h('h2', { className: 'msx-title' }, t('title')),
          h('p', { className: 'msx-hint' }, t('intro')),
          data.file
            ? h(
                'p',
                { className: 'msx-hint' },
                t('file') + '：',
                h('span', { className: 'msx-path' }, data.file),
              )
            : null,
        ),
        body(),
      )
    }

    const inject = ['slots', 'locale']
    const name = 'dsh-tool-mssql-client'

    function apply(ctx) {
      ensureStyles()
      ctx.effect(
        () => ctx.locale.register(NS, { zh: zh, en: en }),
        'dsh-tool-mssql: dictionaries',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: 45,
                label: () => ctx.locale.bind(NS)('nav'),
                locale: NS,
              },
              Section,
            ),
          ),
        'dsh-tool-mssql: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
