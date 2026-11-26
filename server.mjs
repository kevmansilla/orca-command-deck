// App local de Source Control. Escucha solo en 127.0.0.1, exige un token que cambia en cada arranque
// y nunca commitea ni pushea en una rama desplegada.
import { execFile, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { activateWorktree, createWorkspaceChat, focusTerminal, launchChat, openSessions, openTerminal, worktrees as orcaWorktrees } from './orca-tab.mjs'
import { BLOCKER_FILES, blockerIn, branchFor, fetchMyIssues, fillPrompt, jiraConfig, jiraRows, jiraSections, jiraTargets, pushedIn, rememberStart, sessionsOf, visibleRows } from './jira.mjs'
import { buildSnapshot, isTerminal } from './pitwall.mjs'
import { cachePath } from './state.mjs'

const HOME = homedir()
const INDEX = fileURLToPath(new URL('./index.html', import.meta.url))
// El código de la página va en archivos aparte porque el panel lateral de Orca no corre scripts inline. No tiene secretos:
// se sirve sin token, y la página sigue exigiéndolo.
const ASSETS = { '/app.js': 'text/javascript; charset=utf-8', '/app.css': 'text/css; charset=utf-8' }
const POLICY_FILE = process.env.MRG_POLICY_FILE ?? join(HOME, '.config/orca-multi-repo-git/policy.json')
const REPOS_FILE = process.env.MRG_REPOS_FILE
const ORCA_DIRS = [join(HOME, '.config/orca'), join(HOME, 'Library/Application Support/orca'), join(HOME, 'AppData/Roaming/orca')]
const DEFAULT_PROTECTED = ['main', 'master']
const REMOTE_HEAD_MS = 60_000
const MAX_BODY = 64 * 1024
const MAX_DIFF = 400_000
const READ_MS = 20_000
const WRITE_MS = 120_000
const HASH_RE = /^[0-9a-f]{4,40}$/
const COLOR_RE = /^#[0-9a-f]{3,8}$/i
const PUSH_PREVIEW = 50
const SCAN_MS = 15_000
const TICKET_RE = /(?:^|\/)([a-z]+-\d+)(?:-|$)/i
const TICKET_STATE_RE = /^- \*\*Estado:\*\*\s*`?([a-z][a-z -]*[a-z])/m
const FETCH_EVERY_MS = 10 * 60_000
const FETCH_MS = 30_000
const FETCH_AT_ONCE = 4
// Un repo sin movimiento se revisa cada tanto; el que cambió hace poco, en cada consulta.
const QUIET_CHECK_MS = 20_000
const ACTIVE_MS = 2 * 60_000
// La pestaña consulta Pit Wall cada pocos segundos: dentro de esta ventana se reusa la última respuesta de Orca.
const PITWALL_CACHE_MS = 2_000
// Jira se consulta como mucho cada 5 minutos; las ramas del remoto (del último fetch, sin fetch nuevo), cada 2.
const JIRA_CACHE_MS = 5 * 60_000
const REMOTE_REFS_MS = 2 * 60_000
// El motivo de una falla de la CLI que se muestra en el panel; el completo va al journal.
const CLI_REASON_MAX = 300
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/
const HARNESS_STATES = ['nuevo', 'planificado', 'en-progreso', 'en-review', 'en-correccion', 'listo-para-probar', 'listo-para-deploy', 'desplegado', 'bloqueado', 'descartado']
const INLINE_STATE_RE = /\*\*Estado:\*\*\s*`?([a-z][a-z-]*[a-z])/
const DEPLOYED_RE = /^- \*\*Estado:\*\*\s*`?ejecutado/m
// Solo pide confirmación: un falso positivo cuesta un clic, y un secreto subido no se puede deshacer.
const SENSITIVE_RE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?|\.netrc|\.npmrc|\.pgpass|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.[^/]+)?|secrets?(\.[^/]+)?|[^/]+\.(pem|key|p12|pfx|jks|keystore|tfstate|tfvars))$/i

const READ_ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  // Sin terminal, una clave con passphrase colgaría a ssh hasta el timeout.
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes'
}
const WRITE_ENV = { ...READ_ENV, GIT_OPTIONAL_LOCKS: '1' }

class ActionError extends Error {}

class SensitiveError extends ActionError {
  status = 409
  constructor(files) {
    super('Hay archivos que parecen secretos.')
    this.extra = { sensitive: files }
  }
}

const isSensitive = (rel) => SENSITIVE_RE.test(rel)

function run(args, { env = READ_ENV, timeout = READ_MS, input = null, check = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new ActionError(`No se pudo ejecutar git: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      if (code !== 0 && check) {
        const text = Buffer.concat(err).toString('utf8') || stdout
        return reject(new ActionError(text.trim().slice(-1500) || 'git falló'))
      }
      resolve({ stdout, code })
    })
    child.stdin.end(input ?? undefined)
  })
}

const git = async (path, ...args) => (await run(['-C', path, ...args])).stdout
const gitChecked = async (path, ...args) => (await run(['-C', path, ...args], { check: true })).stdout
const write = (path, args, input) => run(['-C', path, ...args], { env: WRITE_ENV, timeout: WRITE_MS, input, check: true })

function orcaProfileDirs(dir) {
  const profiles = join(dir, 'profiles')
  if (!existsSync(profiles)) return []
  try {
    const { activeProfileId } = JSON.parse(readFileSync(join(dir, 'orca-profile-index.json'), 'utf8'))
    if (activeProfileId && existsSync(join(profiles, activeProfileId))) return [join(profiles, activeProfileId)]
  } catch {
    // Sin índice legible se usa el perfil más reciente de abajo.
  }
  return readdirSync(profiles).map((name) => join(profiles, name))
}

function readLiveState(dir) {
  // Es la base viva de Orca: orca-data.json solo se exporta al abrir la app y deja afuera los cambios recientes.
  const db = new DatabaseSync(join(dir, 'profile-state.db'), { readOnly: true })
  try {
    const rows = db.prepare("select domain, payload from profile_state_documents where domain in ('repos', 'projectGroups')").all()
    const docs = Object.fromEntries(rows.map((r) => [r.domain, JSON.parse(r.payload)]))
    return Array.isArray(docs.repos) ? docs : null
  } finally {
    db.close()
  }
}

