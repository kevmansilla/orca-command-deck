// Worker del plugin: asegura que la app local esté corriendo y le hace de puente al panel lateral, que no puede
// conectarse a nada: el panel le pide `api` y el worker se lo pasa al servidor.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { readState, serverStamp } from './state.mjs'

const DAEMON = fileURLToPath(new URL('./daemon.mjs', import.meta.url))
const START_TRIES = 50
const API_PATH_RE = /^\/api\/[a-z-]+(\?[^\s#]*)?$/
const TERMINAL_RE = /^term_[\w-]+$/
// Igual que en app.js: la campana del panel guarda acá si se avisa.
const NOTIFY_KEY = 'notify'
// Los estados en que una sesión te necesita, con lo que dice el aviso.
const NEEDS_YOU = { blocked: 'pide permiso', waiting: 'tiene una pregunta' }

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

async function notify(orca, event) {
  if ((await orca.storage.get(NOTIFY_KEY)) === false) return
  let where = ''
  try {
    const { workspaces } = await orca.host.call('workspace.list')
    const ws = workspaces.find((w) => w.id === event.workspaceListId)
    if (ws) where = ws.project && ws.project !== ws.name ? `${ws.project} › ${ws.name}` : ws.name
  } catch (e) {
    orca.log(`no pude leer los workspaces para el aviso: ${e.message}`) // el aviso sale igual, sin el lugar
  }
  const title = `${event.title || 'Una sesión'} ${NEEDS_YOU[event.state]}`
  await orca.host.call('notifications.show', { title, body: where || undefined })
}

export default function activate(orca) {
  const lastState = new Map()
  orca.panels.handle('api', (input) => relay(input))
  orca.panels.handle('open', (input) => openInOrca(orca, input))
  orca.events.on('agent.status.changed', async (event) => {
    if (!shouldNotify(lastState, event)) return
    try {
      await notify(orca, event)
    } catch (e) {
      orca.log(`no pude avisar: ${e.message}`)
    }
  })
}
