/**
 * dsh-daily-review — host half.
 *
 * Owns the on-disk daily-review archive (directories are the source of truth),
 * a loopback-only JSON route family for the Web GUI half, and the five
 * `daily_review_*` agent tools.
 *
 * File format (one entry per .md file):
 *
 *   <root>/<folder>/YYYY-MM-DD.md          first entry of the day
 *   <root>/<folder>/YYYY-MM-DD 2.md        second entry of the day, N increments
 *   <root>/<folder>/YYYY-MM-DD 标题.md      when a title is set
 *   <root>/.daily-review/folders.json      folder metadata, templates and order
 *   <root>/.daily-review/backups/<day>/    pre-write copies, kept 10 days
 *   <root>/.daily-review/trash/<stamp>/    deleted entries, kept 7 days
 *
 * Every write backs up the previous file first, writes a temp file and renames
 * it over the target. Nothing outside the archive root is ever touched.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Hidden metadata directory inside the archive root. */
const META_DIR = '.daily-review'

/**
 * Route prefix claimed on the loopback web server.
 *
 * The web server matches a prefix route when `pathname === prefix` OR
 * `pathname.startsWith(prefix + '/')`, so the registered value must NOT carry
 * a trailing slash — `/api/dsh-daily-review/` would only ever match itself.
 */
const API_BASE = '/api/dsh-daily-review'

/** Request paths hang off API_BASE with one separating slash. */
const API_PREFIX = `${API_BASE}/`

/** Sections a brand-new folder's template starts with. */
const DEFAULT_SECTIONS = ['今日要点', '今日收获', '明日计划', '待办']

/** Folders created on first launch when nothing exists yet. */
const PRESET_FOLDERS = ['学习', '工作', '生活', '总结']

/** Twelve preset colors for folder cards. */
const PALETTE = [
  '#6C8EBF', '#B8865B', '#7FA05B', '#A06B9F', '#C97B63', '#5FA3A6',
  '#8C8C99', '#C2A24A', '#6F8FB8', '#9B7B6B', '#6BA292', '#A8627B',
]

/** Default archive root, under the current user's home directory; overridable through plugin config. */
const DEFAULT_ROOT = path.join(os.homedir(), '日精进')

/** Largest JSON request body accepted on the route family. */
const MAX_BODY_BYTES = 24 * 1024 * 1024

/** Summary cap used by list/search payloads. */
const EXCERPT_LIMIT = 200

/** How much of a file the listing path reads before falling back to a full read. */
const HEAD_BYTES = 64 * 1024

/* ------------------------------------------------------------------ */
/* time helpers                                                        */
/* ------------------------------------------------------------------ */

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Local calendar day as `YYYY-MM-DD`. */
function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Local timestamp with an explicit offset, e.g. `2026-10-25T23:10:00+08:00`. */
function stamp(date = new Date()) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${dateKey(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/** Strict `YYYY-MM-DD` calendar-day check. */
function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(year, month - 1, day)
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
}

/** Stable "today minus N days" string, used for retention windows. */
function daysAgoKey(days) {
  const now = new Date()
  now.setDate(now.getDate() - days)
  return dateKey(now)
}

/* ------------------------------------------------------------------ */
/* naming helpers                                                      */
/* ------------------------------------------------------------------ */

/** Windows-safe file-name fragment for a user supplied title. */
function safeTitle(title) {
  let value = String(title ?? '').trim()
  if (value === '') return ''
  value = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  if (value.length > 60) value = value.slice(0, 60).trim()
  return value
}

/** Parse `YYYY-MM-DD[ 标题][ N].md`; null when the name is not an entry. */
function parseEntryName(fileName) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ ]([^]*))?\.md$/i.exec(fileName)
  if (match === null) return null
  const date = match[1]
  if (!isDateKey(date)) return null
  const rest = (match[2] ?? '').trim()
  let title = ''
  let seq = 0
  if (rest !== '') {
    if (/^\d+$/.test(rest)) {
      seq = Number(rest)
    } else {
      const tail = /^(.*?)\s+(\d+)$/.exec(rest)
      if (tail !== null && tail[1].trim() !== '') {
        title = tail[1].trim()
        seq = Number(tail[2])
      } else {
        title = rest
      }
    }
  }
  return { date, title, seq }
}

/* ------------------------------------------------------------------ */
/* frontmatter                                                         */
/* ------------------------------------------------------------------ */

