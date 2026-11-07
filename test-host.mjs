/**
 * 宿主层自检：在临时目录里跑一遍 日精进 的数据层、路由与 Agent 工具。
 *
 * 运行：node test-host.mjs
 *
 * 重要：修改任何工具的 parameters/output.schema 之后先跑本文件（含 schema 体检段），
 * 宿主的校验器只接受标准 JSON Schema 子集。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.join(os.tmpdir(), 'dr-host-test-' + Date.now())
const tools = new Map()
const routes = new Map()

const fakeWebServer = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

const ctx = {
  webServer: fakeWebServer,
  effect(factory) {
    const disposer = factory()
    return disposer || (() => {})
  },
  inject(_deps, callback) {
    callback(ctx)
  },
  get(name) {
    return name === 'webServer' ? fakeWebServer : undefined
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  logger: { warn: message => console.log('[warn]', message) },
}

const plugin = await import('./index.js')
console.log('module name:', plugin.name, '| inject:', JSON.stringify(plugin.inject), '| Config:', plugin.Config === undefined ? 'undefined' : typeof plugin.Config)
plugin.apply(ctx, { rootDir: root, backupDays: 10, trashDays: 7 })
console.log('tools:', [...tools.keys()].join(', '))
console.log('routes:', [...routes.keys()].join(', '))

// ---------------------------------------------------------------
// schema 体检：宿主会把 parameters 原样送进 tools[].function.parameters。
// 只要有一个工具的 schema 不合它的子集约束，注册出来的工具每轮请求都会把
// 整个会话带崩（此前两次就是这样）。这里用与宿主一致的规则自查。
// ---------------------------------------------------------------
const KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const TYPE_ONLY_KEYS = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
}

function checkNode(node, path, problems) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    problems.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (KEYWORDS.has(key) || ANNOTATIONS.has(key)) continue
    problems.push(`${path}.${key} is not a supported keyword`)
  }
  if (!('type' in node)) {
    problems.push(`${path} 缺 type`)
    return
  }
  if (!TYPES.includes(node.type)) {
    problems.push(`${path}.type 非法：${String(node.type)}`)
    return
  }
  for (const [key, allowed] of Object.entries(TYPE_ONLY_KEYS)) {
    if (key in node && !allowed.includes(node.type)) problems.push(`${path}.${key} is not supported on type "${node.type}"`)
  }
  if ('properties' in node) {
    for (const [name, child] of Object.entries(node.properties)) {
      // 方言陷阱：required 写在属性里会被宿主判非法，必须移到根节点
      if ('required' in child) problems.push(`${path}.properties.${name} 残留了方言字段 required`)
      checkNode(child, `${path}.properties.${name}`, problems)
    }
  }
  if ('required' in node) {
    if (!Array.isArray(node.required)) problems.push(`${path}.required 必须是数组`)
    else for (const key of node.required) {
      if (!(key in (node.properties ?? {}))) problems.push(`${path}.required 指向不存在的属性 ${key}`)
    }
  }
  if ('items' in node) checkNode(node.items, `${path}.items`, problems)
}

console.log('\n== schema 体检 ==')
let schemaProblems = 0
let outputProblems = 0

/**
 * 输出契约校验：工具 execute 的返回值必须严格落在 output.schema 里。
 * 宿主会对返回值做一遍校验（additionalProperties:false 时多一个字段就报错），
 * 所以这里对每次调用都验一遍，避免「工具能调但结果被拒」。
 */
