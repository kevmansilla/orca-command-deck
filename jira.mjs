// Tus tickets de Jira: consulta de solo lectura, con caché, y la lógica para mostrarlos y avisar los nuevos.
// Lo de armar filas y detectar nuevos es puro, para que test.mjs lo pruebe con datos inventados.
import { readFileSync } from 'node:fs'
import { flatten, isTerminal } from './pitwall.mjs'

const BRIEF_MAX = 220
// Un párrafo todo en negrita y corto es un rótulo de sección ("Ejemplo", "Límites"), no la descripción.
const LABEL_MAX = 80
const MIN_LINE = 4
const MAX_RESULTS = 100
const STALE_DAYS = 90
const DAY_MS = 86_400_000
const IN_PROGRESS = 'En curso'
const FIELDS = 'summary,status,description,updated'
export const JIRA_TIMEOUT_MS = 20_000
const PROJECT_RE = /^[A-Z][A-Z0-9_]{0,19}$/
const AGENT_RE = /^[a-z][a-z0-9-]{0,30}$/
const DEFAULT_PROMPT = 'Arrancamos {key}: {title}. Leé el ticket en Jira: {url}'
const SITE_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i
// Como en el harness: la traba está abierta mientras su línea ⛔ siga en el archivo.
const BLOCKER_RE = /^\s*(?:[-*]\s*)?⛔\s*\**\s*Decisi[oó]n de negocio\s*\**\s*:\s*\**\s*(.+?)\s*$/m
export const BLOCKER_FILES = ['roadmap.md', 'US.md']
const SLUG_MAX = 40

// La configuración de `jira` en policy.json, validada. Sin ella (o inválida), no hay pestaña Jira.
export function jiraConfig(raw, expand = (p) => p) {
  if (!raw || typeof raw !== 'object') return null
  const site = String(raw.site ?? '').replace(/\/+$/, '')
  const project = String(raw.project ?? '')
  if (!SITE_RE.test(site) || !PROJECT_RE.test(project) || typeof raw.credentials !== 'string') return null
  return {
    site,
    project,
    credentials: expand(raw.credentials),
    // La carpeta de tickets del harness: trabas de negocio y estado del desarrollo. Opcional.
    tickets: typeof raw.tickets === 'string' ? expand(raw.tickets) : null,
    // El primer mensaje del agente al arrancar un ticket: {key}, {title} y {url}.
    startPrompt: typeof raw.startPrompt === 'string' && raw.startPrompt.trim() ? raw.startPrompt : DEFAULT_PROMPT,
    agent: AGENT_RE.test(raw.agent ?? '') ? raw.agent : 'claude',
    // Estados que no se muestran (los Done nunca vienen).
    hideStatuses: names(raw.hideStatuses) ?? ['Testing'],
    // Estados que van en su propia sección, después de «En curso» y en este orden. Sin lista, los de categoría «new».
    sections: names(raw.sections),
    // Lo que no se actualiza hace más de esto va al final de su sección, plegado.
    staleDays: Number.isFinite(raw.staleDays) && raw.staleDays > 0 ? raw.staleDays : STALE_DAYS
  }
}

const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : null)
const sameName = (list, name) => list.some((x) => x.toLowerCase() === String(name ?? '').toLowerCase())

// Saca los tickets en un estado oculto.
export const visibleRows = (rows, hide) => rows.filter((r) => !sameName(hide, r.status))

// Las secciones del panel: «En curso» (lo que no está en una sección propia, o tiene workspace en Orca) y una por
// estado de `order`, en ese orden. Dentro, lo más reciente primero, y lo viejo aparte.
export function jiraSections(rows, { order = null, staleDays = STALE_DAYS, now = Date.now() } = {}) {
  const own = order ?? [...new Set(rows.filter((r) => r.category === 'new').map((r) => r.status))]
  const byId = new Map([[IN_PROGRESS, []], ...own.map((n) => [n.toLowerCase(), []])])
  for (const r of rows) {
    const id = !r.sessions.length && sameName(own, r.status) ? String(r.status).toLowerCase() : IN_PROGRESS
    byId.get(id).push(r)
  }
  const limit = now - staleDays * DAY_MS
  return [IN_PROGRESS, ...own].flatMap((title) => {
    const list = byId.get(title === IN_PROGRESS ? title : title.toLowerCase()).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    if (!list.length) return []
    const old = (r) => !r.sessions.length && r.updated != null && r.updated < limit
    return [{ id: title, title, keys: list.filter((r) => !old(r)).map((r) => r.key), staleKeys: list.filter(old).map((r) => r.key) }]
  })
}

// Un .env simple: CLAVE=valor, con comillas o `export` opcionales.
export function parseEnv(text) {
  const env = {}
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i.exec(line)
    if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return env
}

function inlineText(node) {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return ' '
  if (node.type === 'mention' || node.type === 'emoji' || node.type === 'status' || node.type === 'date') return node.attrs?.text ?? node.attrs?.shortName ?? ''
  if (node.type === 'inlineCard') return node.attrs?.url ?? ''
  return (node.content ?? []).map(inlineText).join('')
}

const allBold = (node) => (node.content ?? []).filter((c) => c.type === 'text' && c.text?.trim()).every((c) => c.marks?.some((m) => m.type === 'strong'))

// Las líneas de texto de un documento ADF, en orden, marcando cuáles son rótulos.
export function adfLines(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'codeBlock' || node.type === 'mediaSingle' || node.type === 'media') return out
  if (node.type === 'paragraph' || node.type === 'heading') {
    const text = inlineText(node).replace(/\s+/g, ' ').trim()
    if (text) out.push({ text, label: node.type === 'heading' || (allBold(node) && text.length <= LABEL_MAX) })
    return out
  }
  for (const child of node.content ?? []) adfLines(child, out)
  return out
}