function unquoteScalar(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function quoteScalar(value) {
  const text = String(value ?? '')
  if (text === '') return ''
  if (/^[A-Za-z0-9\u4e00-\u9fff][^:#\n"']*$/.test(text) && !/^\s|\s$/.test(text)) return text
  return JSON.stringify(text)
}

/** Minimal YAML reader for the six frontmatter keys this plugin writes. */
function parseFrontmatterBlock(head) {
  const out = {}
  let pendingListKey = null
  let pendingEmptyKey = null
  for (const rawLine of head.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const item = /^\s*-\s?(.*)$/.exec(line)
    if (item !== null && pendingEmptyKey !== null) {
      if (!Array.isArray(out[pendingEmptyKey])) out[pendingEmptyKey] = []
      out[pendingEmptyKey].push(unquoteScalar(item[1]))
      continue
    }
    const pair = /^([A-Za-z0-9_-]+):[ ]?(.*)$/.exec(line)
    if (pair === null) continue
    const key = pair[1]
    const rawValue = pair[2].trim()
    pendingEmptyKey = null
    pendingListKey = null
    if (rawValue === '') {
      pendingEmptyKey = key
      out[key] = ''
      continue
    }
    if (rawValue === '[]') {
      out[key] = []
      continue
    }
    out[key] = unquoteScalar(rawValue)
    if (rawValue !== '') pendingListKey = key
  }
  if (pendingListKey !== null && out[pendingListKey] === '') out[pendingListKey] = ''
  return out
}

/** Split a document into its frontmatter map (or null) and body. */
function splitFrontmatter(text) {
  const source = text.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  if (!source.startsWith('---')) return { meta: null, broken: false, body: source }
  const close = source.indexOf('\n---', 3)
  if (close < 0) return { meta: null, broken: true, body: source }
  const head = source.slice(3, close)
  let body = source.slice(close + 4)
  if (body.startsWith('\n')) body = body.slice(1)
  return { meta: parseFrontmatterBlock(head), broken: false, body }
}

function serializeFrontmatter(record) {
  const lines = ['---', `date: ${record.date}`, `title: ${quoteScalar(record.title)}`, `folder: ${quoteScalar(record.folder)}`]
  const sections = Array.isArray(record.sections) ? record.sections : []
  if (sections.length === 0) {
    lines.push('sections: []')
  } else {
    lines.push('sections:')
    for (const section of sections) lines.push(`  - ${quoteScalar(section)}`)
  }
  lines.push(`created: ${record.created}`, `updated: ${record.updated}`, '---', '')
  return lines.join('\n')
}

/** `## ` headings in document order. */
function sectionsFromBody(body) {
  const out = []
  for (const line of body.split('\n')) {
    const match = /^##[ ]+(.+?)[ ]*$/.exec(line)
    if (match !== null && match[1].trim() !== '') out.push(match[1].trim())
  }
  return out
}

/** Plain-text excerpt used by list and search payloads. */
function excerptOf(body, limit = EXCERPT_LIMIT) {
  const text = String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#{1,6}[ ]+.*$/gm, '')
    .replace(/^[ ]*[-+*][ ]+/gm, '')
    .replace(/^[ ]*\d+\.[ ]+/gm, '')
    .replace(/[*_`>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, limit)
}

/** First meaningful line of the body (used as the card subtitle). */
function firstLineOf(body, limit = 80) {
  for (const rawLine of String(body ?? '').split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('---')) continue
    return line.replace(/^[-+*][ ]+/, '').slice(0, limit)
  }
  return ''
}

/** Character count ignoring whitespace. */
function wordCount(body) {
  return String(body ?? '').replace(/\s+/g, '').length
}

/* ------------------------------------------------------------------ */
/* archive                                                             */
/* ------------------------------------------------------------------ */

class Archive {
  constructor(rootDir, options = {}) {
    this.root = path.resolve(rootDir)
    this.backupDays = Number.isFinite(options.backupDays) ? Math.max(1, options.backupDays) : 10
    this.trashDays = Number.isFinite(options.trashDays) ? Math.max(1, options.trashDays) : 7
    this.cache = new Map()
    this.ready = null
  }

  get metaDir() {
    return path.join(this.root, META_DIR)
  }

  get foldersFile() {
    return path.join(this.metaDir, 'folders.json')
  }

  /* ---------------- low-level io ---------------- */

  async _atomicWrite(target, content) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await fs.writeFile(temp, content, 'utf8')
    try {
      await fs.rename(temp, target)
    } catch (error) {
      try {
        await fs.rm(target, { force: true })
        await fs.rename(temp, target)
      } catch {
        await fs.rm(temp, { force: true }).catch(() => {})
        throw error
      }
    }
  }

  async _pathExists(target) {
    try {
      await fs.stat(target)
      return true
    } catch {
      return false
    }
  }

  /** Copy an existing entry into today's backup bucket before it is rewritten. */
  async backupFile(folderName, fileName) {
    const source = path.join(this.root, folderName, fileName)
    if (!(await this._pathExists(source))) return
    const target = path.join(this.metaDir, 'backups', dateKey(), folderName, fileName)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(source, target)
  }

  /** Move an entry into the trash bucket (date-stamped, never a plain unlink). */
  async trashFile(folderName, fileName) {
    const source = path.join(this.root, folderName, fileName)
    if (!(await this._pathExists(source))) return
    const stampFolder = `${dateKey()}-${pad2(new Date().getHours())}${pad2(new Date().getMinutes())}${pad2(new Date().getSeconds())}`
    const target = path.join(this.metaDir, 'trash', stampFolder, folderName, fileName)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(source, target)
    this.cache.delete(`${folderName}/${fileName}`)
  }

  /** Drop backups older than the retention window and trash older than its own. */
  async cleanup() {
    try {
      const backupRoot = path.join(this.metaDir, 'backups')
      const backupFloor = daysAgoKey(this.backupDays)
      for (const name of await this._listDirNames(backupRoot)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < backupFloor) {
          await fs.rm(path.join(backupRoot, name), { recursive: true, force: true })
        }
      }
    } catch {
      /* retention is best-effort */
    }
    try {
      const trashRoot = path.join(this.metaDir, 'trash')
      const trashFloor = daysAgoKey(this.trashDays)
      for (const name of await this._listDirNames(trashRoot)) {
        const day = name.slice(0, 10)
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < trashFloor) {
          await fs.rm(path.join(trashRoot, name), { recursive: true, force: true })
        }
      }
    } catch {
      /* retention is best-effort */
    }
  }

  async _listDirNames(target) {
    try {
      const entries = await fs.readdir(target, { withFileTypes: true })
      return entries.map(entry => entry.name)
    } catch {
      return []
    }
  }

  /* ---------------- folders.json ---------------- */

  async readFoldersDoc() {
    try {
      const raw = await fs.readFile(this.foldersFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.folders)) return null
      const folders = []
      for (const item of parsed.folders) {
        if (item === null || typeof item !== 'object') continue
        if (typeof item.name !== 'string' || item.name.trim() === '') continue
        folders.push(this._normalizeFolder(item, folders.length))
      }
      return { version: 1, folders }
    } catch {
      return null
    }
  }

  async writeFoldersDoc(doc) {
    await this._atomicWrite(this.foldersFile, `${JSON.stringify(doc, null, 2)}\n`)
  }

  _normalizeFolder(item, fallbackOrder) {
    const sections = Array.isArray(item.template?.sections) ? item.template.sections : []
    const normalizedSections = []
    sections.forEach((section, index) => {
      if (section === null || typeof section !== 'object') return
      const name = typeof section.name === 'string' ? section.name.trim() : ''
      if (name === '') return
      const id = typeof section.id === 'string' && section.id.trim() !== '' ? section.id : `s${index + 1}`
      normalizedSections.push({ id, name })
    })
    return {
      id: typeof item.id === 'string' && item.id.trim() !== '' ? item.id : `f_${Math.random().toString(36).slice(2, 10)}`,
      name: item.name.trim(),
      color: typeof item.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(item.color) ? item.color : PALETTE[fallbackOrder % PALETTE.length],
      order: Number.isFinite(item.order) ? item.order : fallbackOrder,
      template: { sections: normalizedSections },
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : stamp(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : stamp(),
      missing: false,
    }
  }

  _newFolder(name, order) {
    return {
      id: `f_${Math.random().toString(36).slice(2, 10)}`,
      name,
      color: PALETTE[Math.max(0, order) % PALETTE.length],
      order,
      template: {
        sections: DEFAULT_SECTIONS.map((sectionName, index) => ({ id: `s${index + 1}`, name: sectionName })),
      },
      createdAt: stamp(),
      updatedAt: stamp(),
      missing: false,
    }
  }

  async _diskFolderNames() {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true })
      return entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  /* ---------------- bootstrap ---------------- */

  async ensure() {
    if (this.ready === null) this.ready = this._ensureOnce().catch(error => {
      this.ready = null
      throw error
    })
    await this.ready
    // The whole .daily-review directory can be deleted by hand (acceptance:
    // the index is only a cache). Rebuild it from the directories on disk.
    if (!(await this._pathExists(this.foldersFile))) {
      this.ready = this._ensureOnce().catch(error => {
        this.ready = null
        throw error
      })
      await this.ready
    }
    return this.ready
  }

  async _ensureOnce() {
    await fs.mkdir(this.root, { recursive: true })
    await fs.mkdir(this.metaDir, { recursive: true })
    const diskNames = await this._diskFolderNames()
    const doc = await this.readFoldersDoc()
    if (doc === null) {
      const names = PRESET_FOLDERS.slice()
      for (const name of diskNames) if (!names.includes(name)) names.push(name)
      const folders = names.map((name, index) => this._newFolder(name, index))
      for (const folder of folders) await fs.mkdir(path.join(this.root, folder.name), { recursive: true })
      await this.writeFoldersDoc({ version: 1, folders })
      return
    }
    let changed = false
    for (const folder of doc.folders) {
      try {
        await fs.mkdir(path.join(this.root, folder.name), { recursive: true })
      } catch {
        /* an unusable name should not break activation */
      }
    }
    const known = new Set(doc.folders.map(folder => folder.name))
    for (const name of diskNames) {
      if (known.has(name)) continue
      doc.folders.push(this._newFolder(name, doc.folders.length))
      changed = true
    }
    if (changed) await this.writeFoldersDoc({ version: 1, folders: doc.folders })
    await this.cleanup()
  }

  /* ---------------- folder operations ---------------- */

  async listFolders() {
    await this.ensure()
    const doc = (await this.readFoldersDoc()) ?? { version: 1, folders: [] }
    const diskNames = new Set(await this._diskFolderNames())
    const folders = doc.folders
      .filter(folder => diskNames.has(folder.name))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    return folders
  }

  async createFolder({ name, color, sections }) {
    await this.ensure()
    const cleanName = String(name ?? '').trim()
    if (cleanName === '') throw new ArchiveError('文件夹名不能为空。', 'invalid-name')
    if (/[\\/:*?"<>|\u0000-\u001f]/.test(cleanName) || cleanName.startsWith('.')) {
      throw new ArchiveError('文件夹名不能包含 \\ / : * ? " < > | 或以点开头。', 'invalid-name')
    }
    const doc = (await this.readFoldersDoc()) ?? { version: 1, folders: [] }
    if (doc.folders.some(folder => folder.name === cleanName)) {
      throw new ArchiveError(`已经有同名文件夹「${cleanName}」了。`, 'duplicate-name')
    }
    if ((await this._diskFolderNames()).includes(cleanName)) {
      throw new ArchiveError(`根目录下已经存在同名目录「${cleanName}」。`, 'duplicate-name')
    }
    const cleanedSections = this._cleanSections(sections)
    const order = doc.folders.reduce((max, folder) => Math.max(max, folder.order), -1) + 1
    const folder = this._newFolder(cleanName, order)
    folder.color = typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : folder.color
    if (cleanedSections.length > 0) folder.template.sections = cleanedSections
    await fs.mkdir(path.join(this.root, cleanName), { recursive: true })
    doc.folders.push(folder)
    await this.writeFoldersDoc({ version: 1, folders: doc.folders })
    return folder
  }

  _cleanSections(sections) {
    if (!Array.isArray(sections)) return []
    const out = []
    sections.forEach((section, index) => {
      const name = typeof section === 'string' ? section : section?.name
      const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
      if (clean === '') return
      const id = typeof section?.id === 'string' && section.id.trim() !== '' ? section.id.trim() : `s${index + 1}`
      out.push({ id, name: clean })
    })
    return out
  }

  async updateFolder({ id, name, color, sections }) {
    await this.ensure()
    const doc = (await this.readFoldersDoc()) ?? { version: 1, folders: [] }
    const folder = doc.folders.find(candidate => candidate.id === id)
    if (folder === undefined) throw new ArchiveError('找不到这个文件夹。', 'folder-not-found')
    if (typeof name === 'string') {
      const cleanName = name.trim()
      if (cleanName === '') throw new ArchiveError('文件夹名不能为空。', 'invalid-name')
      if (/[\\/:*?"<>|\u0000-\u001f]/.test(cleanName) || cleanName.startsWith('.')) {
        throw new ArchiveError('文件夹名不能包含 \\ / : * ? " < > | 或以点开头。', 'invalid-name')
      }
      if (cleanName !== folder.name) {
        if (doc.folders.some(candidate => candidate.id !== id && candidate.name === cleanName)) {
          throw new ArchiveError(`已经有同名文件夹「${cleanName}」了。`, 'duplicate-name')
        }
        const source = path.join(this.root, folder.name)
        const target = path.join(this.root, cleanName)
        if (await this._pathExists(target)) throw new ArchiveError(`根目录下已经存在同名目录「${cleanName}」。`, 'duplicate-name')
        await fs.rename(source, target)
        this.cache.clear()
        folder.name = cleanName
      }
    }
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) folder.color = color
    if (Array.isArray(sections)) folder.template = { sections: this._cleanSections(sections) }
    folder.updatedAt = stamp()
    await this.writeFoldersDoc({ version: 1, folders: doc.folders })
    return folder
  }

  async reorderFolders(ids) {
    await this.ensure()
    const doc = (await this.readFoldersDoc()) ?? { version: 1, folders: [] }
    if (!Array.isArray(ids)) throw new ArchiveError('排序需要一组文件夹 id。', 'invalid-order')
    const orderById = new Map()
    ids.forEach((id, index) => orderById.set(String(id), index))
    let next = ids.length
    for (const folder of doc.folders) {
      if (orderById.has(folder.id)) folder.order = orderById.get(folder.id)
      else folder.order = next++
      folder.updatedAt = stamp()
    }
    doc.folders.sort((a, b) => a.order - b.order)
    await this.writeFoldersDoc({ version: 1, folders: doc.folders })
    return doc.folders
  }

  async deleteFolder(id) {
    await this.ensure()
    const doc = (await this.readFoldersDoc()) ?? { version: 1, folders: [] }
    const index = doc.folders.findIndex(candidate => candidate.id === id)
    if (index < 0) throw new ArchiveError('找不到这个文件夹。', 'folder-not-found')
    const folder = doc.folders[index]
    const dir = path.join(this.root, folder.name)
    const files = await this._listDirNames(dir)
    for (const fileName of files) {
      if (fileName.toLowerCase().endsWith('.md')) await this.trashFile(folder.name, fileName)
    }
    for (const fileName of await this._listDirNames(dir)) {
      await fs.rm(path.join(dir, fileName), { recursive: true, force: true })
    }
    await fs.rm(dir, { recursive: true, force: true })
    doc.folders.splice(index, 1)
    await this.writeFoldersDoc({ version: 1, folders: doc.folders })
    return { name: folder.name, moved: files.filter(name => name.toLowerCase().endsWith('.md')).length }
  }

  /* ---------------- entry reads ---------------- */

  _entryFromFile(folderName, fileName, parsedName, text, stat) {
    const { meta, broken, body } = splitFrontmatter(text)
    let entryDate = parsedName.date
    let title = parsedName.title
    let sections = []
    let created = ''
    let updated = ''
    let formatBroken = broken
    if (meta !== null) {
      if (isDateKey(meta.date)) entryDate = meta.date
      else if (typeof meta.date === 'string' && meta.date.trim() !== '') formatBroken = true
      if (typeof meta.title === 'string' && meta.title.trim() !== '') title = meta.title.trim()
      if (Array.isArray(meta.sections)) {
        sections = meta.sections.filter(section => typeof section === 'string' && section.trim() !== '').map(section => section.trim())
      }
      created = typeof meta.created === 'string' ? meta.created : ''
      updated = typeof meta.updated === 'string' ? meta.updated : ''
    }
    if (sections.length === 0) sections = sectionsFromBody(body)
    const fallbackTime = stat !== undefined ? new Date(stat.mtimeMs) : new Date()
    return {
      id: `${folderName}/${fileName}`,
      folder: folderName,
      file: fileName,
      date: entryDate,
      title,
      seq: parsedName.seq,
      sections,
      created: created !== '' ? created : stamp(fallbackTime),
      updated: updated !== '' ? updated : stamp(fallbackTime),
      body,
      words: wordCount(body),
      excerpt: excerptOf(body),
      firstLine: firstLineOf(body),
      broken: formatBroken,
    }
  }

  async _readEntry(folderName, fileName) {
    const target = path.join(this.root, folderName, fileName)
    let stat
    try {
      stat = await fs.stat(target)
    } catch {
      return null
    }
    if (!stat.isFile()) return null
    const cacheKey = `${folderName}/${fileName}`
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.entry
    const parsedName = parseEntryName(fileName)
    if (parsedName === null) return null
    let text
    try {
      if (stat.size > HEAD_BYTES) {
        const handle = await fs.open(target, 'r')
        try {
          const buffer = Buffer.alloc(HEAD_BYTES)
          const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
          const head = buffer.subarray(0, bytesRead).toString('utf8')
          text = head.includes('\n---', 3) ? await fs.readFile(target, 'utf8') : head
        } finally {
          await handle.close()
        }
      } else {
        text = await fs.readFile(target, 'utf8')
      }
    } catch {
      return null
    }
    const entry = this._entryFromFile(folderName, fileName, parsedName, text, stat)
    this.cache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, entry })
    return entry
  }

  async listEntries({ folder, from, to } = {}) {
    await this.ensure()
    const folders = await this.listFolders()
    const targets = folder === undefined || folder === null || folder === ''
      ? folders
      : folders.filter(candidate => candidate.name === folder)
    const entries = []
    for (const target of targets) {
      const dir = path.join(this.root, target.name)
      let names = []
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const fileName of names) {
        if (!fileName.toLowerCase().endsWith('.md')) continue
        if (parseEntryName(fileName) === null) continue
        const entry = await this._readEntry(target.name, fileName)
        if (entry === null) continue
        if (typeof from === 'string' && from !== '' && entry.date < from) continue
        if (typeof to === 'string' && to !== '' && entry.date > to) continue
        entries.push(entry)
      }
    }
    entries.sort(compareEntries)
    return entries
  }

  async readEntryById(id) {
    const parsed = parseId(id)
    if (parsed === null) throw new ArchiveError('条目 id 不合法。', 'invalid-id')
    await this.ensure()
    const entry = await this._readEntry(parsed.folder, parsed.file)
    if (entry === null) throw new ArchiveError('找不到这条记录，可能已经被移动或删除。', 'entry-not-found')
    return entry
  }

  /** Resolve one entry by folder + date (+ optional title / sequence). */
  async findEntry({ folder, date, title }) {
    const entries = await this.listEntries({ folder })
    const sameDay = entries.filter(entry => entry.date === date)
    if (sameDay.length === 0) return null
    if (typeof title === 'string' && title.trim() !== '') {
      const wanted = title.trim()
      const exact = sameDay.find(entry => entry.title === wanted)
      if (exact !== undefined) return exact
      const loose = sameDay.find(entry => entry.title.trim() !== '' && (entry.title.includes(wanted) || wanted.includes(entry.title)))
      if (loose !== undefined) return loose
    }
    return sameDay[0]
  }

  /* ---------------- entry writes ---------------- */

  async _allocateFileName(folderName, date, title) {
    const base = title === '' ? date : `${date} ${title}`
    const dir = path.join(this.root, folderName)
    for (let index = 1; index < 10000; index += 1) {
      const fileName = index === 1 ? `${base}.md` : `${base} ${index}.md`
      if (!(await this._pathExists(path.join(dir, fileName)))) return fileName
    }
    throw new ArchiveError('同一天同名文件太多了，换个标题吧。', 'too-many-files')
  }

  async writeEntry({ id, folder, date, title, body, sections, mode }) {
    await this.ensure()
    const cleanFolder = String(folder ?? '').trim()
    if (cleanFolder === '') throw new ArchiveError('必须指定文件夹。', 'invalid-folder')
    const cleanDate = String(date ?? '').trim()
    if (!isDateKey(cleanDate)) throw new ArchiveError('日期必须是 YYYY-MM-DD。', 'invalid-date')
    const cleanTitle = safeTitle(title)
    const cleanBody = String(body ?? '').replace(/\r\n/g, '\n')
    if (cleanBody.trim() === '') throw new ArchiveError('正文是空的，不能保存。', 'empty-body')
    const folders = await this.listFolders()
    if (!folders.some(candidate => candidate.name === cleanFolder)) {
      throw new ArchiveError(`没有名为「${cleanFolder}」的文件夹。`, 'folder-not-found')
    }
    let sectionNames = this._cleanSections(sections).map(section => section.name)
    if (sectionNames.length === 0) sectionNames = sectionsFromBody(cleanBody)

    const existing = parseId(id)
    const now = stamp()
    if (existing !== null) {
      const current = await this._readEntry(existing.folder, existing.file)
      if (current === null) throw new ArchiveError('要更新的记录已经不存在了。', 'entry-not-found')
      const samePlace = existing.folder === cleanFolder && current.date === cleanDate && this._titleKey(current.title) === this._titleKey(cleanTitle)
      const created = current.created
      if (samePlace) {
        await this.backupFile(existing.folder, existing.file)
        const document = serializeFrontmatter({
          date: cleanDate,
          title: cleanTitle,
          folder: cleanFolder,
          sections: sectionNames,
          created,
          updated: now,
        }) + cleanBody
        await this._atomicWrite(path.join(this.root, cleanFolder, existing.file), document)
        this.cache.delete(`${cleanFolder}/${existing.file}`)
        return this.readEntryById(`${cleanFolder}/${existing.file}`)
      }
      const nextFile = await this._allocateFileName(cleanFolder, cleanDate, cleanTitle)
      await this.backupFile(existing.folder, existing.file)
      const document = serializeFrontmatter({
        date: cleanDate,
        title: cleanTitle,
        folder: cleanFolder,
        sections: sectionNames,
        created,
        updated: now,
      }) + cleanBody
      await this._atomicWrite(path.join(this.root, cleanFolder, nextFile), document)
      await fs.rm(path.join(this.root, existing.folder, existing.file), { force: true })
      this.cache.delete(`${existing.folder}/${existing.file}`)
      this.cache.delete(`${cleanFolder}/${nextFile}`)
      return this.readEntryById(`${cleanFolder}/${nextFile}`)
    }

    const nextFile = await this._allocateFileName(cleanFolder, cleanDate, cleanTitle)
    const document = serializeFrontmatter({
      date: cleanDate,
      title: cleanTitle,
      folder: cleanFolder,
      sections: sectionNames,
      created: now,
      updated: now,
    }) + cleanBody
    await this._atomicWrite(path.join(this.root, cleanFolder, nextFile), document)
    this.cache.delete(`${cleanFolder}/${nextFile}`)
    return this.readEntryById(`${cleanFolder}/${nextFile}`)
  }

  _titleKey(title) {
    return safeTitle(title)
  }

  async deleteEntry(id) {
    const parsed = parseId(id)
    if (parsed === null) throw new ArchiveError('条目 id 不合法。', 'invalid-id')
    await this.ensure()
    const entry = await this._readEntry(parsed.folder, parsed.file)
    if (entry === null) throw new ArchiveError('找不到这条记录。', 'entry-not-found')
    await this.trashFile(parsed.folder, parsed.file)
    return { id, trashed: true }
  }

  /* ---------------- search / calendar / stats ---------------- */

  async search({ query, folder, from, to, limit = 60 }) {
    const needle = String(query ?? '').trim()
    if (needle === '') return []
    const lower = needle.toLowerCase()
    const entries = await this.listEntries({ folder, from, to })
    const hits = []
    for (const entry of entries) {
      const haystack = entry.body.toLowerCase()
      const index = haystack.indexOf(lower)
      if (index >= 0) {
        hits.push({
          id: entry.id,
          folder: entry.folder,
          date: entry.date,
          title: entry.title,
          field: 'body',
          snippet: snippetAround(entry.body, index, needle.length),
        })
      } else if (entry.title.toLowerCase().includes(lower)) {
        hits.push({
          id: entry.id,
          folder: entry.folder,
          date: entry.date,
          title: entry.title,
          field: 'title',
          snippet: entry.title,
        })
      }
      if (hits.length >= limit) break
    }
    return hits
  }

  async calendar({ folder, month }) {
    const entries = await this.listEntries({ folder })
    const counts = {}
    for (const entry of entries) {
      if (typeof month === 'string' && month !== '' && !entry.date.startsWith(month)) continue
      counts[entry.date] = (counts[entry.date] ?? 0) + 1
    }
    return counts
  }

  async stats({ folder } = {}) {
    const entries = await this.listEntries({ folder })
    const today = dateKey()
    const thisMonth = today.slice(0, 7)
    const monthDates = new Set()
    let monthCount = 0
    for (const entry of entries) {
      if (entry.date.startsWith(thisMonth)) {
        monthCount += 1
        monthDates.add(entry.date)
      }
    }
    const daySet = new Set(entries.map(entry => entry.date))
    let streak = 0
    const cursor = new Date()
    if (!daySet.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
    while (daySet.has(dateKey(cursor))) {
      streak += 1
      cursor.setDate(cursor.getDate() - 1)
    }
    return {
      total: entries.length,
      monthEntries: monthCount,
      monthDays: monthDates.size,
      streak,
      days: daySet.size,
      lastDate: entries.length > 0 ? entries[0].date : '',
    }
  }

  /** Per-folder cards: count, last date, days written this month. */
  async overview() {
    const folders = await this.listFolders()
    const entries = await this.listEntries({})
    const thisMonth = dateKey().slice(0, 7)
    const monthByDate = new Map()
    let monthEntries = 0
    for (const entry of entries) {
      if (!entry.date.startsWith(thisMonth)) continue
      monthEntries += 1
      monthByDate.set(entry.date, (monthByDate.get(entry.date) ?? 0) + 1)
    }
    const daySet = new Set(entries.map(entry => entry.date))
    let streak = 0
    const cursor = new Date()
    if (!daySet.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
    while (daySet.has(dateKey(cursor))) {
      streak += 1
      cursor.setDate(cursor.getDate() - 1)
    }
    const cards = folders.map(folder => {
      const own = entries.filter(entry => entry.folder === folder.name)
      const monthDays = new Set(own.filter(entry => entry.date.startsWith(thisMonth)).map(entry => entry.date)).size
      return {
        id: folder.id,
        name: folder.name,
        color: folder.color,
        order: folder.order,
        template: folder.template,
        count: own.length,
        lastDate: own.length > 0 ? own[0].date : '',
        monthDays,
        sections: folder.template.sections.map(section => section.name),
      }
    })
    return {
      rootDir: this.root,
      folders: cards,
      stats: {
        total: entries.length,
        monthEntries,
        monthDays: monthByDate.size,
        streak,
        days: daySet.size,
      },
    }
  }
}

/** Error carrying a stable machine code for route/tool responses. */
class ArchiveError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

/** Split `folder/file.md` into its parts; null when the shape is wrong. */
function parseId(id) {
  if (typeof id !== 'string' || id.trim() === '') return null
  const value = id.trim().replace(/\\/g, '/')
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  const folder = value.slice(0, slash)
  const file = value.slice(slash + 1)
  if (file.includes('/') || folder.includes('/')) return null
  if (folder === '.' || folder === '..' || file === '.' || file === '..') return null
  if (!file.toLowerCase().endsWith('.md')) return null
  return { folder, file }
}

function compareEntries(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  if (a.created !== b.created) return a.created < b.created ? 1 : -1
  if (a.seq !== b.seq) return b.seq - a.seq
  return a.file < b.file ? 1 : -1
}

/** ±30 characters around a match, with ellipses. */
function snippetAround(body, index, length) {
  const pad = 30
  const start = Math.max(0, index - pad)
  const end = Math.min(body.length, index + length + pad)
  const head = body.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${head}${end < body.length ? '…' : ''}`
}

/* ------------------------------------------------------------------ */
/* HTTP route family                                                   */
/* ------------------------------------------------------------------ */

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, value) {
  if (res.writableEnded) return
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ArchiveError('请求体太大了。', 'body-too-large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ArchiveError('请求体不是合法 JSON。', 'invalid-json')
  }
}

function parseQuery(url) {
  const out = {}
  for (const [key, value] of url.searchParams.entries()) out[key] = value
  return out
}

function createApiHandler(archive) {
  return async function dailyReviewApi(req, res) {
    try {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: '本机回环访问之外不可用。', code: 'forbidden' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== API_BASE && !url.pathname.startsWith(API_PREFIX)) {
        sendJson(res, 404, { error: 'unknown route', code: 'not-found' })
        return
      }
      const action = url.pathname.slice(API_BASE.length).replace(/^\//, '').replace(/\/$/, '')
      const query = parseQuery(url)
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET') {
        switch (action) {
          case 'overview':
            sendJson(res, 200, await archive.overview())
            return
          case 'entries': {
            const entries = await archive.listEntries({
              folder: query.folder,
              from: query.from,
              to: query.to,
            })
            sendJson(res, 200, {
              entries: entries.map(entry => ({
                id: entry.id,
                folder: entry.folder,
                file: entry.file,
                date: entry.date,
                title: entry.title,
                sections: entry.sections,
                words: entry.words,
                excerpt: entry.excerpt,
                firstLine: entry.firstLine,
                created: entry.created,
                updated: entry.updated,
                broken: entry.broken,
              })),
            })
            return
          }
          case 'entry': {
            const entry = await archive.readEntryById(query.id)
            sendJson(res, 200, { entry })
            return
          }
          case 'search': {
            const hits = await archive.search({
              query: query.q ?? '',
              folder: query.scope === 'all' ? undefined : query.folder,
              from: query.from,
              to: query.to,
            })
            sendJson(res, 200, { hits })
            return
          }
          case 'calendar': {
            const counts = await archive.calendar({ folder: query.folder, month: query.month })
            sendJson(res, 200, { days: counts })
            return
          }
          case 'stats': {
            sendJson(res, 200, await archive.stats({ folder: query.folder }))
            return
          }
          case 'config':
            sendJson(res, 200, { rootDir: archive.root })
            return
          default:
            sendJson(res, 404, { error: 'unknown route', code: 'not-found' })
            return
        }
      }

      if (method === 'POST') {
        const body = await readJsonBody(req)
        switch (action) {
          case 'folders/create':
            sendJson(res, 200, { folder: await archive.createFolder(body) })
            return
          case 'folders/update':
            sendJson(res, 200, { folder: await archive.updateFolder(body) })
            return
          case 'folders/reorder':
            sendJson(res, 200, { folders: await archive.reorderFolders(body.ids) })
            return
          case 'folders/delete':
            sendJson(res, 200, { deleted: await archive.deleteFolder(body.id) })
            return
          case 'entry/save':
            sendJson(res, 200, { entry: await archive.writeEntry(body) })
            return
          case 'entry/delete':
            sendJson(res, 200, { deleted: await archive.deleteEntry(body.id) })
            return
          default:
            sendJson(res, 404, { error: 'unknown route', code: 'not-found' })
            return
        }
      }

      sendJson(res, 405, { error: 'method not allowed', code: 'method-not-allowed' })
    } catch (error) {
      const code = error instanceof ArchiveError ? error.code : 'internal-error'
      const status = code === 'internal-error' ? 500 : 400
      sendJson(res, status, {
        error: error instanceof Error ? error.message : String(error),
        code,
      })
    }
  }
}

/* ------------------------------------------------------------------ */
/* agent tools                                                         */
/* ------------------------------------------------------------------ */

function textResult(value) {
  return [{ type: 'text', text: value }]
}

function entrySummaryLine(entry, index) {
  const title = entry.title === '' ? '' : ` 《${entry.title}》`
  return `${index + 1}. ${entry.date}${title} — ${entry.folder} · ${entry.words} 字 · ${entry.firstLine || entry.excerpt || '（空）'}`
}

function buildTools(archive) {
  const foldersTool = {
    name: 'daily_review_folders',
    description: 'List the user\'s daily-review (日精进) folders with entry counts, last date and each folder\'s section template. Call this first when the user asks to review or read their daily notes.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rootDir: { type: 'string' },
          folders: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                count: { type: 'integer' },
                lastDate: { type: 'string' },
                monthDays: { type: 'integer' },
                sections: { type: 'array', items: { type: 'string' } },
              },
              required: ['name', 'count', 'lastDate', 'monthDays', 'sections'],
            },
          },
        },
        required: ['rootDir', 'folders'],
      },
      render(_args, value) {
        const lines = [`日精进根目录：${value.rootDir}`]
        if (value.folders.length === 0) lines.push('（还没有任何文件夹）')
        for (const folder of value.folders) {
          lines.push(`- ${folder.name}：${folder.count} 篇${folder.lastDate === '' ? '' : `，最近 ${folder.lastDate}`}，本月 ${folder.monthDays} 天`)
          if (folder.sections.length > 0) lines.push(`  - 板块：${folder.sections.join(' / ')}`)
        }
        return textResult(lines.join('\n'))
      },
    },
    async execute() {
      const overview = await archive.overview()
      // Project onto exactly the declared output contract: the host rejects
      // undeclared properties because the schema sets additionalProperties:false.
      return {
        rootDir: overview.rootDir,
        folders: overview.folders.map(folder => ({
          name: folder.name,
          count: folder.count,
          lastDate: folder.lastDate,
          monthDays: folder.monthDays,
          sections: folder.sections,
        })),
      }
    },
  }

  const listTool = {
    name: 'daily_review_list',
    description: 'List daily-review entry summaries (date, title, first line, word count) without the full text. Optionally narrow by folder and by an inclusive YYYY-MM-DD date range.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        folder: { type: 'string', description: 'Folder name; omit to list every folder.' },
        from: { type: 'string', description: 'Inclusive start date, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Inclusive end date, YYYY-MM-DD.' },
        limit: { type: 'integer', description: 'Maximum entries to return (default 50).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                folder: { type: 'string' },
                date: { type: 'string' },
                title: { type: 'string' },
                firstLine: { type: 'string' },
                words: { type: 'integer' },
                sections: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'folder', 'date', 'title', 'firstLine', 'words', 'sections'],
            },
          },
        },
        required: ['total', 'entries'],
      },
      render(_args, value) {
        if (value.entries.length === 0) return textResult('这段时间没有日精进记录。')
        const lines = value.entries.map(entrySummaryLine)
        if (value.total > value.entries.length) lines.push(`（共 ${value.total} 篇，这里只列出前 ${value.entries.length} 篇）`)
        return textResult(lines.join('\n'))
      },
    },
    async execute(args) {
      const all = await archive.listEntries({ folder: args.folder, from: args.from, to: args.to })
      const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(500, args.limit)) : 50
      return {
        total: all.length,
        entries: all.slice(0, limit).map(entry => ({
          id: entry.id,
          folder: entry.folder,
          date: entry.date,
          title: entry.title,
          firstLine: entry.firstLine,
          words: entry.words,
          sections: entry.sections,
        })),
      }
    },
  }

  const readTool = {
    name: 'daily_review_read',
    description: 'Read one daily-review entry in full. Identify it either by id (from daily_review_list) or by folder plus date, optionally with a title when several entries share that day.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Entry id such as "学习/2026-10-25.md".' },
        folder: { type: 'string', description: 'Folder name, when using folder + date.' },
        date: { type: 'string', description: 'Entry date, YYYY-MM-DD.' },
        title: { type: 'string', description: 'Optional title to disambiguate several entries on one day.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          folder: { type: 'string' },
          date: { type: 'string' },
          title: { type: 'string' },
          sections: { type: 'array', items: { type: 'string' } },
          words: { type: 'integer' },
          body: { type: 'string' },
          found: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['found', 'id', 'folder', 'date', 'title', 'sections', 'words', 'body'],
      },
      render(_args, value) {
        if (!value.found) return textResult(value.note ?? '没有找到这条记录。')
        const lines = [`${value.folder} · ${value.date}${value.title === '' ? '' : ` · ${value.title}`}（${value.words} 字）`]
        if (value.note !== undefined && value.note !== '') lines.push(value.note)
        lines.push('', value.body)
        return textResult(lines.join('\n'))
      },
    },
    async execute(args) {
      let entry = null
      if (typeof args.id === 'string' && args.id.trim() !== '') {
        try {
          entry = await archive.readEntryById(args.id)
        } catch {
          entry = null
        }
      } else if (typeof args.folder === 'string' && typeof args.date === 'string') {
        entry = await archive.findEntry({ folder: args.folder, date: args.date, title: args.title })
      }
      if (entry === null) {
        return {
          found: false,
          id: '',
          folder: typeof args.folder === 'string' ? args.folder : '',
          date: typeof args.date === 'string' ? args.date : '',
          title: '',
          sections: [],
          words: 0,
          body: '',
          note: '没有找到这条记录：先调用 daily_review_list 确认文件夹名和日期。',
        }
      }
      return {
        found: true,
        id: entry.id,
        folder: entry.folder,
        date: entry.date,
        title: entry.title,
        sections: entry.sections,
        words: entry.words,
        body: entry.body,
        note: entry.broken ? '这篇的 frontmatter 格式异常，内容按文件名日期读出。' : '',
      }
    },
  }

  const searchTool = {
    name: 'daily_review_search',
    description: 'Full-text search across daily-review entries and return a ±30 character snippet around each match. Use it to find recurring patterns before writing a review.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Text to look for (case-insensitive).' },
        folder: { type: 'string', description: 'Limit to one folder.' },
        from: { type: 'string', description: 'Inclusive start date, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Inclusive end date, YYYY-MM-DD.' },
      },
      // 必填只能表达在这里。写成 `query: { required: true }` 是「参数方言」，
      // 不是 JSON Schema —— 宿主的 checkSchemaNode 会判定
      // `properties.query.required is not supported on type "string"`，
      // 工具注册即非法，会话里每一轮请求都会带着它被接口拒掉。
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                folder: { type: 'string' },
                date: { type: 'string' },
                title: { type: 'string' },
                field: { type: 'string' },
                snippet: { type: 'string' },
              },
              required: ['id', 'folder', 'date', 'title', 'field', 'snippet'],
            },
          },
        },
        required: ['total', 'hits'],
      },
      render(_args, value) {
        if (value.hits.length === 0) return textResult('没有匹配的记录。')
        const lines = value.hits.map(hit => `${hit.date} · ${hit.folder}${hit.title === '' ? '' : ` 《${hit.title}》`}\n   ${hit.snippet}`)
        return textResult(`${value.total} 条匹配：\n${lines.join('\n')}`)
      },
    },
    async execute(args) {
      const hits = await archive.search({
        query: typeof args.query === 'string' ? args.query : '',
        folder: args.folder,
        from: args.from,
        to: args.to,
      })
      return { total: hits.length, hits }
    },
  }

  const writeTool = {
    name: 'daily_review_write',
    description: 'Write a daily-review entry. Only call this when the user explicitly asks you to save or append something to their daily review; never invent content on your own. mode "append" appends to that day\'s entry (creating it when missing), "create" always creates a new entry (same-day entries get a sequence number), and "overwrite" replaces an existing entry only after the user confirms. Every write backs up the previous file first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        folder: { type: 'string', description: 'Folder name; it must already exist.' },
        date: { type: 'string', description: 'Entry date, YYYY-MM-DD.' },
        body: { type: 'string', description: 'Markdown body to write. Use "## 板块名" headings that match the folder template when you have no better structure.' },
        title: { type: 'string', description: 'Optional entry title.' },
        mode: { type: 'string', description: 'append (default) | create | overwrite.' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Section names in order; omit to derive them from the "## " headings in body.' },
        id: { type: 'string', description: 'Entry id to overwrite; required for mode "overwrite".' },
        confirm: { type: 'boolean', description: 'Must be true for overwrite; the user has to agree to replacing existing content.' },
      },
      // 同上：必填集中在根节点，不能写在单个属性里。
      required: ['folder', 'date', 'body'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          folder: { type: 'string' },
          date: { type: 'string' },
          title: { type: 'string' },
          words: { type: 'integer' },
          mode: { type: 'string' },
        },
        required: ['id', 'folder', 'date', 'title', 'words', 'mode'],
      },
      render(_args, value) {
        return textResult(`已写入 ${value.folder} · ${value.date}${value.title === '' ? '' : ` · ${value.title}`}（${value.mode}，${value.words} 字）：${value.id}`)
      },
    },
    async execute(args) {
      const mode = args.mode === 'create' || args.mode === 'overwrite' ? args.mode : 'append'
      const folder = typeof args.folder === 'string' ? args.folder : ''
      const date = typeof args.date === 'string' ? args.date : ''
      const body = typeof args.body === 'string' ? args.body : ''
      if (mode === 'overwrite') {
        if (args.confirm !== true) {
          throw new ArchiveError('覆盖会替换掉已有正文：请先向用户确认，再带 confirm: true 重新调用。', 'overwrite-needs-confirm')
        }
        if (typeof args.id !== 'string' || args.id.trim() === '') {
          throw new ArchiveError('overwrite 需要提供要替换的条目 id。', 'overwrite-needs-id')
        }
        const entry = await archive.writeEntry({
          id: args.id,
          folder,
          date,
          title: args.title,
          body,
          sections: args.sections,
          mode,
        })
        return { id: entry.id, folder: entry.folder, date: entry.date, title: entry.title, words: entry.words, mode }
      }
      if (mode === 'create') {
        const entry = await archive.writeEntry({ folder, date, title: args.title, body, sections: args.sections, mode })
        return { id: entry.id, folder: entry.folder, date: entry.date, title: entry.title, words: entry.words, mode }
      }
      const existing = await archive.findEntry({ folder, date, title: args.title })
      const addition = body.replace(/^\n+/, '')
      const separator = existing === null || existing.body.trim() === '' ? '' : '\n\n'
      const sections = args.sections ?? existing?.sections
      const merged = existing === null ? addition : `${existing.body.replace(/\s+$/, '')}${separator}${addition}`
      const entry = await archive.writeEntry({
        id: existing?.id,
        folder,
        date,
        title: args.title ?? existing?.title ?? '',
        body: merged,
        sections,
        mode,
      })
      return { id: entry.id, folder: entry.folder, date: entry.date, title: entry.title, words: entry.words, mode }
    },
  }

  return [foldersTool, listTool, readTool, searchTool, writeTool]
}

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve Schemastery.
 *
 * A bundle installed from a local directory is *linked*, so Node resolves bare
 * specifiers from the authoring directory rather than from the profile. The
 * host process may also lack DSH_PROFILE_DIR. Therefore: try the bare import,
 * then probe the known locations of the profile's own copy (the Harness always
 * ships schemastery there) before giving up and running without a Config.
 */