function validateOutput(schema, value, path, problems) {
  if (schema === undefined || schema === null) return
  const type = schema.type
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push(`${path} 应为对象`)
      return
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${path}.${key} 缺失`)
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key]
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) problems.push(`${path}.${key} 不在 schema 里`)
        continue
      }
      validateOutput(childSchema, child, `${path}.${key}`, problems)
    }
    return
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      problems.push(`${path} 应为数组`)
      return
    }
    value.forEach((item, index) => validateOutput(schema.items, item, `${path}[${index}]`, problems))
    return
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) problems.push(`${path} 应为整数，实际 ${typeof value}`)
    return
  }
  if (type === 'number') {
    if (typeof value !== 'number') problems.push(`${path} 应为数字`)
    return
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') problems.push(`${path} 应为布尔`)
    return
  }
  if (type === 'string') {
    if (typeof value !== 'string') problems.push(`${path} 应为字符串`)
  }
}

function checkOutput(definition, value) {
  const problems = []
  validateOutput(definition.output?.schema, value, definition.name, problems)
  if (problems.length > 0) {
    console.log(`BAD 输出契约 ${definition.name}`)
    for (const problem of problems) console.log('   -', problem)
  }
  return problems.length
}

for (const [toolName, definition] of tools) {
  const problems = []
  for (const [field, schema] of [['parameters', definition.parameters], ['output.schema', definition.output?.schema]]) {
    if (!schema) {
      problems.push(`${field} 缺失`)
      continue
    }
    if (schema.type !== 'object') problems.push(`${field}.type 必须是 object，实际是 ${String(schema.type)}`)
    checkNode(schema, `${toolName}.${field}`, problems)
  }
  if (problems.length > 0) {
    schemaProblems += problems.length
    console.log(`BAD ${toolName}`)
    for (const p of problems) console.log('   -', p)
  } else {
    console.log(`OK  ${toolName}`)
  }
}
console.log(schemaProblems === 0 ? 'schema 全部通过' : `发现 ${schemaProblems} 处问题`)

await new Promise(resolve => setTimeout(resolve, 300))

const foldersTool = tools.get('daily_review_folders')
const listTool = tools.get('daily_review_list')
const readTool = tools.get('daily_review_read')
const searchTool = tools.get('daily_review_search')
const writeTool = tools.get('daily_review_write')

const ex = async (tool, args) => {
  const value = await tool.execute(args || {}, { signal: new AbortController().signal })
  outputProblems += checkOutput(tool, value)
  return value
}

console.log('\n== folders ==')
const folders = await ex(foldersTool)
console.log(JSON.stringify(folders, null, 1).slice(0, 400))
console.log('dirs:', (await fs.readdir(root)).join(' | '))

console.log('\n== write (append -> creates) ==')
const body1 = '## 今日学习与总结\n\n学了插件契约。\n\n## 今日感恩和收获\n\n感谢同事的支持。\n'
const w1 = await ex(writeTool, { folder: '学习', date: '2026-10-25', body: body1 })
console.log('w1:', JSON.stringify(w1))

console.log('\n== write (append again, same day) ==')
const w2 = await ex(writeTool, { folder: '学习', date: '2026-10-25', body: '\n追加一段复盘。\n' })
console.log('w2:', JSON.stringify(w2))

console.log('\n== write (create, same day) ==')
const w3 = await ex(writeTool, { folder: '学习', date: '2026-10-25', title: '阶段汇报', mode: 'create', body: '## 今日学习与总结\n\n第二篇。\n' })
console.log('w3:', JSON.stringify(w3))
console.log('files:', (await fs.readdir(path.join(root, '学习'))).join(' | '))

console.log('\n== list ==')
const listed = await ex(listTool, { folder: '学习' })
console.log('total:', listed.total, '| entries:', listed.entries.map(e => e.id + ' / ' + e.date + ' / ' + (e.title || '-') + ' / ' + e.words).join('\n  '))

console.log('\n== read (by folder+date) ==')
const readOne = await ex(readTool, { folder: '学习', date: '2026-10-25' })
console.log('found:', readOne.found, '| id:', readOne.id, '| words:', readOne.words)

console.log('\n== read (by id) ==')
const readById = await ex(readTool, { id: w3.id })
console.log('found:', readById.found, '| title:', readById.title, '| sections:', readById.sections.join('/'))

console.log('\n== search ==')
const searched = await ex(searchTool, { query: '契约' })
console.log('hits:', searched.total, '|', searched.hits.map(h => h.id).join(', '))

console.log('\n== overwrite guard ==')
try {
  await ex(writeTool, { folder: '学习', date: '2026-10-25', body: 'x', mode: 'overwrite', id: w3.id })
  console.log('UNEXPECTED: overwrite without confirm succeeded')
} catch (error) {
  console.log('refused as expected:', error.code)
}

console.log('\n== file content ==')
const fileName = (await fs.readdir(path.join(root, '学习'))).find(name => name.includes('阶段汇报'))
const raw = await fs.readFile(path.join(root, '学习', fileName), 'utf8')
console.log(raw)

console.log('\n== route: overview ==')
const apiRoute = routes.get('/api/dsh-daily-review')
async function callRoute(method, url) {
  const res = {
    writableEnded: false,
    writeHead(status) { this.status = status },
    end(payload) { this.writableEnded = true; this.payload = payload },
  }
  await apiRoute.handler({ method, url, socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () {} }, res)
  return { status: res.status, body: res.payload ? JSON.parse(res.payload) : null }
}
const overview = await callRoute('GET', '/api/dsh-daily-review/overview')
console.log('overview status:', overview.status, '| folders:', overview.body.folders.map(f => f.name + ':' + f.count).join(', '), '| stats:', JSON.stringify(overview.body.stats))

console.log('\n== route: entries + calendar + stats ==')
const entriesRes = await callRoute('GET', '/api/dsh-daily-review/entries?folder=' + encodeURIComponent('学习'))
console.log('entries:', entriesRes.body.entries.length)
const cal = await callRoute('GET', '/api/dsh-daily-review/calendar?month=2026-10')
console.log('calendar:', JSON.stringify(cal.body.days))
const stats = await callRoute('GET', '/api/dsh-daily-review/stats')
console.log('stats:', JSON.stringify(stats.body))

console.log('\n== route: forbidden from non-loopback ==')
const res403 = { writableEnded: false, writeHead(s) { this.status = s }, end(p) { this.payload = p } }
await apiRoute.handler({ method: 'GET', url: '/api/dsh-daily-review/overview', socket: { remoteAddress: '10.0.0.8' }, [Symbol.asyncIterator]: async function* () {} }, res403)
console.log('non-loopback status:', res403.status)

console.log('\n== route: unknown action ==')
const unknown = await callRoute('GET', '/api/dsh-daily-review/nope')
console.log('unknown status:', unknown.status)

console.log('\n== folder template change keeps old entries ==')
const updateRes = { writableEnded: false, writeHead(s) { this.status = s }, end(p) { this.payload = p } }
const updateBody = JSON.stringify({ id: overview.body.folders[0].id, sections: [{ id: 's1', name: '新板块' }] })
const updateReq = {
  method: 'POST',
  url: '/api/dsh-daily-review/folders/update',
  socket: { remoteAddress: '127.0.0.1' },
  async *[Symbol.asyncIterator]() { yield Buffer.from(updateBody) },
}
await apiRoute.handler(updateReq, updateRes)
console.log('update status:', updateRes.status)
const afterUpdate = await callRoute('GET', '/api/dsh-daily-review/entries?folder=' + encodeURIComponent('学习'))
console.log('old entries sections still:', afterUpdate.body.entries.map(e => e.sections.join('+')).join(' || '))

console.log('\n== backups + trash ==')
console.log('backups:', (await fs.readdir(path.join(root, '.daily-review', 'backups'))).join(' | '))
const delRes = { writableEnded: false, writeHead(s) { this.status = s }, end(p) { this.payload = p } }
const delReq = {
  method: 'POST',
  url: '/api/dsh-daily-review/entry/delete',
  socket: { remoteAddress: '127.0.0.1' },
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ id: w3.id })) },
}
await apiRoute.handler(delReq, delRes)
console.log('delete status:', delRes.status)
console.log('trash:', (await fs.readdir(path.join(root, '.daily-review', 'trash'))).join(' | '))

console.log('\n== rebuild after deleting .daily-review ==')
await fs.rm(path.join(root, '.daily-review'), { recursive: true, force: true })
const foldersAfter = await ex(foldersTool)
console.log('folders after rebuild:', foldersAfter.folders.map(f => f.name + ':' + f.count).join(', '))
console.log('entries after rebuild:', (await ex(listTool, {})).total)

console.log('\nroot:', root)
console.log(schemaProblems === 0 ? 'schema 全部通过' : `schema 发现 ${schemaProblems} 处问题`)
console.log(outputProblems === 0 ? '输出契约全部通过' : `输出契约发现 ${outputProblems} 处问题`)
if (schemaProblems > 0 || outputProblems > 0) process.exitCode = 1