function orcaData() {
  const dirs = ORCA_DIRS.flatMap(orcaProfileDirs)
  for (const dir of dirs) {
    try {
      const live = readLiveState(dir)
      if (live) return live
    } catch {
      // El formato de esa base es interno de Orca: si cambia, queda el export en JSON.
    }
  }
  const files = dirs.map((d) => join(d, 'orca-data.json'))
  const found = files.filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (!found.length) throw new ActionError('No encontré los datos de Orca.')
  return JSON.parse(readFileSync(found[0], 'utf8'))
}

function isRepo(path) {
  return existsSync(join(path, '.git'))
}

function nestedRepos(folder) {
  // Un proyecto de tipo carpeta puede contener varios repos, un nivel abajo.
  return readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && isRepo(join(folder, e.name)))
    .map((e) => join(folder, e.name))
    .sort((a, b) => a.localeCompare(b))
}

// Se lee del disco porque corre en cada pedido: lanzar git por repo acá sumaría decenas de procesos.
function worktreesOf(item) {
  const dir = join(item.path, '.git', 'worktrees')
  if (!existsSync(dir)) return []
  const rootName = basename(item.path)
  return readdirSync(dir).flatMap((id) => {
    try {
      const path = dirname(readFileSync(join(dir, id, 'gitdir'), 'utf8').trim())
      if (!existsSync(path)) return [] // quedó registrado, pero la carpeta ya no está
      const name = basename(path) === rootName ? basename(dirname(path)) : basename(path)
      return [{ ...item, key: path, name, path, root: item.path, worktreeOf: item.key }]
    } catch {
      return [] // otro proceso lo está creando o borrando
    }
  })
}

function withWorktrees(items) {
  const seen = new Set(items.map((r) => r.key))
  return items.flatMap((item) => {
    const extra = worktreesOf(item).filter((w) => !seen.has(w.key))
    extra.forEach((w) => seen.add(w.key))
    return [item, ...extra]
  })
}

function listRepos() {
  if (REPOS_FILE) {
    return withWorktrees(JSON.parse(readFileSync(REPOS_FILE, 'utf8')).map((r) => ({ key: r.name, name: r.name, path: r.path, group: '' })))
  }
  const data = orcaData()
  const groups = new Map((data.projectGroups ?? []).map((g) => [g.id, g]))
  const rank = (r) => [groups.get(r.projectGroupId)?.tabOrder ?? groups.size, r.projectGroupOrder ?? 0]
  const sorted = [...(data.repos ?? [])].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)]
    return x[0] - y[0] || x[1] - y[1] || (a.displayName ?? '').localeCompare(b.displayName ?? '')
  })
  const { exclude } = readPolicy()
  const found = []
  for (const repo of sorted) {
    const path = (repo.path ?? '').replace(/\/+$/, '')
    if (!path || path.split(sep).some((part) => exclude.includes(part)) || !existsSync(path)) continue
    const group = groups.get(repo.projectGroupId)?.name ?? 'Sin grupo'
    const color = COLOR_RE.test(repo.badgeColor ?? '') ? repo.badgeColor : null
    if (isRepo(path)) found.push({ key: path, name: repo.displayName || basename(path), path, group, color })
    // Un repo también puede tener otro adentro, ignorado por el de afuera: sin esto sus cambios no aparecían en
    // ningún lado.
    for (const p of nestedRepos(path)) {
      if (!found.some((r) => r.key === p)) found.push({ key: p, name: basename(p), path: p, group, color })
    }
  }
  return withWorktrees(found)
}

const expandHome = (path) => path.replace(/^~(?=\/|$)/, HOME)

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Las reglas solo existen para aflojar o ajustar lo protegido, y son de cada máquina.
// Sin archivo, o con uno ilegible, rige la protección por defecto, que es la más estricta.
function readPolicy() {
  const data = readJson(POLICY_FILE)
  const rules = (Array.isArray(data?.rules) ? data.rules : []).map((r) => ({
    ...r,
    path: r.path && expandHome(r.path),
    under: r.under && expandHome(r.under),
    bases: r.bases && expandHome(r.bases)
  }))
  const scoped = (c) => ({ ...c, under: c.under && expandHome(c.under) })
  return {
    rules,
    exclude: Array.isArray(data?.exclude) ? data.exclude : [],
    // Ramas que viven siempre (la de un agente que se resetea a la base): no son de trabajo, nunca "mergeadas".
    standing: Array.isArray(data?.standingBranches) ? data.standingBranches : [],
    floating: data?.terminal === 'floating',
    pullRequests: data?.pullRequests !== false,
    commands: (Array.isArray(data?.commands) ? data.commands : []).map(scoped),
    worktrees: data?.worktrees ? scoped(data.worktrees) : null,
    tickets: (Array.isArray(data?.tickets) ? data.tickets : []).map((t) => ({ ...scoped(t), dir: t.dir && expandHome(t.dir) })),
    scan: data?.scan?.run ? { ...scoped(data.scan), run: expandHome(data.scan.run) } : null,
    jira: jiraConfig(data?.jira, expandHome)
  }
}

// Si el archivo o la clave no están, la lista queda vacía y los repos siguen protegidos.
function listFrom(source) {
  const data = source?.file ? readJson(expandHome(source.file)) : null
  const value = String(source?.key ?? '').split('.').reduce((v, k) => v?.[k], data)
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : []
}

const inScope = (entry, path) => !entry?.under || path === entry.under || path.startsWith(entry.under + sep)