async function loadSchemastery() {
  try {
    const loaded = await import('@deepseek-ai/schemastery')
    return loaded?.default ?? loaded
  } catch {
    /* expected for a linked directory install */
  }
  const roots = []
  const pushRoot = value => {
    if (typeof value === 'string' && value.trim() !== '' && !roots.includes(value)) roots.push(value)
  }
  pushRoot(process.env.DSH_PROFILE_DIR)
  pushRoot(process.env.DSH_HOME)
  const home = os.homedir()
  pushRoot(path.join(home, '.dsh'))
  const profilesRoot = path.join(home, '.dsh', 'profiles')
  try {
    for (const name of await fs.readdir(profilesRoot)) pushRoot(path.join(profilesRoot, name))
  } catch {
    /* no profiles directory */
  }
  for (const root of roots) {
    for (const candidate of [
      path.join(root, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
      path.join(root, '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
    ]) {
      try {
        await fs.access(candidate)
        const loaded = await import(pathToFileURL(candidate).href)
        return loaded?.default ?? loaded
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null
}

const schema = await loadSchemastery()

export const Config = schema === null
  ? undefined
  : schema.object({
    // 日精进存档根目录：每个文件夹是它的一个子目录
    rootDir: schema.string().default(DEFAULT_ROOT),
    // 写入前备份保留天数
    backupDays: schema.natural().default(10),
    // 回收站保留天数
    trashDays: schema.natural().default(7),
  })

/** Optional: the tool registry is required, the web server only exists in Web profiles. */
export const inject = ['tools']

export const name = 'daily-review'

/** Append one activation trace so a silent host-half failure is diagnosable. */
async function writeBootTrace(lines) {
  try {
    const target = path.join(os.homedir(), '.dsh', 'daily-review-boot.log')
    await fs.appendFile(target, `${lines.join('\n')}\n`, 'utf8')
  } catch {
    /* diagnostics must never break activation */
  }
}

export function apply(ctx, config) {
  const trace = [`--- ${new Date().toISOString()} apply ---`]
  const mark = message => {
    trace.push(message)
  }
  try {
    const rootDir = typeof config?.rootDir === 'string' && config.rootDir.trim() !== '' ? config.rootDir.trim() : DEFAULT_ROOT
    mark(`rootDir=${rootDir}`)
    const archive = new Archive(rootDir, {
      backupDays: config?.backupDays,
      trashDays: config?.trashDays,
    })

    ctx.effect(() => {
      void archive.ensure().catch(error => {
        mark(`ensure failed: ${error instanceof Error ? error.message : String(error)}`)
        try {
          ctx.logger?.warn?.(`[dsh-daily-review] 初始化存档目录失败：${error instanceof Error ? error.message : String(error)}`)
        } catch {
          /* logging must never fail activation */
        }
      })
      return () => {
        archive.cache.clear()
      }
    }, 'daily-review: archive bootstrap')
    mark('archive effect registered')

    // Loopback JSON routes for the Web GUI half. Resolve the web server through
    // every seam Cordis offers (dynamic inject, then the direct service), and
    // record which one worked so a missing route is never a silent mystery.
    const holder = { server: null }
    const locate = scope => {
      if (scope === undefined || scope === null) return null
      try {
        const direct = scope.webServer
        if (direct !== undefined && direct !== null && typeof direct.register === 'function') return direct
      } catch {
        /* accessing an undeclared service can throw */
      }
      try {
        const viaGet = typeof scope.get === 'function' ? scope.get('webServer') : undefined
        if (viaGet !== undefined && viaGet !== null && typeof viaGet.register === 'function') return viaGet
      } catch {
        /* ignore */
      }
      return null
    }
    const registerWith = (scope, label) => {
      if (holder.server !== null) return true
      const server = locate(scope)
      if (server === null) {
        mark(`${label}: webServer unavailable`)
        return false
      }
      try {
        scope.effect(
          () => server.register({ kind: 'prefix', path: API_BASE, handler: createApiHandler(archive) }),
          'daily-review: api routes',
        )
        holder.server = server
        mark(`${label}: route registered`)
        return true
      } catch (error) {
        mark(`${label}: register failed: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }

    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['webServer'], injected => {
          registerWith(injected, 'inject(webServer)')
        })
      } catch (error) {
        mark(`inject threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      mark('ctx.inject is not a function')
    }
    if (holder.server === null) registerWith(ctx, 'direct ctx')

    // Agent tools (read-only ones plus one guarded write tool).
    let toolCount = 0
    for (const definition of buildTools(archive)) {
      ctx.effect(() => ctx.tools.register(definition), `daily-review: tool ${definition.name}`)
      toolCount += 1
    }
    mark(`tools registered: ${toolCount}`)
  } catch (error) {
    mark(`APPLY FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  } finally {
    void writeBootTrace(trace)
  }
}