// Qué hay que hacer, en pocas palabras: las primeras líneas útiles de la descripción, en texto plano y recortadas.
export function briefOf(description, max = BRIEF_MAX) {
  const lines = typeof description === 'string'
    ? description.split('\n').map((t) => ({ text: t.trim(), label: false }))
    : adfLines(description)
  const parts = []
  let size = 0
  for (const line of lines) {
    if (line.label || line.text.length < MIN_LINE) continue
    parts.push(line.text)
    size += line.text.length
    if (size >= max) break
  }
  return flatten(parts.join(' '), max)
}

const keyRe = (key) => new RegExp(`(?:^|[^A-Z0-9])${key}(?![0-9])`, 'i')

// Los workspaces de Orca cuya rama o nombre llevan la clave del ticket: ahí lo estás trabajando.
export function sessionsOf(key, worktrees) {
  const re = keyRe(key)
  return worktrees.filter((w) => !w.isArchived && !w.bot && (re.test(String(w.branch ?? '').replace(/^refs\/heads\//, '')) || re.test(String(w.displayName ?? ''))))
    .map((w) => {
      const agents = (w.agents ?? []).filter((a) => isTerminal(a.address))
      const pick = agents.find((a) => a.state === 'working') ?? agents[0]
      return {
        worktreeId: w.worktreeId,
        path: w.path ?? null,
        name: w.displayName || String(w.branch ?? '').replace(/^refs\/heads\//, '') || key,
        terminalId: pick?.address ?? null,
        agentWorking: agents.some((a) => a.state === 'working' && !a.interrupted)
      }
    })
}

// La traba de negocio abierta en un archivo del ticket, o null.
export function blockerIn(text) {
  const m = BLOCKER_RE.exec(text ?? '')
  return m ? flatten(m[1].replace(/\*\*/g, ''), BRIEF_MAX) : null
}

// Los repos donde ya está pusheada una rama del ticket (`origin/ABC-1-algo`), según el último fetch.
export function pushedIn(key, remotes) {
  const re = new RegExp(`^${key}(?:-|$)`, 'i')
  return remotes.filter((r) => r.branches.some((b) => re.test(b))).map((r) => r.repo)
}

// "Arreglar el envío de mails" → "arreglar-el-envio-de-mails", corto y apto para una rama.
export function slugOf(title, max = SLUG_MAX) {
  const words = String(title ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  let slug = ''
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w
    if (next.length > max) break
    slug = next
  }
  return slug || (words[0] ?? '').slice(0, max)
}

export const branchFor = (key, title) => [key, slugOf(title)].filter(Boolean).join('-')

export const fillPrompt = (template, values) => String(template).replace(/\{(key|title|url)\}/g, (_, k) => values[k] ?? '')

// Las filas que ve el panel: con sesión en Orca primero, después lo más reciente.
// `extra(key)` suma lo que sale del disco: la traba de negocio, el estado del harness y dónde está pusheada.
export function jiraRows(issues, { site, worktrees = [], extra = () => ({}) }) {
  const rows = issues.map((it) => {
    const f = it.fields ?? {}
    const sessions = sessionsOf(it.key, worktrees)
    return {
      key: it.key,
      title: f.summary ?? it.key,
      status: f.status?.name ?? null,
      category: f.status?.statusCategory?.key ?? null,
      updated: f.updated ? Date.parse(f.updated) || null : null,
      brief: briefOf(f.description),
      url: `${site}/browse/${it.key}`,
      sessions,
      blocker: null,
      harness: null,
      pushed: [],
      ...extra(it.key)
    }
  })
  return rows.sort((a, b) => (b.sessions.length > 0) - (a.sessions.length > 0) || (b.updated ?? 0) - (a.updated ?? 0))
}

// Los tickets que aparecieron desde la vuelta anterior. `known` es { clave: cuándo se vio por primera vez }; en la
// primera vuelta (null) se toma nota sin avisar. Un ticket que deja de estar asignado sale de la lista, así que si
// te lo vuelven a asignar avisa de nuevo.
export function jiraNews(known, keys, now) {
  const next = {}
  const fresh = []
  for (const key of keys) {
    if (known && !(key in known)) {
      next[key] = now
      fresh.push(key)
    } else {
      next[key] = known?.[key] ?? 0
    }
  }
  return { known: next, fresh }
}

// GET de solo lectura a la búsqueda de Jira. El token viaja solo en el encabezado: nunca en la URL ni en un error.
export async function fetchMyIssues(config, fetchImpl = fetch) {
  let env
  try {
    env = parseEnv(readFileSync(config.credentials, 'utf8'))
  } catch {
    throw new Error('No pude leer el archivo de credenciales de Jira.')
  }
  if (!env.JIRA_EMAIL || !env.JIRA_TOKEN) throw new Error('Al archivo de credenciales le faltan JIRA_EMAIL o JIRA_TOKEN.')
  const auth = `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`).toString('base64')}`
  const jql = `project = ${config.project} AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`
  const url = `${config.site}/rest/api/3/search/jql?${new URLSearchParams({ jql, fields: FIELDS, maxResults: String(MAX_RESULTS) })}`
  let r
  try {
    r = await fetchImpl(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(JIRA_TIMEOUT_MS) })
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? 'Jira no respondió a tiempo.' : 'No pude conectarme con Jira.')
  }
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `Jira rechazó las credenciales (${r.status}).` : `Jira respondió ${r.status}.`)
  const data = await r.json()
  return Array.isArray(data?.issues) ? data.issues.filter((it) => typeof it?.key === 'string') : []
}