export const shellQuote = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`

export function fillCommand(template, values) {
  return template.replace(/\{(repo|path|branch)\}/g, (_, key) => shellQuote(values[key]))
}

function gitDir(path) {
  const dot = join(path, '.git')
  if (statSync(dot).isDirectory()) return dot
  const target = readFileSync(dot, 'utf8').replace(/^gitdir:\s*/, '').trim()
  return isAbsolute(target) ? target : resolve(path, target)
}

function stopped(path) {
  try {
    const dir = gitDir(path)
    return ['MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((f) => existsSync(join(dir, f)))
  } catch {
    return false // el worktree se está borrando
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// Lo que tiene un archivo del ticket además de su plantilla. Los comentarios y títulos no cuentan.
function ownLines(text, template) {
  const lines = (t) => (t ?? '').replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const known = new Set(lines(template))
  return lines(text).filter((l) => !known.has(l))
}

function ticketFolder(dir, id) {
  for (const place of [dir, join(dir, '_archivo')]) {
    if (!existsSync(place)) continue
    const name = readdirSync(place).find((n) => n.toUpperCase().startsWith(`${id}-`))
    if (name) return join(place, name)
  }
  return null
}

function ticketOf(root, branch) {
  const source = readPolicy().tickets.find((t) => t.dir && inScope(t, root))
  const id = source && TICKET_RE.exec(branch)?.[1].toUpperCase()
  const folder = id ? ticketFolder(source.dir, id) : null
  if (!folder) return null
  const template = (f) => readText(join(source.dir, '_template', f))
  const deploy = readText(join(folder, 'deploy.md'))
  return {
    id,
    state: TICKET_STATE_RE.exec(readText(join(folder, 'US.md')) ?? '')?.[1] ?? null,
    testMissing: !ownLines(readText(join(folder, 'test.md')), template('test.md')).length,
    deployPending: ownLines(deploy, template('deploy.md')).length > 0 && !DEPLOYED_RE.test(deploy)
  }
}

// El estado del ticket en el harness: la viñeta de US.md; si no, el campo en línea («· **Estado:** desplegado ·»); si
// no, su fila de INDEX.md. Solo cuentan los estados fijos.
function stateOf(dir, key, us) {
  const known = (v) => (HARNESS_STATES.includes(v) ? v : null)
  const bullet = known(TICKET_STATE_RE.exec(us)?.[1] ?? null)
  if (bullet) return bullet
  const inline = known(INLINE_STATE_RE.exec(us)?.[1] ?? null)
  if (inline) return inline
  const row = (readText(join(dir, 'INDEX.md')) ?? '').split('\n').find((l) => l.startsWith(`| ${key} |`))
  return row?.match(/`([a-z-]+)`/g)?.map((t) => t.slice(1, -1)).find(known) ?? null
}

// Lo que el harness asienta de un ticket de Jira: su estado (US.md), si el deploy se ejecutó y la traba de negocio
// abierta, si tiene. Los archivados no traban.
function harnessOf(dir, key) {
  const folder = dir ? ticketFolder(dir, key) : null
  if (!folder) return { blocker: null, harness: null }
  const archived = basename(dirname(folder)) === '_archivo'
  const state = stateOf(dir, key, readText(join(folder, 'US.md')) ?? '')
  const deployed = state === 'desplegado' || DEPLOYED_RE.test(readText(join(folder, 'deploy.md')) ?? '')
  const blocker = archived ? null : BLOCKER_FILES.map((f) => blockerIn(readText(join(folder, f)))).find(Boolean) ?? null
  return { blocker, harness: { state, deployed } }
}

// Solo las líneas agregadas: lo que ya estaba en el repo no es parte de este push.
function addedLines(diff) {
  const files = new Map()
  let file = null
  let inHeader = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) inHeader = true
    else if (inHeader && line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '')
    else if (line.startsWith('@@')) inHeader = false
    else if (!inHeader && file && line.startsWith('+')) files.set(file, `${files.get(file) ?? ''}${line.slice(1)}\n`)
  }
  return files
}

const runScanner = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: SCAN_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, output: `${stdout}\n${stderr}` })
  })
})

// Devuelve archivo y tipo, nunca la línea: el valor encontrado puede ser el secreto.
// Las copias van a una carpeta privada porque el scanner recibe rutas, y se borran enseguida.
async function scanPush(root, path, range) {
  const scan = readPolicy().scan
  if (!scan || !inScope(scan, root)) return { hits: [], failed: false }
  const files = addedLines(await git(path, '-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--unified=0', '--diff-filter=d', range))
  if (!files.size) return { hits: [], failed: false }
  const dir = mkdtempSync(join(tmpdir(), 'mrg-scan-'))
  try {
    const names = [...files.keys()]
    const copies = names.map((_, i) => join(dir, String(i)))
    names.forEach((name, i) => writeFileSync(copies[i], files.get(name), { mode: 0o600 }))
    const { code, output } = await runScanner(scan.run, copies)
    if (code === 0) return { hits: [], failed: false }
    if (code !== 1) return { hits: [], failed: true }
    const hits = new Set()
    for (const [, index, kind] of output.matchAll(/^\s*\S*\/(\d+):\d+\s+\[([^\]—]+?)\s*(?:—[^\]]*)?\]/gm)) hits.add(`${names[Number(index)]}: ${kind}`)
    return { hits: [...hits], failed: !hits.size }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function commandsFor(root, { isMerging, base, isProtected, isStanding = false }) {
  const { commands, worktrees } = readPolicy()
  const applies = (c) => inScope(c, root) && (c.when !== 'merging' || isMerging) && (c.when !== 'feature' || (!isProtected && !isStanding))
  const list = commands.flatMap((c, id) =>
    applies(c) ? [{ id, label: c.label.replaceAll('{base}', base), hint: c.hint ?? c.run, run: c.run, warn: !!c.warn, urgent: c.when === 'merging' }] : []
  )
  const wt = worktrees && inScope(worktrees, root) ? worktrees : null
  return { commands: list, canCreateWorktree: !!wt?.create, canRemoveWorktree: !!wt?.remove }
}

const remoteHeads = new Map()

async function remoteDefault(path) {
  const known = remoteHeads.get(path)
  if (known && Date.now() - known.at < REMOTE_HEAD_MS) return known.branch
  const head = (await git(path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).trim()
  const branch = head.split('/').slice(1).join('/') || null
  remoteHeads.set(path, { branch, at: Date.now() })
  return branch
}

// Solo hosts conocidos: un alias de ~/.ssh/config no dice a qué sitio apunta.
export function prUrl(remote, branch, base) {
  const m = remote.match(/^(?:git@|ssh:\/\/git@|https:\/\/(?:[^/@]+@)?)([^:/]+)[:/](.+?)(?:\.git)?\/?$/)
  if (!m) return null
  const [, host, repo] = m
  const name = branch.split('/').map(encodeURIComponent).join('/')
  if (host === 'github.com') return `https://github.com/${repo}/compare/${base}...${name}?expand=1`
  if (host === 'gitlab.com') return `https://gitlab.com/${repo}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}`
  if (host === 'bitbucket.org') return `https://bitbucket.org/${repo}/pull-requests/new?source=${encodeURIComponent(branch)}&t=1`
  return null
}

const remoteUrls = new Map()

async function remoteUrl(path) {
  const known = remoteUrls.get(path)
  if (known && Date.now() - known.at < REMOTE_HEAD_MS) return known.url
  const url = (await git(path, 'remote', 'get-url', 'origin')).trim()
  remoteUrls.set(path, { url, at: Date.now() })
  return url
}

