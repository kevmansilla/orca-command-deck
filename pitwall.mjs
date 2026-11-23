// Pit Wall: quién te espera, quién trabaja y los bots, armado con lo que devuelven `worktree.ps` y `agent.list` de Orca.
// Lógica pura, sin llamadas a Orca, para que test.mjs la pruebe con datos inventados.
// Adaptado de https://github.com/Juanpe/orca-pit-wall (MIT).

const MESSAGE_MAX = 140
const ACTIVITY_MAX = 60
const STATES = ['working', 'blocked', 'waiting', 'done']
const TERMINAL_RE = /^term_[\w-]+$/

export const isTerminal = (id) => typeof id === 'string' && TERMINAL_RE.test(id)

// Una línea legible de una respuesta en markdown.
export function flatten(text, max = MESSAGE_MAX) {
  if (!text) return null
  const line = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return null
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

// Los títulos de sesión pueden traer marcas internas de Claude (`<local-command-caveat>…`).
export function cleanTitle(title) {
  if (!title) return null
  const text = String(title)
    .replace(/<([a-z-]+)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?[a-z-]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

function activityOf(agent) {
  if (!agent.toolName) return null
  const input = flatten(agent.toolInput, ACTIVITY_MAX)
  return input ? `${agent.toolName} · ${input}` : agent.toolName
}

// Una sesión cortada sin avisar (Esc, Ctrl-C) Orca la marca `interrupted`: está quieta, esperándote.
function stateOf(agent) {
  if (agent.interrupted) return 'idle'
  return STATES.includes(agent.state) ? agent.state : 'idle'
}

function titleOf(agent) {
  return cleanTitle(agent.taskTitle) ?? cleanTitle(agent.displayName) ?? cleanTitle(agent.conversationName) ??
    cleanTitle(agent.activity?.title) ?? flatten(agent.prompt, ACTIVITY_MAX) ?? agent.agentType ?? 'Agente'
}

// `open`: ids de sesión que Orca lista como abiertas (`agent.list`), para las que no tienen terminal: chats y bots.
// `botDirs`: los bots que existen en disco ({ name, path }), para mostrar también los que Orca no tiene abiertos.
export function buildSnapshot(worktrees, now, open = new Set(), botDirs = []) {
  const waiting = []
  const working = []
  const bots = []
  let count = 0
  for (const w of worktrees) {
    if (w.isArchived) continue
    const project = w.repo || w.displayName || 'Sin proyecto'
    const workspace = w.displayName || project
    let agentsWaiting = 0
    let agentsWorking = 0
    ;(w.agents ?? []).forEach((agent, index) => {
      // Sin terminal y sin figurar abierta es una sesión cerrada: ahí no espera nadie.
      const terminal = isTerminal(agent.address)
      if (!terminal && !open.has(agent.orcaSessionId)) return
      const state = stateOf(agent)
      const row = {
        key: `${w.worktreeId}|${agent.address ?? agent.orcaSessionId}|${index}`,
        state,
        since: agent.stateStartedAt ?? agent.mainAgent?.stateStartedAt ?? now,
        project,
        workspace,
        worktreeId: w.worktreeId,
        path: w.path ?? null,
        title: titleOf(agent),
        lastMessage: flatten(agent.lastAssistantMessage),
        activity: state === 'working' ? activityOf(agent) : null,
        // Sin terminal, el clic abre el workspace.
        terminalId: terminal ? agent.address : null
      }
      if (state === 'working') {
        agentsWorking++
        working.push(row)
      } else {
        agentsWaiting++
        waiting.push(row)
      }
    })
    count++
    if (w.bot) {
      bots.push({ worktreeId: w.worktreeId, path: w.path ?? null, name: String(w.bot), status: w.status ?? null, lastActivityAt: w.lastActivityAt ?? null, agentsWaiting, agentsWorking })
    }
  }
  waiting.sort((a, b) => a.since - b.since) // la que más espera, primero
  working.sort((a, b) => b.since - a.since) // la más reciente, primero
  for (const dir of botDirs) {
    if (bots.some((b) => b.path === dir.path)) continue
    // Existe en disco pero Orca no lo lista como workspace: no hay nada que abrir.
    bots.push({ worktreeId: null, path: dir.path, name: dir.name, status: 'closed', lastActivityAt: null, agentsWaiting: 0, agentsWorking: 0 })
  }
  bots.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  return { generatedAt: now, waiting, working, bots, worktrees: count, error: null }
}
