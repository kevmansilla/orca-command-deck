// Worker del plugin: asegura que la app local esté corriendo y le hace de puente al panel lateral, que no puede
// conectarse a nada: el panel le pide `api` y el worker se lo pasa al servidor.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { jiraNews } from './jira.mjs'
import { addNotice, chatNotices, NEEDS_YOU, statusBarOf } from './pitwall.mjs'
import { readState, serverStamp } from './state.mjs'

const DAEMON = fileURLToPath(new URL('./daemon.mjs', import.meta.url))
const START_TRIES = 50
const API_PATH_RE = /^\/api\/[a-z-]+(\?[^\s#]*)?$/
const TERMINAL_RE = /^term_[\w-]+$/
// Igual que en app.js: la campana del panel guarda acá si se avisa, y la pestaña Avisos lee la bandeja.
const NOTIFY_KEY = 'notify'
const NOTICES_KEY = 'avisos'
const NOTICES_READ_KEY = 'avisosLeidos'
const STATUS_ITEM = 'avisos'
// Cada cuánto se miran los chats sin terminal (bots y chats nativos), que no llegan por el evento.
const CHAT_POLL_MS = 15000
// Los tickets de Jira: el servidor consulta Jira como mucho cada 5 min, esto solo mira su caché.
const JIRA_POLL_MS = 60000
// Igual que en app.js: { clave: cuándo apareció } de tus tickets, para avisar y marcar los nuevos.
const JIRA_KNOWN_KEY = 'jiraConocidos'

async function alive(state) {
  if (!state) return false
  try {
    const r = await fetch(`http://127.0.0.1:${state.port}/api/ping`, { headers: { 'X-Token': state.token } })
    return r.ok
  } catch {
    return false // un puerto cerrado significa que ese servidor ya se apagó
  }
}

const responds = async (state) => state?.stamp === serverStamp() && (await alive(state))

// Solo se apaga si responde con su token: el pid de un servidor caído pudo pasar a otro proceso.
async function retire(state) {
  if (!(await alive(state))) return
  try {
    process.kill(state.pid, 'SIGTERM') // un servidor de otra versión no debe seguir atendiendo pestañas viejas
  } catch {
    // se apagó entre la consulta y la señal
  }
}

async function ensureServer() {
  const current = readState()
  if (current?.managed && (await alive(current))) return current // el servicio se actualiza solo
  if (await responds(current)) return current
  await retire(current)
  spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', env: process.env }).unref()
  for (let i = 0; i < START_TRIES; i++) {
    await sleep(100)
    const state = readState()
    if (await responds(state)) return state
  }
  throw new Error('el servidor de la app no arrancó')
}

let server = null

async function callServer(state, path, body) {
  const init = body == null
    ? { headers: { 'X-Token': state.token } }
    : { method: 'POST', headers: { 'X-Token': state.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const r = await fetch(`http://127.0.0.1:${state.port}${path}`, init)
  return { status: r.status, data: await r.json() }
}

// Si el servidor se reinició (una actualización, el servicio), se vuelve a buscar una vez.
async function relay({ path, body } = {}) {
  if (typeof path !== 'string' || !API_PATH_RE.test(path)) throw Object.assign(new Error('Ruta inválida.'), { code: 'invalid_params' })
  server ??= await ensureServer()
  try {
    return await callServer(server, path, body)
  } catch (e) {
    // Solo si no hubo conexión: reintentar un POST que llegó podría hacer el commit dos veces.
    if (e?.cause?.code !== 'ECONNREFUSED') throw e
    server = await ensureServer()
    return callServer(server, path, body)
  }
}

// Lleva al usuario a una sesión o a un workspace. Va por la API de plugins y no por el servidor porque el socket de Orca
// no activa workspaces de tipo carpeta (los bots), y `workspace.open` sí.
async function openInOrca(orca, { terminalId, path } = {}) {
  if (typeof terminalId === 'string' && TERMINAL_RE.test(terminalId)) {
    try {
      const { focused } = await orca.host.call('terminal.focus', { terminalId })
      if (focused) return { ok: true }
    } catch (e) {
      orca.log(`terminal.focus falló, abro el workspace: ${e.message}`) // la terminal se cerró entre la consulta y el clic
    }
  }
  const { workspaces } = await orca.host.call('workspace.list')
  const workspace = typeof path === 'string' ? workspaces.find((w) => w.path === path) : null
  if (!workspace) throw Object.assign(new Error('Ese workspace ya no está en Orca.'), { code: 'invalid_params' })
  await orca.host.call('workspace.open', { workspaceId: workspace.id })
  return { ok: true }
}

// Avisa una vez por cada vez que una sesión pasa a necesitarte: Orca puede repetir el mismo estado.
export function shouldNotify(last, event) {
  const before = last.get(event.paneKey)
  last.set(event.paneKey, event.state)
  return !!NEEDS_YOU[event.state] && before !== event.state
}

async function whereOf(orca, workspaceListId) {
  try {
    const { workspaces } = await orca.host.call('workspace.list')
    const ws = workspaces.find((w) => w.id === workspaceListId)
    if (!ws) return { where: null, path: null }
    return { where: ws.project && ws.project !== ws.name ? `${ws.project} › ${ws.name}` : ws.name, path: ws.path ?? null }
  } catch (e) {
    orca.log(`no pude leer los workspaces para el aviso: ${e.message}`) // el aviso sale igual, sin el lugar
    return { where: null, path: null }
  }
}

// Guarda el aviso en la bandeja del panel (siempre) y lo muestra en el escritorio (si la campana está prendida).
// Las escrituras van en fila: dos avisos juntos no se pisan la bandeja.
let saving = Promise.resolve()
function deliver(orca, notice) {
  saving = saving.then(async () => {
    const list = await orca.storage.get(NOTICES_KEY).catch(() => null)
    await orca.storage.set(NOTICES_KEY, addNotice(list, notice))
  }).catch((e) => orca.log(`no pude guardar el aviso: ${e.message}`))
  return saving.then(async () => {
    await paintStatusBar(orca)
    if ((await orca.storage.get(NOTIFY_KEY)) === false) return
    const body = [notice.where, notice.body].filter(Boolean).join(' · ')
    await orca.host.call('notifications.show', { title: notice.title, body: body || undefined })
  })
}

// Lo que no leíste, en la barra de estado de Orca. Tenerla hace además que Orca no apague el worker por inactividad.
let painted = ''
async function paintStatusBar(orca) {
  try {
    const [list, read] = await Promise.all([orca.storage.get(NOTICES_KEY), orca.storage.get(NOTICES_READ_KEY)])
    const item = statusBarOf(list, typeof read === 'number' ? read : 0)
    const next = JSON.stringify(item)
    if (next === painted) return
    await orca.host.call('statusBar.update', { id: STATUS_ITEM, ...item })
    painted = next
  } catch (e) {
    orca.log(`no pude actualizar la barra de estado: ${e.message}`)
  }
}

// El clic en la barra de estado: lleva a la sesión del último aviso y los da por leídos.
async function openLatestNotice(orca) {
  const list = await orca.storage.get(NOTICES_KEY)
  const latest = Array.isArray(list) ? list[0] : null
  if (!latest) return
  await orca.storage.set(NOTICES_READ_KEY, latest.at)
  await paintStatusBar(orca)
  if (!latest.terminalId && !latest.path) return // un ticket nuevo de Jira no tiene sesión: se ve en el panel
  try {
    await openInOrca(orca, { terminalId: latest.terminalId, path: latest.path })
  } catch (e) {
    orca.log(`no pude abrir el aviso: ${e.message}`) // la sesión ya no está: el aviso queda leído igual
  }
}

async function noticeOfEvent(orca, event) {
  const { where, path } = await whereOf(orca, event.workspaceListId)
  return {
    id: `${event.paneKey}|${event.state}|${event.receivedAt}`,
    at: Date.now(),
    state: event.state,
    bot: false,
    title: `${event.title || 'Una sesión'} ${NEEDS_YOU[event.state]}`,
    where,
    body: null,
    path,
    terminalId: event.terminalId ?? null
  }
}

// Mira el Pit Wall cada tanto para avisar de los chats sin terminal, que el evento no cubre.
function watchChats(orca) {
  const since = Date.now()
  let seen = null
  const tick = async () => {
    try {
      const { status, data } = await relay({ path: '/api/pitwall' })
      if (status !== 200 || data?.error) return // sin datos de Orca no se compara: se perdería el estado anterior
      const result = chatNotices(seen, data, Date.now(), since)
      seen = result.seen
      for (const notice of result.notices) await deliver(orca, notice)
      await paintStatusBar(orca) // también refleja lo que leíste en el panel
    } catch (e) {
      orca.log(`no pude mirar los chats: ${e.message}`)
    }
  }
  tick()
  setInterval(tick, CHAT_POLL_MS)
}

// Avisa una vez por cada ticket que te asignan: lo que aparece en la lista y no estaba en la vuelta anterior.
function watchJira(orca) {
  const tick = async () => {
    try {
      const { status, data } = await relay({ path: '/api/jira' })
      // Sin Jira, o con un error (la lista puede ser vieja o estar vacía), no se compara.
      if (status !== 200 || !data?.enabled || data.error) return
      const known = await orca.storage.get(JIRA_KNOWN_KEY)
      const now = Date.now()
      const result = jiraNews(known && typeof known === 'object' && !Array.isArray(known) ? known : null, data.issues.map((t) => t.key), now)
      await orca.storage.set(JIRA_KNOWN_KEY, result.known)
      for (const key of result.fresh) {
        const t = data.issues.find((x) => x.key === key)
        await deliver(orca, { id: `jira|${key}|${now}`, at: now, state: 'jira', jira: true, bot: false, title: `Ticket nuevo: ${key}`, where: t.title, body: t.brief, path: null, terminalId: null })
      }
    } catch (e) {
      orca.log(`no pude mirar Jira: ${e.message}`)
    }
  }
  tick()
  setInterval(tick, JIRA_POLL_MS)
}

const samePath = (a, b) => String(a ?? '').replace(/\/+$/, '') === String(b ?? '').replace(/\/+$/, '')

// Los repos que Orca tiene como proyecto git: solo en esos se puede crear un workspace.
async function gitProjects(orca) {
  const { projects } = await orca.host.call('project.list')
  return projects.filter((p) => p.kind === 'git' && !p.hidden)
}

// Arranca un ticket: un workspace nuevo de Orca en ese repo, con la rama del ticket sacada de origin/<base>, y el agente
// con el primer mensaje. El plan lo arma el servidor (no se confía en lo que manda el panel) y no commitea ni pushea.
async function startTicket(orca, { key, repo } = {}) {
  if (typeof key !== 'string' || typeof repo !== 'string') throw Object.assign(new Error('Pedido inválido.'), { code: 'invalid_params' })
  if (!orca.host.has('workspace.create')) throw new Error('Esta versión de Orca no deja crear workspaces desde un plugin.')
  const { status, data: plan } = await relay({ path: `/api/jira-start?key=${encodeURIComponent(key)}&repo=${encodeURIComponent(repo)}` })
  if (status !== 200) throw Object.assign(new Error(plan?.error ?? 'No pude preparar el ticket.'), { code: 'invalid_params' })
  const project = (await gitProjects(orca)).find((p) => samePath(p.path, plan.path))
  if (!project) throw Object.assign(new Error(`Orca no tiene ${plan.repo} como proyecto.`), { code: 'invalid_params' })
  const created = await orca.host.call('workspace.create', {
    projectId: project.id,
    ...(project.hostId ? { hostId: project.hostId } : {}),
    name: plan.branch,
    baseBranch: plan.baseRef,
    agent: plan.agent,
    prompt: plan.prompt,
    open: true
  })
  // Orca puede ajustar el nombre de la rama (prefijo, nombre repetido): se informa la que quedó.
  let branch = plan.branch
  try {
    const { workspaces } = await orca.host.call('workspace.list')
    branch = workspaces.find((w) => w.id === created.workspaceId)?.branch?.replace(/^refs\/heads\//, '') ?? branch
  } catch (e) {
    orca.log(`no pude leer la rama del workspace nuevo: ${e.message}`)
  }
  return { workspaceId: created.workspaceId, branch, expected: plan.branch }
}

export default function activate(orca) {
  const lastState = new Map()
  orca.panels.handle('api', (input) => relay(input))
  orca.panels.handle('open', (input) => openInOrca(orca, input))
  orca.panels.handle('projects', async () => (await gitProjects(orca)).map((p) => p.path.replace(/\/+$/, '')))
  orca.panels.handle('jiraStart', (input) => startTicket(orca, input))
  orca.commands.register('avisos.abrir', () => openLatestNotice(orca))
  orca.events.on('agent.status.changed', async (event) => {
    if (!shouldNotify(lastState, event)) return
    try {
      await deliver(orca, await noticeOfEvent(orca, event))
    } catch (e) {
      orca.log(`no pude avisar: ${e.message}`)
    }
  })
  watchChats(orca)
  watchJira(orca)
}