async function policy(path, root = path) {
  const remote = await remoteDefault(path)
  const strict = { blocked: new Set([...DEFAULT_PROTECTED, ...(remote ? [remote] : [])]), base: remote ?? 'main' }
  const rule = readPolicy().rules.find((r) => r.path === root || (r.under && root.startsWith(r.under + sep)))
  if (!rule) return strict
  if (rule.free) return { blocked: new Set(), base: strict.base }
  if (rule.bases) {
    const data = readJson(rule.bases)
    if (!data) return strict
    const name = basename(root)
    const base = data.repos?.[name] ?? data.default ?? strict.base
    if (data.git_libre?.includes(name)) return { blocked: new Set(), base }
    // Se liberan las ramas pero la base sigue desplegando: el aviso de los comandos se mantiene.
    if (listFrom(rule.freeFrom).includes(name)) return { blocked: new Set(), base, deploys: !rule.protected }
    // Con `protected`, lo desplegado no es la base: el aviso de que un push a la base despliega sería falso.
    return { blocked: new Set([base, data.diagnostico?.[name] ?? base, ...(rule.protected ?? [])]), base, deploys: !rule.protected }
  }
  return { blocked: new Set(rule.protected ?? strict.blocked), base: rule.base ?? strict.base }
}

function afterSpaces(line, count) {
  let index = -1
  for (let i = 0; i < count; i++) index = line.indexOf(' ', index + 1)
  return line.slice(index + 1)
}

function parseStatus(raw) {
  const head = {}
  const staged = []
  const changes = []
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i]
    if (line.startsWith('# ')) {
      const space = line.indexOf(' ', 2)
      head[line.slice(2, space)] = line.slice(space + 1)
    } else if (line.startsWith('? ')) {
      changes.push({ s: 'U', p: line.slice(2), new: true })
    } else if (line.startsWith('u ')) {
      changes.push({ s: '!', p: afterSpaces(line, 10) })
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const path = afterSpaces(line, line[0] === '1' ? 8 : 9)
      if (line[0] === '2') i++ // el campo siguiente es la ruta vieja del rename
      if (line[2] !== '.') staged.push({ s: line[2], p: path })
      if (line[3] !== '.') changes.push({ s: line[3], p: path })
    }
  }
  return { head, staged, changes }
}

const status = async (path) => parseStatus(await git(path, 'status', '--porcelain=v2', '--branch', '-z'))

// Con -uall una carpeta nueva se abre archivo por archivo: si no, un .env adentro pasaría sin verse.
async function unstagedFiles(path) {
  const { changes } = parseStatus(await git(path, 'status', '--porcelain=v2', '-z', '-uall'))
  return changes.map((f) => f.p)
}

const withFlag = (files) => files.map((f) => (isSensitive(f.p) ? { ...f, sensitive: true } : f))

const isAncestor = async (path, commit, ref) => (await run(['-C', path, 'merge-base', '--is-ancestor', commit, ref])).code === 0

// Una rama recién sacada de la base también está "contenida" en ella: no es una mergeada. Se distingue por el commit con
// que se creó, el más viejo de su reflog. Sin reflog (una rama traída del remoto) no se puede saber y se trata como propia.
async function hasOwnCommits(path, branch) {
  const created = (await git(path, 'reflog', 'show', '--format=%H', `refs/heads/${branch}`, '--')).trim().split('\n').pop()
  if (!created) return true
  return (await git(path, 'rev-list', '--count', `${created}..HEAD`)).trim() !== '0'
}

// 'remote' si la rama ya está entera en origin/<base>, 'local' si está en la <base> local y falta el push, o null.
async function mergedInto(path, branch, base) {
  if (!(await hasOwnCommits(path, branch))) return null
  if (await isAncestor(path, 'HEAD', `refs/remotes/origin/${base}`)) return 'remote'
  if (await isAncestor(path, 'HEAD', `refs/heads/${base}`)) return 'local'
  return null
}

async function summary(item) {
  const { head, staged, changes } = await status(item.path)
  const root = item.root ?? item.path
  const { blocked, base, deploys = false } = await policy(item.path, root)
  const [ahead = '+0', behind = '-0'] = (head['branch.ab'] ?? '').split(' ')
  const branch = head['branch.head'] ?? '?'
  const upstream = head['branch.upstream'] ?? null
  const detached = branch === '(detached)'
  const offersPr = readPolicy().pullRequests && upstream && !blocked.has(branch) && branch !== base && branch !== '(detached)'
  const isStanding = readPolicy().standing.includes(branch)
  const isFeature = !detached && branch !== base && !blocked.has(branch) && !isStanding
  return {
    key: item.key, name: item.name, group: item.group, color: item.color, branch, base, deploys,
    worktreeOf: item.worktreeOf ?? null, ...commandsFor(root, { isMerging: stopped(item.path), base, isProtected: blocked.has(branch), isStanding }),
    detached, upstream, crossedUpstream: upstream && upstream !== `origin/${branch}` ? upstream : null,
    ticket: detached ? null : ticketOf(root, branch),
    pr: offersPr ? prUrl(await remoteUrl(item.path), branch, base) : null,
    ahead: Number(ahead), behind: -Number(behind), protected: blocked.has(branch),
    merged: isFeature && base ? await mergedInto(item.path, branch, base) : null,
    staged: withFlag(staged), changes: withFlag(changes)
  }
}

async function history(path) {
  const out = await git(path, 'log', '-200', '--format=%h%x1f%an%x1f%ar%x1f%D%x1f%s%x1e')
  return out.split('\x1e').flatMap((rec) => {
    const p = rec.replace(/^\n/, '').split('\x1f')
    return p.length === 5 ? [{ h: p[0], a: p[1], w: p[2], r: p[3], t: p[4] }] : []
  })
}

async function branches(path) {
  const out = await git(path, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)\t%(committerdate:relative)', 'refs/heads', 'refs/remotes')
  const local = []
  const remote = []
  for (const line of out.split('\n')) {
    const [ref, when] = line.split('\t')
    if (ref?.startsWith('refs/heads/')) local.push({ n: ref.slice(11), w: when })
    else if (ref?.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remote.push({ n: ref.slice(13), w: when })
  }
  const names = new Set(local.map((b) => b.n))
  return { local, remote: remote.filter((b) => !names.has(b.n.split('/').slice(1).join('/'))) }
}

async function changedFile(path, rel) {
  const { staged, changes } = await status(path)
  const file = [...staged, ...changes].find((f) => f.p === rel)
  if (!file) throw new ActionError('Ese archivo ya no figura como cambiado.')
  return { isNew: changes.some((f) => f.p === rel && f.new) }
}

async function fileDiff(path, rel, isStaged) {
  const { isNew } = await changedFile(path, rel)
  if (!isStaged && isNew) return (await git(path, 'diff', '--no-index', '--', '/dev/null', rel)).slice(0, MAX_DIFF)
  return (await git(path, 'diff', ...(isStaged ? ['--cached'] : []), '--', rel)).slice(0, MAX_DIFF)
}

async function pushPreview(item) {
  const { path } = item
  const state = await summary(item)
  if (state.protected || state.detached) throw new ActionError(`No se pushea ${state.branch}.`)
  // El push va a origin/<rama> aunque el upstream sea otro, así que la comparación es contra esa rama.
  const own = `refs/remotes/origin/${state.branch}`
  const published = state.crossedUpstream ? !!(await git(path, 'for-each-ref', '--format=%(refname)', own)).trim() : !!state.upstream
  // Una rama sin publicar sube todo lo que tiene por encima de la base.
  const from = !published ? `origin/${state.base}` : state.crossedUpstream ? own : '@{u}'
  const range = `${from}..HEAD`
  const [log, count, files, url, scan] = await Promise.all([
    git(path, 'log', `-${PUSH_PREVIEW}`, '--format=%h%x1f%s', range),
    git(path, 'rev-list', '--count', range),
    git(path, 'log', '--name-only', '--diff-filter=d', '-z', '--format=', range),
    git(path, 'remote', 'get-url', 'origin'),
    scanPush(item.root ?? path, path, `${from}...HEAD`)
  ])
  const touched = files.split('\0').map((f) => f.trim()).filter(Boolean)
  return {
    branch: state.branch,
    isNew: !published,
    deploysBase: state.deploys && state.branch === state.base ? state.base : null,
    crossedUpstream: state.crossedUpstream,
    ticket: state.ticket,
    contentHits: scan.hits,
    scanFailed: scan.failed,
    remote: url.trim().replace(/\/\/[^/@]+@/, '//'), // una URL https puede traer el token adentro
    count: Number(count) || 0,
    commits: log.split('\n').filter(Boolean).map((line) => {
      const [h, t] = line.split('\x1f')
      return { h, t }
    }),
    sensitive: [...new Set(touched.filter(isSensitive))]
  }
}

async function stageAll(path, allow) {
  const files = await unstagedFiles(path)
  const risky = files.filter(isSensitive)
  if (!risky.length || allow === 'all') return write(path, ['add', '-A'])
  if (allow !== 'skip') throw new SensitiveError(risky)
  const rest = files.filter((f) => !isSensitive(f))
  if (rest.length) return write(path, ['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], rest.join('\0'))
}

async function terminalCommand(item, body) {
  const root = item.root ?? item.path
  const { commands, worktrees } = readPolicy()
  const values = { repo: root, path: item.path, branch: '' }
  if (body.command === 'wt-create' || body.command === 'wt-remove') {
    if (!worktrees || !inScope(worktrees, root)) throw new ActionError('Worktrees no configurados para este repo.')
    if (body.command === 'wt-create') {
      const branch = String(body.branch ?? '').trim()
      const valid = await run(['check-ref-format', '--branch', branch])
      if (valid.code !== 0 || branch.startsWith('-')) throw new ActionError('Nombre de rama inválido.')
      return { title: `worktree ${branch}`, command: fillCommand(worktrees.create, { ...values, branch }) }
    }
    if (!item.worktreeOf) throw new ActionError('Esto no es un worktree.')
    const branch = (await git(item.path, 'symbolic-ref', '--short', '-q', 'HEAD')).trim()
    if (branch) return { title: `borrar ${branch}`, command: fillCommand(worktrees.remove, { ...values, branch }) }
    // Detached (un worktree abierto en un commit suelto): el comando configurado borra por rama y acá no hay
    // ninguna, así que va por la ruta. Con cambios, git lo frena salvo que el usuario haya confirmado perderlos.
    const force = body.force === true ? ' --force' : ''
    return { title: `borrar ${item.name}`, command: `git -C ${shellQuote(root)} worktree remove${force} ${shellQuote(item.path)}` }
  }
  const entry = commands[Number(body.command)]
  if (!entry || !inScope(entry, root)) throw new ActionError('Comando desconocido.')
  return { title: `${entry.label} · ${item.name}`, command: `cd ${shellQuote(item.path)} && ${fillCommand(entry.run, values)}` }
}

async function discard(path, rel) {
  const { changes } = await status(path)
  const file = changes.find((f) => f.p === rel)
  if (!file) throw new ActionError('Ese archivo ya no tiene cambios para descartar.')
  if (file.s === '!') throw new ActionError('Tiene conflictos: resolvelo antes de descartar.')
  if (file.new) return write(path, ['--literal-pathspecs', 'clean', '-f', '-d', '--', rel])
  return write(path, ['--literal-pathspecs', 'restore', '--', rel])
}

async function act(item, body) {
  const { path } = item
  const state = await summary(item)
  const locked = state.protected || state.detached
  switch (body.action) {
    case 'stage':
    {
      await changedFile(path, body.path)
      const inside = (await unstagedFiles(path)).filter((f) => f === body.path || (body.path.endsWith('/') && f.startsWith(body.path)))
      const risky = inside.filter(isSensitive)
      if (risky.length && body.allow !== 'all') throw new SensitiveError(risky)
      return write(path, ['add', '--', body.path])
    }
    case 'unstage':
      await changedFile(path, body.path)
      return write(path, ['restore', '--staged', '--', body.path])
    case 'stage_all':
      return stageAll(path, body.allow)
    case 'unstage_all':
      return write(path, ['restore', '--staged', '--', '.'])
    case 'discard':
      return discard(path, body.path)
    case 'commit': {
      const message = String(body.message ?? '').trim()
      if (locked) throw new ActionError(`No se commitea en ${state.branch}: creá una rama desde origin/${state.base}.`)
      if (!state.staged.length) throw new ActionError('No hay archivos en Staged.')
      if (!message) throw new ActionError('Falta el mensaje.')
      return write(path, ['commit', '-F', '-'], message)
    }
    case 'switch': {
      const known = await branches(path)
      if (known.local.some((b) => b.n === body.branch)) return write(path, ['switch', body.branch])
      if (known.remote.some((b) => b.n === body.branch)) return write(path, ['switch', '--track', body.branch])
      throw new ActionError('Esa rama no existe.')
    }
    case 'create_branch': {
      const wanted = String(body.branch ?? '').trim()
      const valid = await run(['check-ref-format', '--branch', wanted])
      if (valid.code !== 0 || wanted.startsWith('-')) throw new ActionError('Nombre de rama inválido.')
      await write(path, ['fetch', 'origin', state.base])
      return write(path, ['switch', '-c', wanted, '--no-track', `origin/${state.base}`])
    }
    case 'fetch':
      return write(path, ['fetch', '--prune', 'origin'])
    case 'pull':
      if (!state.upstream) throw new ActionError('Esta rama todavía no existe en el remoto: no hay nada para traer. Subila con Push.')
      return write(path, ['pull', '--ff-only'])
    case 'push':
      if (locked) throw new ActionError(`No se pushea ${state.branch}.`)
      // Con HEAD, el pre-push recibe 'HEAD' en vez de la rama y no distingue este push de un `HEAD:master`.
      return write(path, ['push', '-u', 'origin', `refs/heads/${state.branch}:refs/heads/${state.branch}`])
    default:
      throw new ActionError('Acción desconocida.')
  }
}

function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (d) => {
      size += d.length
      if (size > MAX_BODY) reject(new ActionError('Pedido demasiado grande.'))
      else chunks.push(d)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Los bots de Orca viven en carpetas con un bot.json; uno que no está abierto como workspace solo se ve acá.
const BOTS_DIR = join(HOME, '.orca/bots')

function botDirs() {
  if (!existsSync(BOTS_DIR)) return []
  return readdirSync(BOTS_DIR, { withFileTypes: true }).flatMap((e) => {
    if (!e.isDirectory()) return []
    const path = join(BOTS_DIR, e.name)
    const bot = readJson(join(path, 'bot.json'))
    return bot ? [{ name: typeof bot.name === 'string' && bot.name ? bot.name : e.name, path }] : []
  })
}

const ORCA = { worktrees: orcaWorktrees, sessions: openSessions, bots: botDirs, focus: focusTerminal, activate: activateWorktree, launchChat, createWorkspaceChat }

export function startServer({ port = 0, idleMs = 0, onIdle, terminal = openTerminal, orca = ORCA, jiraFetch = fetch, startsFile = cachePath('jira-arranques.json') } = {}) {
  const token = process.env.MRG_TOKEN ?? randomBytes(32).toString('base64url')
  // Se lee una sola vez: si el plugin se actualiza, un servidor viejo no debe servir una página que no sabe atender.
  const page = readFileSync(INDEX)
  const assets = Object.fromEntries(Object.keys(ASSETS).map((path) => [path, readFileSync(fileURLToPath(new URL(`.${path}`, import.meta.url)))]))
  const queues = new Map()
  const summaries = new Map()
  let lastUse = Date.now()
  let lastFetch = 0
  let pitwall = null
  let jira = null
  let jiraLoading = null
  let remoteRefs = null

  async function pitwallSnapshot() {
    if (pitwall && Date.now() - pitwall.at < PITWALL_CACHE_MS) return pitwall.data
    let data
    try {
      const [worktrees, sessions] = await Promise.all([orca.worktrees(), orca.sessions()])
      data = buildSnapshot(worktrees, Date.now(), sessions, orca.bots())
    } catch (e) {
      // Sin Orca no hay sesiones, pero la parte de git sigue andando: la pestaña muestra el aviso.
      data = { ...buildSnapshot([], Date.now()), error: `No pude leer Orca: ${e.message}` }
    }
    pitwall = { at: Date.now(), data }
    return data
  }

  // Tus tickets, de la caché si es reciente. Si Jira falla, queda lo último que respondió, con el error.
  async function jiraIssues(cfg) {
    const id = `${cfg.site}|${cfg.project}|${cfg.credentials}`
    if (jira?.id === id && Date.now() - jira.at < JIRA_CACHE_MS) return jira
    jiraLoading ??= fetchMyIssues(cfg, jiraFetch).then(
      (issues) => { jira = { id, at: Date.now(), fetchedAt: Date.now(), issues, error: null } },
      (e) => {
        const prev = jira?.id === id ? jira : null
        jira = { id, at: Date.now(), fetchedAt: prev?.fetchedAt ?? null, issues: prev?.issues ?? [], error: e.message }
      }
    ).finally(() => { jiraLoading = null })
    await jiraLoading
    return jira
  }

  // Las ramas de origin de cada repo, tal como quedaron del último fetch. Solo lectura.
  async function ticketRemotes() {
    if (remoteRefs && Date.now() - remoteRefs.at < REMOTE_REFS_MS) return remoteRefs.data
    const roots = listRepos().filter((r) => !r.worktreeOf)
    const data = await Promise.all(roots.map(async (r) => ({
      repo: r.name,
      branches: (await git(r.path, 'for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin')).split('\n').filter(Boolean)
    })))
    remoteRefs = { at: Date.now(), data }
    return data
  }

  async function jiraView() {
    const cfg = readPolicy().jira
    if (!cfg) return { enabled: false }
    const state = await jiraIssues(cfg)
    let worktrees = []
    let open = new Set()
    try {
      ;[worktrees, open] = await Promise.all([orca.worktrees(), orca.sessions().catch(() => new Set())])
    } catch {
      // Sin Orca no se sabe qué tickets tienen workspace; la lista sale igual.
    }
    let remotes = []
    try {
      remotes = await ticketRemotes()
    } catch {
      // Sin la lista de repos no se marca "rama pusheada"; lo demás sale igual.
    }
    const all = jiraRows(state.issues, { site: cfg.site, worktrees, open, remembered: readStarts(), extra: (key) => ({ ...harnessOf(cfg.tickets, key), pushed: pushedIn(key, remotes) }) })
    const issues = visibleRows(all, cfg.hideStatuses)
    const sections = jiraSections(issues, { order: cfg.sections, staleDays: cfg.staleDays })
    return { enabled: true, project: cfg.project, fetchedAt: state.fetchedAt, error: state.error, staleDays: cfg.staleDays, issues, sections, allKeys: all.map((t) => t.key) }
  }

  // Lo que hace falta para arrancar un ticket en un repo: la rama nueva, de qué base sale y el primer mensaje. No escribe
  // nada: el worker crea el workspace con esto, después de que confirmás.
  async function jiraStartPlan(key, repoKey) {
    const cfg = readPolicy().jira
    if (!cfg) throw new ActionError('Jira no está configurado.')
    const issue = await myIssue(cfg, key)
    const item = listRepos().find((r) => r.key === repoKey && !r.worktreeOf)
    if (!item) throw new ActionError('Repo desconocido.')
    const { base, blocked } = await policy(item.path)
    const title = issue.fields?.summary ?? key
    const branch = branchFor(key, title)
    if (branch === base || blocked.has(branch)) throw new ActionError('Esa rama está protegida.')
    const refs = (await git(item.path, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin')).split('\n').filter(Boolean)
    if (!refs.includes(`refs/remotes/origin/${base}`)) throw new ActionError(`No encuentro origin/${base} en ${item.name}: hacé fetch.`)
    if (refs.includes(`refs/heads/${branch}`) || refs.includes(`refs/remotes/origin/${branch}`)) throw new ActionError(`La rama ${branch} ya existe en ${item.name}.`)
    const same = new RegExp(`^${key}(?:-|$)`, 'i')
    const existing = refs.map((r) => r.replace(/^refs\/(heads|remotes)\//, '')).filter((b) => same.test(b.replace(/^origin\//, '')))
    return {
      key, title, repo: item.name, group: item.group ?? '', path: item.path, base, baseRef: `origin/${base}`, branch, existing, agent: cfg.agent,
      prompt: promptFor(cfg, key, title)
    }
  }

  async function myIssue(cfg, key) {
    if (!JIRA_KEY_RE.test(key ?? '')) throw new ActionError('Ticket inválido.')
    const issue = (await jiraIssues(cfg)).issues.find((i) => i.key === key)
    if (!issue) throw new ActionError('Ese ticket no está entre los tuyos.')
    return issue
  }

  const promptFor = (cfg, key, title) => fillPrompt(cfg.startPrompt, { key, title, url: `${cfg.site}/browse/${key}` })

  async function jiraTargetList() {
    const [worktrees, open] = await Promise.all([orca.worktrees(), orca.sessions().catch(() => new Set())])
    return jiraTargets(worktrees, listRepos(), open)
  }

  // Dónde arrancaste cada ticket desde el panel: { clave: [{ worktreeId, sessionId, at }] }. Sobrevive a un reinicio.
  const readStarts = () => readJson(startsFile) ?? {}
  function remember(key, worktreeId, sessionId) {
    try {
      mkdirSync(dirname(startsFile), { recursive: true })
      writeFileSync(startsFile, JSON.stringify(rememberStart(readStarts(), key, { worktreeId, sessionId: sessionId ?? null, at: Date.now() })))
    } catch (e) {
      console.error(`no pude recordar dónde arrancó ${key}: ${e.message}`) // el chat ya está abierto: se pierde solo el atajo
    }
  }

  // Un chat nativo nuevo en un workspace que ya está abierto. No crea ramas ni toca git.
  // `place`: jiraOpen ya comprobó que el workspace es uno del ticket.
  async function jiraChat({ key, worktreeId } = {}, place = false) {
    const cfg = readPolicy().jira
    if (!cfg) throw new ActionError('Jira no está configurado.')
    const issue = await myIssue(cfg, key)
    const known = place || (await jiraTargetList()).some((p) => p.workspaces.some((w) => w.worktreeId === worktreeId))
    if (!known) throw new ActionError('Ese workspace ya no está en Orca.')
    let result
    try {
      result = await orca.launchChat({ worktreeId, agent: cfg.agent, prompt: promptFor(cfg, key, issue.fields?.summary ?? key) })
    } catch (e) {
      throw new ActionError(`Orca no pudo abrir el chat: ${String(e.message).slice(0, CLI_REASON_MAX)}`)
    }
    remember(key, worktreeId, result.sessionId)
    return { action: 'chat', surface: result.surface, detail: result.detail }
  }

  // Clic en un ticket que ya está en Orca: si ese workspace tiene un chat abierto, lo muestra (Orca no deja elegir qué
  // pestaña de chat: abre el workspace); si solo tiene terminales o nada, abre ahí un chat nativo nuevo.
  async function jiraOpen({ key, worktreeId } = {}) {
    const cfg = readPolicy().jira
    if (!cfg) throw new ActionError('Jira no está configurado.')
    await myIssue(cfg, key)
    const [worktrees, open] = await Promise.all([orca.worktrees(), orca.sessions().catch(() => new Set())])
    const place = sessionsOf(key, worktrees, open, readStarts()[key] ?? []).find((p) => p.worktreeId === worktreeId)
    if (!place) throw new ActionError('Ese workspace ya no está en Orca.')
    if (!place.chats) return jiraChat({ key, worktreeId }, true)
    try {
      await orca.activate(worktreeId)
    } catch (e) {
      console.error(`worktree.activate falló: ${e.message}`)
      throw new ActionError(`Orca no pudo abrir el workspace: ${String(e.message).slice(0, CLI_REASON_MAX)}`)
    }
    return { action: 'opened' }
  }

  // Workspace nuevo con la rama del ticket desde origin/<base>, y el chat ahí. El plan se vuelve a armar acá.
  async function jiraNewWorkspace({ key, repo } = {}) {
    const plan = await jiraStartPlan(key, repo)
    let result
    try {
      result = await orca.createWorkspaceChat({ path: plan.path, branch: plan.branch, baseRef: plan.baseRef, agent: plan.agent, prompt: plan.prompt })
    } catch (e) {
      throw new ActionError(`Orca no pudo crear el workspace: ${String(e.message).slice(0, CLI_REASON_MAX)}`)
    }
    try {
      const made = (await orca.worktrees()).find((w) => String(w.branch ?? '').replace(/^refs\/heads\//, '') === plan.branch)
      if (made) remember(key, made.worktreeId, result.sessionId)
    } catch {
      // Orca no respondió la lista: el ticket se reconoce igual por la rama.
    }
    return { action: 'chat', surface: result.surface, detail: result.detail, branch: plan.branch }
  }

  // Solo lleva a una sesión o a un workspace que Orca acaba de listar: el id viene de la página.
  async function openInOrca(body) {
    const known = (await orca.worktrees()).find((w) => w.worktreeId === body.worktreeId)
    if (!known) throw new ActionError('Ese workspace ya no está en Orca.')
    const terminal = isTerminal(body.terminalId) && known.agents?.some((a) => a.address === body.terminalId) ? body.terminalId : null
    if (terminal) {
      try {
        await orca.focus(terminal)
        return
      } catch {
        // La terminal se cerró entre la consulta y el clic: se abre el workspace.
      }
    }
    await orca.activate(known.worktreeId)
  }

  // Vence la consulta pero conserva changedAt: si no, todos los repos pasarían a contar como activos.
  function expireSummaries() {
    for (const known of summaries.values()) known.at = 0
  }

  async function freshSummary(item) {
    const known = summaries.get(item.key)
    const now = Date.now()
    if (known && now - known.at < QUIET_CHECK_MS && now - known.changedAt >= ACTIVE_MS) return known.data
    const data = await summary(item)
    const same = known && JSON.stringify(known.data) === JSON.stringify(data)
    summaries.set(item.key, { data, at: now, changedAt: same ? known.changedAt : now })
    return data
  }

  async function fetchAll() {
    if (Date.now() - lastFetch < FETCH_EVERY_MS) return { skipped: true }
    lastFetch = Date.now()
    const items = listRepos()
    let failed = 0
    async function worker() {
      for (let item = items.shift(); item; item = items.shift()) {
        const { path, key } = item
        const { code } = await inOrder(key, () => run(['-C', path, 'fetch', '--quiet', 'origin'], { env: WRITE_ENV, timeout: FETCH_MS }))
        if (code !== 0) failed++
      }
    }
    await Promise.all(Array.from({ length: FETCH_AT_ONCE }, worker))
    expireSummaries()
    return { failed }
  }

  // Dos acciones sobre un mismo repo se pisarían en el index de git.
  function inOrder(key, task) {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task)
    queues.set(key, next)
    return next
  }

  function reply(res, code, body, type = 'application/json') {
    const data = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
    })
    res.end(data)
  }

  function repoOf(key) {
    const item = listRepos().find((r) => r.key === key)
    if (!item) throw new ActionError('Repo desconocido.')
    return item
  }

  async function get(req, res, url, allowedHost) {
    const q = url.searchParams
    if (url.pathname === '/') {
      if (!allowedHost || !sameToken(q.get('t'), token)) return reply(res, 403, 'Falta el token', 'text/plain')
      lastUse = Date.now()
      return reply(res, 200, page, 'text/html; charset=utf-8')
    }
    if (ASSETS[url.pathname]) return allowedHost ? reply(res, 200, assets[url.pathname], ASSETS[url.pathname]) : reply(res, 403, 'Host', 'text/plain')
    if (!allowedHost || !sameToken(req.headers['x-token'], token)) return reply(res, 403, { error: 'token' })
    lastUse = Date.now()
    if (url.pathname === '/api/ping') return reply(res, 200, { ok: true })
    if (url.pathname === '/api/pitwall') return reply(res, 200, await pitwallSnapshot())
    if (url.pathname === '/api/jira') return reply(res, 200, await jiraView())
    if (url.pathname === '/api/jira-start') return reply(res, 200, await jiraStartPlan(q.get('key'), q.get('repo')))
    if (url.pathname === '/api/jira-targets') return reply(res, 200, { projects: await jiraTargetList().catch(() => { throw new ActionError('No pude leer los workspaces de Orca.') }) })
    if (url.pathname === '/api/repos') {
      if (q.get('fresh') === '1') expireSummaries()
      const items = []
      for (const r of listRepos()) items.push(await freshSummary(r))
      return reply(res, 200, items)
    }
    const item = repoOf(q.get('repo'))
    const { path } = item
    if (url.pathname === '/api/push') return reply(res, 200, await pushPreview(item))
    if (url.pathname === '/api/history') return reply(res, 200, await history(path))
    if (url.pathname === '/api/branches') return reply(res, 200, await branches(path))
    if (url.pathname === '/api/diff') return reply(res, 200, { diff: await fileDiff(path, q.get('path'), q.get('staged') === '1') })
    if (url.pathname === '/api/commit') {
      const hash = q.get('h') ?? ''
      if (!HASH_RE.test(hash)) throw new ActionError('Commit inválido.')
      return reply(res, 200, { diff: (await gitChecked(path, 'show', '--stat', '--patch', hash)).slice(0, MAX_DIFF) })
    }
    return reply(res, 404, { error: 'no existe' })
  }

  async function post(req, res, url, allowedHost) {
    if (!allowedHost || !sameToken(req.headers['x-token'], token)) return reply(res, 403, { error: 'token' })
    lastUse = Date.now()
    if (req.headers['content-type'] !== 'application/json') throw new ActionError('Pedido inválido.')
    if (url.pathname === '/api/fetch-all') return reply(res, 200, await fetchAll())
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (e) {
      throw e instanceof ActionError ? e : new ActionError('Pedido inválido.')
    }
    if (url.pathname === '/api/open') {
      try {
        await openInOrca(body)
      } catch (e) {
        throw e instanceof ActionError ? e : new ActionError('Orca no pudo abrirlo.')
      }
      return reply(res, 200, { ok: true })
    }
    if (url.pathname === '/api/jira-chat') return reply(res, 200, await jiraChat(body))
    if (url.pathname === '/api/jira-open') return reply(res, 200, await jiraOpen(body))
    if (url.pathname === '/api/jira-new') return reply(res, 200, await jiraNewWorkspace(body))
    const item = repoOf(body.repo)
    if (url.pathname === '/api/run') {
      const { title, command } = await terminalCommand(item, body)
      try {
        await terminal({ title, command, floating: readPolicy().floating })
      } catch {
        throw new ActionError('No pude abrir la terminal de Orca.')
      }
      return reply(res, 200, { ok: true })
    }
    summaries.delete(item.key)
    await inOrder(item.key, () => act(item, body))
    summaries.delete(item.key)
    return reply(res, 200, { ok: true })
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const { port: actual } = server.address()
      const allowedHost = [`127.0.0.1:${actual}`, `localhost:${actual}`].includes(req.headers.host)
      const handler = req.method === 'POST' ? post(req, res, url, allowedHost) : get(req, res, url, allowedHost)
      handler.catch((e) => {
        if (res.headersSent) return
        if (e instanceof ActionError) reply(res, e.status ?? 400, { error: e.message, ...e.extra })
        else reply(res, 500, { error: 'Error interno' })
      })
    })
    server.on('error', reject)
    if (idleMs > 0) {
      setInterval(() => {
        if (Date.now() - lastUse > idleMs) onIdle?.()
      }, Math.min(idleMs, 30_000)).unref()
    }
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, token, close: () => server.close() }))
  })
}
