// Prueba las acciones de la app contra un repo descartable en una carpeta temporal. No toca los repos reales.
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'mrg-test-'))
const repo = join(tmp, 'app')
const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, stdio: 'pipe' }).toString()

sh(tmp, 'git', 'init', '-q', '--bare', '-b', 'master', 'remote.git')
sh(tmp, 'git', 'clone', '-q', 'remote.git', 'app')
sh(repo, 'git', 'config', 'user.email', 'test@example.com')
sh(repo, 'git', 'config', 'user.name', 'test')
// El comando de worktrees de la policy es `git wt`: un alias de este repo a un script que existe, para no depender de la
// configuración de git de la máquina.
writeFileSync(join(tmp, 'wt.sh'), 'exit 0\n')
sh(repo, 'git', 'config', 'alias.wt', `!bash ${join(tmp, 'wt.sh')}`)
// El ignore global de cada máquina puede esconder los .env y volver inútiles las pruebas de secretos.
sh(repo, 'git', 'config', 'core.excludesFile', '/dev/null')
sh(repo, 'git', 'switch', '-q', '-c', 'master')
writeFileSync(join(repo, 'a.txt'), '1\n')
sh(repo, 'git', 'add', '.')
sh(repo, 'git', 'commit', '-qm', 'init')
sh(repo, 'git', 'push', '-q', '-u', 'origin', 'master')
sh(repo, 'git', 'switch', '-q', '-c', 'otra')
sh(repo, 'git', 'push', '-q', '-u', 'origin', 'otra')
sh(repo, 'git', 'switch', '-q', 'master')
sh(repo, 'git', 'branch', '-q', '-D', 'otra')
sh(tmp, 'git', 'clone', '-q', 'remote.git', 'sin-regla')
sh(tmp, 'git', 'clone', '-q', 'remote.git', 'libre')
sh(tmp, 'git', 'clone', '-q', 'remote.git', 'mixta')
writeFileSync(join(tmp, 'bases.json'), JSON.stringify({ default: 'main', repos: { app: 'master' }, diagnostico: {}, git_libre: [] }))
writeFileSync(join(tmp, 'bases-mixta.json'), JSON.stringify({ default: 'dev' }))
sh(tmp, 'git', 'clone', '-q', 'remote.git', 'editable')
sh(tmp, 'git', 'clone', '-q', 'remote.git', 'cerrada')
writeFileSync(join(tmp, 'bases-editables.json'), JSON.stringify({ default: 'master' }))
writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ env: { EDITABLES: 'otro, editable' } }))
writeFileSync(join(tmp, 'repos.json'), JSON.stringify(['app', 'sin-regla', 'libre', 'mixta', 'editable', 'cerrada'].map((name) => ({ name, path: join(tmp, name) }))))
// Como un pre-push que exige que un push a una rama nombre esa misma rama, no HEAD.
writeFileSync(join(repo, '.git/hooks/pre-push'), `#!/bin/sh
while read -r local_ref local_sha remote_ref remote_sha; do [ "$local_ref" = "$remote_ref" ] || exit 1; done
`, { mode: 0o755 })
const tickets = join(tmp, 'tickets')
mkdirSync(join(tickets, '_template'), { recursive: true })
mkdirSync(join(tickets, 'ABC-7-prueba'))
writeFileSync(join(tickets, '_template/test.md'), '# Test\n<!-- nota -->\n1. (paso)\n')
writeFileSync(join(tickets, '_template/deploy.md'), '# Deploy\n**No.**\n')
writeFileSync(join(tickets, 'ABC-7-prueba/US.md'), '# ABC-7\n\n- **Estado:** en curso\n')
writeFileSync(join(tickets, 'ABC-7-prueba/test.md'), '# Test\n1. (paso)\n')
writeFileSync(join(tickets, 'ABC-7-prueba/deploy.md'), '# Deploy\n**No.**\n- `make rebuild`\n')
mkdirSync(join(tickets, 'ABC-8-mails'))
writeFileSync(join(tickets, 'ABC-8-mails/US.md'), '# ABC-8\n\n- **Estado:** listo-para-deploy\n')
writeFileSync(join(tickets, 'ABC-8-mails/roadmap.md'), '# Roadmap\n\n- ⛔ **Decisión de negocio:** qué texto ve el cliente — decide alguien\n')
// ABC-7 dice «en curso» en US.md, que no es un estado fijo: vale su fila del índice.
writeFileSync(join(tickets, 'INDEX.md'), '| ID | Carpeta | Estado |\n|---|---|---|\n| ABC-7 | [x](ABC-7-prueba/US.md) | `en-progreso` |\n')
writeFileSync(join(tmp, 'jira.env'), 'JIRA_EMAIL="persona@example.com"\nexport JIRA_TOKEN=token-de-prueba\n')
const scanner = join(tmp, 'scanner.sh')
writeFileSync(scanner, `#!/bin/sh
if grep -q FALLA "$@"; then exit 3; fi
grep -l CLAVE "$@" | while read -r f; do echo "  $f:1  [token/credencial — credencial]" >&2; echo "     CLAVE-REAL" >&2; done
grep -q CLAVE "$@" && exit 1
exit 0
`, { mode: 0o755 })
writeFileSync(join(tmp, 'policy.json'), JSON.stringify({
  tickets: [{ under: tmp, dir: tickets }],
  scan: { under: tmp, run: scanner },
  rules: [
    { path: repo, bases: join(tmp, 'bases.json') },
    { path: join(tmp, 'libre'), free: true },
    { path: join(tmp, 'mixta'), bases: join(tmp, 'bases-mixta.json'), protected: ['master'] },
    { path: join(tmp, 'editable'), bases: join(tmp, 'bases-editables.json'), freeFrom: { file: join(tmp, 'settings.json'), key: 'env.EDITABLES' } },
    { path: join(tmp, 'cerrada'), bases: join(tmp, 'bases-editables.json'), freeFrom: { file: join(tmp, 'no-existe.json'), key: 'env.EDITABLES' } }
  ],
  commands: [
    { label: 'Mergear', run: 'git p -m', warn: true },
    { label: 'Continuar', run: 'git p -c', when: 'merging' },
    { label: 'Otro', run: 'git otro', under: join(tmp, 'libre') },
    { label: 'A {base}', run: 'git a', when: 'feature' }
  ],
  worktrees: { create: 'git wt {repo} {branch}', remove: 'git wt -d {repo} {branch}' },
  jira: { site: 'https://jira.example.test/', project: 'ABC', credentials: join(tmp, 'jira.env'), tickets, startPrompt: 'Arrancamos {key}: {title} ({url})' }
}))
process.env.MRG_REPOS_FILE = join(tmp, 'repos.json')
process.env.MRG_POLICY_FILE = join(tmp, 'policy.json')
process.env.MRG_ORCA_WORKSPACES = join(tmp, 'orca-ws')

const { fillCommand, prUrl, shellQuote, startServer } = await import('./server.mjs')
const opened = []
const enfocadas = []
const activados = []
const orcaFalso = {
  worktrees: async () => [{
    worktreeId: 'r1::/p/app', repo: 'app', displayName: 'app', path: join(tmp, 'app'), branch: 'refs/heads/master', workspaceKind: 'git', lastActivityAt: 5,
    agents: [
      { address: 'term_a1', state: 'done', stateStartedAt: 100, conversationName: '<local-command-caveat>x</local-command-caveat> Arreglar el login', lastAssistantMessage: '## Listo\n\n**Hecho** el `cambio`' },
      { address: 'term_b2', state: 'working', stateStartedAt: 200, taskTitle: 'Tests', toolName: 'Bash', toolInput: 'npm test' },
      { address: 'term_c3', state: 'working', interrupted: true, stateStartedAt: 50, prompt: 'cortada' },
      { address: 'orca_session_id:s-vieja', state: 'done', stateStartedAt: 10, conversationName: 'cerrada', orcaSessionId: 's-vieja' },
      { address: 'orca_session_id:s-chat', state: 'waiting', stateStartedAt: 300, conversationName: 'chat', orcaSessionId: 's-chat' }
    ]
  }, {
    worktreeId: 'r1::/p/abc7', repo: 'app', displayName: 'app', path: '/p/abc7', branch: 'refs/heads/ABC-7-prueba', workspaceKind: 'git', lastActivityAt: 4, agents: []
  }, {
    worktreeId: 'b1::/bots/k', path: '/bots/k', repo: 'Bots', displayName: 'Asistente', bot: 'Asistente', status: 'inactive', workspaceKind: 'folder-workspace', lastActivityAt: 9, agents: []
  }],
  sessions: async () => new Set(['s-chat']),
  bots: () => [{ name: 'Asistente', path: '/bots/k' }, { name: 'Avisos', path: '/bots/n' }],
  focus: async (t) => { if (t === 'term_b2') throw new Error('stale'); enfocadas.push(t) },
  activate: async (id) => activados.push(id),
  launchChat: async (o) => { chats.push(o); return { surface: 'chat', sessionId: 'aaaaaaaa-0000-0000-0000-000000000001' } },
  createWorkspaceChat: async (o) => { creados.push(o); return { surface: 'terminal', sessionId: null } }
}
const chats = []
const creados = []
// Un Jira inventado: cuenta las consultas y guarda lo que se le pidió.
const adf = (...content) => ({ type: 'doc', version: 1, content })
const parrafo = (text, bold = false) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'strong' }] } : {}) }] })
const jiraPedidos = []
const transPedidos = []
const estadosPedidos = []
const terminadosPedidos = []
const jiraFalso = async (url, init) => {
  if (url.endsWith('/rest/api/3/project/ABC/statuses')) {
    estadosPedidos.push(url)
    const sts = [['To Do', 'new'], ['En curso', 'indeterminate'], ['Testing', 'indeterminate'], ['Done', 'done']]
    return new Response(JSON.stringify([{ name: 'Task', statuses: sts.map(([name, key]) => ({ name, statusCategory: { key } })) }, { name: 'Bug', statuses: [{ name: 'done', statusCategory: { key: 'done' } }] }]), { status: 200 })
  }
  if (decodeURIComponent(url.replace(/\+/g, ' ')).includes('statusCategory = Done AND')) {
    terminadosPedidos.push(url)
    return new Response(JSON.stringify({ issues: [{ key: 'ABC-5', fields: { summary: 'Ya hecho', updated: new Date().toISOString(), status: { name: 'Done', statusCategory: { key: 'done' } }, description: null } }] }), { status: 200 })
  }
  if (url.includes('/transitions')) {
    transPedidos.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization })
    if (init.method === 'POST') return JSON.parse(init.body).transition.id === '31' ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ errorMessages: [], errors: { resolution: 'Falta la resolución.' } }), { status: 400 })
    return new Response(JSON.stringify({ transitions: [
      { id: '21', name: 'Empezar', isAvailable: true, to: { name: 'En curso', statusCategory: { key: 'indeterminate' } } },
      { id: '31', name: 'Testing', isAvailable: true, to: { name: 'Testing', statusCategory: { key: 'indeterminate' } } },
      { id: '41', name: 'Cerrar', isAvailable: true, to: { name: 'Done', statusCategory: { key: 'done' } } },
      { id: '51', name: 'No disponible', isAvailable: false, to: { name: 'X' } }
    ] }), { status: 200 })
  }
  jiraPedidos.push({ url, auth: init.headers.Authorization })
  return new Response(JSON.stringify({ issues: [
    { key: 'ABC-8', fields: { summary: 'Revisar el envío de mails', updated: '2026-01-02T10:00:00.000-0300', status: { name: 'To Do', statusCategory: { key: 'new' } }, description: adf({ type: 'heading', content: [{ type: 'text', text: 'Contexto' }] }, parrafo('Ejemplo', true), parrafo('Hay que mandar los mails desde un solo lugar.'), { type: 'codeBlock', content: [{ type: 'text', text: 'select 1' }] }) } },
    { key: 'ABC-9', fields: { summary: 'En pruebas', updated: '2026-01-03T10:00:00.000-0300', status: { name: 'Testing', statusCategory: { key: 'indeterminate' } }, description: null } },
    { key: 'ABC-7', fields: { summary: 'Prueba', updated: '2026-01-01T10:00:00.000-0300', status: { name: 'En curso', statusCategory: { key: 'indeterminate' } }, description: null } }
  ] }), { status: 200 })
}
const arranques = join(tmp, 'arranques.json')
const { port, token, close } = await startServer({ terminal: async (t) => opened.push(t), orca: orcaFalso, jiraFetch: jiraFalso, startsFile: arranques })
const base = `http://127.0.0.1:${port}`
let failures = 0

function check(label, ok) {
  if (!ok) failures++
  console.log(ok ? 'ok   ' : 'FALLA', label)
}
async function call(path, body, tok = token) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Token': tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return [r.status, await r.json()]
}
const act = async (action, extra = {}) => (await call('/api/action', { repo: 'app', action, ...extra }))[0]
const state = async () => (await call('/api/repos'))[1][0]
const head = () => sh(repo, 'git', 'rev-parse', 'HEAD')

try {
  check('rechaza token incorrecto', (await call('/api/repos', null, 'x'))[0] === 403)
  const all = (await call('/api/repos'))[1]
  check('sin regla, la rama por defecto queda protegida', all[1].branch === 'master' && all[1].protected)
  check('una regla explícita puede liberar un repo', all[2].branch === 'master' && !all[2].protected)
  check('bases y protected se combinan', all[3].base === 'dev' && all[3].branch === 'master' && all[3].protected)
  check('con protected, un push a la base no se avisa como despliegue', all[3].deploys === false)
  check('freeFrom libera los repos de la lista y mantiene el aviso', all[4].branch === 'master' && !all[4].protected && all[4].deploys === true)
  const editablePush = (await call('/api/push?repo=editable'))[1]
  check('el push a la base de un repo que despliega se avisa', editablePush.deploysBase === 'master')
  check('si la lista de freeFrom no se puede leer, sigue protegido', all[5].branch === 'master' && all[5].protected)
  appendFileSync(join(repo, 'a.txt'), '2\n')
  writeFileSync(join(repo, 'nuevo ñ.txt'), 'x\n')
  let s = await state()
  check('master figura protegida', s.protected && s.branch === 'master')
  check('lista los dos archivos', s.changes.length === 2)
  check('diff de archivo nuevo', (await call('/api/diff?repo=app&path=' + encodeURIComponent('nuevo ñ.txt')))[1].diff.includes('+x'))
  check('rechaza ruta desconocida', (await act('stage', { path: '../etc/passwd' })) === 400)
  check('stage', (await act('stage', { path: 'a.txt' })) === 200 && (await state()).staged.length === 1)
  check('unstage', (await act('unstage', { path: 'a.txt' })) === 200 && !(await state()).staged.length)
  await act('stage', { path: 'a.txt' })
  const before = head()
  check('bloquea commit en master', (await act('commit', { message: 'no' })) === 400)
  check('bloquea push en master', (await act('push')) === 400)
  check('master no se movió', before === head())
  check('rechaza nombre de rama inválido', (await act('create_branch', { branch: '-x' })) === 400)
  check('crea rama desde origin/master', (await act('create_branch', { branch: 'rama-prueba' })) === 200)
  s = await state()
  check('la rama nueva no está protegida y conserva lo staged', s.branch === 'rama-prueba' && !s.protected && s.staged.length === 1)
  check('commit sin mensaje falla', (await act('commit', { message: ' ' })) === 400)
  check('commit en la rama', (await act('commit', { message: 'prueba' })) === 200)
  const noRemote = await call('/api/action', { repo: 'app', action: 'pull' })
  check('pull sin rama remota explica que falta el push', noRemote[0] === 400 && noRemote[1].error.includes('Push'))
  check('push de la rama', (await act('push')) === 200 && (await state()).upstream === 'origin/rama-prueba')
  check('stage de todo y commit', (await act('stage_all')) === 200 && (await act('commit', { message: 'dos' })) === 200)
  check('cambia a rama remota', (await act('switch', { branch: 'origin/otra' })) === 200 && (await state()).branch === 'otra')
  check('rechaza rama inexistente', (await act('switch', { branch: 'nada' })) === 400)
  check('fetch', (await act('fetch')) === 200)
  check('pull', (await act('pull')) === 200)
  const log = (await call('/api/history?repo=app'))[1]
  check('historial', log[0].t === 'init')
  check('detalle de commit', (await call(`/api/commit?repo=app&h=${log[0].h}`))[0] === 200)
  check('rechaza hash inválido', (await call('/api/commit?repo=app&h=HEAD'))[0] === 400)
  writeFileSync(join(repo, '.env'), 'CLAVE=x\n')
  writeFileSync(join(repo, '.env.example'), 'CLAVE=\n')
  writeFileSync(join(repo, 'ok ñ.txt'), 'ok\n')
  mkdirSync(join(repo, 'conf'))
  writeFileSync(join(repo, 'conf/prod.pem'), 'x\n')
  const blocked = await call('/api/action', { repo: 'app', action: 'stage_all' })
  check('frena agregar todo con secretos, también dentro de una carpeta nueva', blocked[0] === 409 && blocked[1].sensitive.join() === '.env,conf/prod.pem')
  check('al frenar no agrega nada', !(await state()).staged.length)
  check('frena un archivo secreto suelto', (await act('stage', { path: '.env' })) === 409)
  check('frena una carpeta con un secreto adentro', (await act('stage', { path: 'conf/' })) === 409)
  check('agrega el resto sin los secretos', (await act('stage_all', { allow: 'skip' })) === 200)
  s = await state()
  check('el resto queda staged y los secretos no', s.staged.map((f) => f.p).sort().join() === '.env.example,ok ñ.txt' && s.changes.some((f) => f.p === '.env' && f.sensitive))
  check('.env.example no se marca como secreto', !s.staged.some((f) => f.sensitive))
  check('agrega el secreto si se confirma', (await act('stage', { path: '.env', allow: 'all' })) === 200)
  check('commit con el secreto', (await act('commit', { message: 'con secreto' })) === 200)
  const preview = (await call('/api/push?repo=app'))[1]
  check('la vista previa del push lista commits y secretos', preview.count === 1 && preview.commits[0].t === 'con secreto' && preview.sensitive.join() === '.env')
  await act('create_branch', { branch: 'abc-7-prueba' })
  check('une la rama con su ticket', (await state()).ticket?.id === 'ABC-7' && (await state()).ticket.state === 'en curso')
  check('test.md igual a la plantilla cuenta como faltante', (await state()).ticket.testMissing === true)
  check('deploy.md con pasos propios queda pendiente', (await state()).ticket.deployPending === true)
  writeFileSync(join(tickets, 'ABC-7-prueba/deploy.md'), '- **Estado:** ejecutado 2026-01-01\n- `make rebuild`\n')
  check('deploy.md ejecutado deja de estar pendiente', (await state()).ticket.deployPending === false)
  writeFileSync(join(repo, 'clave.txt'), 'CLAVE=abc\n')
  await act('stage', { path: 'clave.txt' })
  await act('commit', { message: 'agrega clave' })
  const dirty = (await call('/api/push?repo=app'))[1]
  check('encuentra datos sensibles en lo agregado', dirty.contentHits.join() === 'clave.txt: token/credencial')
  check('no devuelve el valor encontrado', !JSON.stringify(dirty).includes('CLAVE-REAL'))
  sh(repo, 'git', 'branch', '--set-upstream-to=origin/master')
  const crossed = await state()
  check('detecta una rama que sigue a otra', crossed.crossedUpstream === 'origin/master')
  const crossedPush = (await call('/api/push?repo=app'))[1]
  check('con upstream cruzado la vista previa no se compara contra esa otra rama', crossedPush.crossedUpstream === 'origin/master' && crossedPush.isNew === true)
  check('el push corrige el upstream y no toca master', (await act('push')) === 200 && (await state()).upstream === 'origin/abc-7-prueba' && !sh(tmp, 'git', '--git-dir=remote.git', 'log', 'master', '--format=%s').includes('agrega clave'))
  writeFileSync(join(repo, 'limpio.txt'), 'nada\n')
  await act('stage', { path: 'limpio.txt' })
  await act('commit', { message: 'limpio' })
  const clean = (await call('/api/push?repo=app'))[1]
  check('lo ya subido no se vuelve a señalar', clean.contentHits.length === 0 && !clean.scanFailed)
  writeFileSync(join(repo, 'roto.txt'), 'FALLA\n')
  await act('stage', { path: 'roto.txt' })
  await act('commit', { message: 'roto' })
  check('avisa si el scanner falla', (await call('/api/push?repo=app'))[1].scanFailed === true)
  await act('switch', { branch: 'master' })
  check('no hay vista previa de push en rama protegida', (await call('/api/push?repo=app'))[0] === 400)
  appendFileSync(join(repo, 'a.txt'), 'descartar\n')
  writeFileSync(join(repo, 'nuevo.txt'), 'x\n')
  check('descarta un cambio', (await act('discard', { path: 'a.txt' })) === 200 && !readFileSync(join(repo, 'a.txt'), 'utf8').includes('descartar'))
  check('borra un archivo nuevo', (await act('discard', { path: 'nuevo.txt' })) === 200 && !existsSync(join(repo, 'nuevo.txt')))
  check('borra una carpeta nueva', (await act('discard', { path: 'conf/' })) === 200 && !existsSync(join(repo, 'conf')))
  check('rechaza descartar lo que no cambió', (await act('discard', { path: 'a.txt' })) === 400)
  check('fetch de todos los repos', (await call('/api/fetch-all', {}))[1].failed === 0)
  check('no repite el fetch enseguida', (await call('/api/fetch-all', {}))[1].skipped === true)
  check('link de PR en GitHub', prUrl('git@github.com:a/b.git', 'x/y', 'main') === 'https://github.com/a/b/compare/main...x/y?expand=1')
  check('link de PR en Bitbucket', prUrl('https://u:t@bitbucket.org/a/b.git', 'x', 'dev') === 'https://bitbucket.org/a/b/pull-requests/new?source=x&t=1')
  check('sin link de PR en un host desconocido', prUrl('git@mi-alias:a/b.git', 'x', 'main') === null)
  const repoInfo = await state()
  check('muestra solo los comandos que aplican', repoInfo.commands.map((c) => c.label).join() === 'Mergear')
  check('marca el repo que despliega', repoInfo.deploys === true)
  const run = async (body) => (await call('/api/run', { repo: 'app', ...body }))[0]
  check('abre la terminal con el comando configurado', (await run({ command: 0 })) === 200 && opened.at(-1).command === `cd ${shellQuote(repo)} && git p -m`)
  check('rechaza un comando desconocido', (await run({ command: 9 })) === 400)
  check('rechaza un comando de otro repo', (await run({ command: 2 })) === 400)
  check('rechaza crear worktree con rama inválida', (await run({ command: 'wt-create', branch: '-x; rm' })) === 400)
  check('crea worktree con el comando configurado', (await run({ command: 'wt-create', branch: 'rama-wt' })) === 200 && opened.at(-1).command === `git wt ${shellQuote(repo)} 'rama-wt'`)
  check('rechaza borrar el repo principal como worktree', (await run({ command: 'wt-remove' })) === 400)
  check('escapa comillas al armar el comando', fillCommand('x {branch}', { branch: "a'b" }) === `x 'a'\\''b'`)
  sh(repo, 'git', 'worktree', 'add', '-q', '-b', 'rama-real', join(tmp, 'wt-real'), 'HEAD')
  const withWt = (await call('/api/repos?fresh=1'))[1]
  const wt = withWt.find((r) => r.worktreeOf === 'app')
  check('lista el worktree debajo de su repo', wt?.branch === 'rama-real' && wt.key === join(tmp, 'wt-real'))
  check('el worktree hereda las reglas de su repo', wt?.base === 'master' && wt.deploys === true)
  check('borra un worktree con el comando configurado', (await call('/api/run', { repo: wt.key, command: 'wt-remove' }))[0] === 200 && opened.at(-1).command === `git wt -d ${shellQuote(repo)} 'rama-real'`)
  sh(repo, 'git', 'worktree', 'add', '-q', '--detach', join(tmp, 'wt-suelto'), 'HEAD')
  const suelto = (await call('/api/repos?fresh=1'))[1].find((r) => r.key === join(tmp, 'wt-suelto'))
  check('borra un worktree detached por la ruta', (await call('/api/run', { repo: suelto.key, command: 'wt-remove' }))[0] === 200 && opened.at(-1).command === `git -C ${shellQuote(repo)} worktree remove ${shellQuote(suelto.key)}`)
  check('con force confirmado, lo borra aunque tenga cambios', (await call('/api/run', { repo: suelto.key, command: 'wt-remove', force: true }))[0] === 200 && opened.at(-1).command === `git -C ${shellQuote(repo)} worktree remove --force ${shellQuote(suelto.key)}`)
  const antesOrca = opened.length
  sh(repo, 'git', 'worktree', 'add', '-q', '-b', 'rama-orca', join(tmp, 'orca-ws', 'app-orca'), 'HEAD')
  const conOrca = (await call('/api/repos?fresh=1'))[1]
  const deOrca = conOrca.find((r) => r.key === join(tmp, 'orca-ws', 'app-orca'))
  check('reconoce el worktree que es un workspace de Orca (y el de afuera no)', deOrca?.orcaWorkspace === true && conOrca.find((r) => r.key === join(tmp, 'wt-real')).orcaWorkspace === false && conOrca.find((r) => r.key === 'app').orcaWorkspace === false)
  const [codigoOrca, borrarOrca] = await call('/api/run', { repo: deOrca.key, command: 'wt-remove' })
  check('no borra por git un workspace de Orca (se llevaría su conversación)', codigoOrca === 400 && /workspace de Orca/.test(borrarOrca.error) && opened.length === antesOrca && existsSync(join(tmp, 'orca-ws', 'app-orca')))
  const { isOrcaWorkspace, commandProblem } = await import('./server.mjs')
  check('un workspace que Orca lista cuenta aunque esté fuera de su carpeta', isOrcaWorkspace('/x/y/', '/w', new Set(['/x/y'])) && !isOrcaWorkspace('/w2/a', '/w') && isOrcaWorkspace('/w/a', '/w') && !isOrcaWorkspace('/w', '/w'))
  sh(repo, 'git', 'config', 'alias.wt', `!bash ${join(tmp, 'no-existe.sh')}`)
  const sinScript = (await call('/api/repos?fresh=1'))[1]
  const wtSin = sinScript.find((r) => r.key === join(tmp, 'wt-real'))
  check('si el script del alias no existe, no ofrece crear ni borrar worktrees y dice por qué', wtSin.canRemoveWorktree === false && sinScript.find((r) => r.key === 'app').canCreateWorktree === false && /git wt: falta .*no-existe\.sh/.test(wtSin.worktreeProblem))
  const [codigoSin, borrarSin] = await call('/api/run', { repo: wtSin.key, command: 'wt-remove' })
  check('y el borrado con rama avisa en vez de abrir una terminal que falla', codigoSin === 400 && /no anda en esta máquina/.test(borrarSin.error) && opened.length === antesOrca)
  check('detached se puede borrar igual: va por git worktree remove', (await call('/api/run', { repo: suelto.key, command: 'wt-remove' }))[0] === 200 && opened.length === antesOrca + 1)
  check('un comando que no es git se busca en el PATH', (await commandProblem('no-existe-cmd-xyz {repo}', repo)) === 'no está no-existe-cmd-xyz' && (await commandProblem('git worktree add {path}', repo)) === null)
  sh(repo, 'git', 'config', 'alias.wt', `!bash ${join(tmp, 'wt.sh')}`)
  check('force que no es true no fuerza', (await call('/api/run', { repo: suelto.key, command: 'wt-remove', force: 'true' }))[0] === 200 && !opened.at(-1).command.includes('--force'))
  check('el nombre del botón usa la base del repo', withWt.find((r) => r.key === 'libre').commands.some((c) => c.label === 'A master'))
  check('no ofrece el comando de rama parado en una protegida', !withWt[0].commands.some((c) => c.label === 'A master'))
  writeFileSync(join(repo, '.git', 'MERGE_HEAD'), 'x')
  check('ofrece continuar con un merge frenado', (await call('/api/repos?fresh=1'))[1][0].commands.some((c) => c.label === 'Continuar'))
  rmSync(join(repo, '.git', 'MERGE_HEAD'))
  const wtMerge = join(tmp, 'wt-merge')
  const merged = async () => (await call('/api/repos?fresh=1'))[1].find((r) => r.key === wtMerge).merged
  sh(repo, 'git', 'fetch', '-q', 'origin')
  sh(repo, 'git', 'worktree', 'add', '-q', '-b', 'rama-merge', wtMerge, 'origin/master')
  check('una rama recién sacada de la base no figura como mergeada', (await merged()) === null)
  writeFileSync(join(wtMerge, 'm.txt'), 'm\n')
  sh(wtMerge, 'git', 'add', 'm.txt')
  sh(wtMerge, 'git', 'commit', '-qm', 'para mergear')
  check('con commits propios sin mergear no figura como mergeada', (await merged()) === null)
  // Un merge --no-ff a master sin checkoutearla: en este punto master puede estar abierta en el repo de prueba.
  const mergeCommit = sh(repo, 'git', 'commit-tree', 'rama-merge^{tree}', '-p', 'origin/master', '-p', 'rama-merge', '-m', 'merge').trim()
  sh(repo, 'git', 'update-ref', 'refs/heads/master', mergeCommit)
  check('mergeada en la base local y sin push', (await merged()) === 'local')
  sh(repo, 'git', 'update-ref', 'refs/remotes/origin/master', mergeCommit)
  check('mergeada y pusheada', (await merged()) === 'remote')
  const policyFile = process.env.MRG_POLICY_FILE
  const policyBefore = readFileSync(policyFile, 'utf8')
  writeFileSync(policyFile, JSON.stringify({ ...JSON.parse(policyBefore), standingBranches: ['rama-merge'] }))
  const standing = (await call('/api/repos?fresh=1'))[1].find((r) => r.key === wtMerge)
  check('una rama fija (standingBranches) no figura como mergeada ni ofrece el comando de rama', standing.merged === null && !standing.commands.some((c) => c.label.startsWith('A ')))
  writeFileSync(policyFile, policyBefore)
  const { buildSnapshot, flatten } = await import('./pitwall.mjs')
  const snap = buildSnapshot(await orcaFalso.worktrees(), 1000, await orcaFalso.sessions(), orcaFalso.bots())
  check('pit wall deja afuera las sesiones cerradas', snap.waiting.length + snap.working.length === 4)
  check('pit wall muestra el chat abierto sin terminal', snap.waiting.some((a) => a.title === 'chat' && a.terminalId === null))
  check('pit wall marca quieta la sesión cortada', snap.waiting.some((a) => a.terminalId === 'term_c3' && a.state === 'idle'))
  check('pit wall ordena las que esperan por antigüedad', snap.waiting.map((a) => a.terminalId).join() === 'term_c3,term_a1,')
  check('pit wall limpia las marcas del título', snap.waiting.find((a) => a.terminalId === 'term_a1').title === 'Arreglar el login')
  check('pit wall aplana el último mensaje', snap.waiting.find((a) => a.terminalId === 'term_a1').lastMessage === 'Listo Hecho el cambio')
  check('pit wall muestra la herramienta en curso', snap.working[0].activity === 'Bash · npm test')
  check('pit wall lista los bots aunque estén dormidos', snap.bots.some((b) => b.name === 'Asistente' && b.status === 'inactive' && b.worktreeId))
  check('pit wall suma los bots que Orca no tiene abiertos, sin repetir', snap.bots.length === 2 && snap.bots.some((b) => b.name === 'Avisos' && b.status === 'closed' && b.worktreeId === null))
  check('pit wall pasa la carpeta de cada sesión para abrirla', snap.waiting.every((a) => a.path))
  check('pit wall cuenta los workspaces', snap.worktrees === 3)
  check('flatten recorta los mensajes largos', flatten('x'.repeat(300)).length === 140)
  const { shouldNotify } = await import('./main.mjs')
  const estados = new Map()
  check('avisa cuando una sesión pide permiso', shouldNotify(estados, { paneKey: 'p1', state: 'blocked' }))
  check('no repite el aviso del mismo estado', !shouldNotify(estados, { paneKey: 'p1', state: 'blocked' }))
  check('no avisa cuando trabaja o termina', !shouldNotify(estados, { paneKey: 'p1', state: 'working' }) && !shouldNotify(estados, { paneKey: 'p1', state: 'done' }))
  check('vuelve a avisar si después pregunta', shouldNotify(estados, { paneKey: 'p1', state: 'waiting' }))
  const { chatNotices, addNotice } = await import('./pitwall.mjs')
  const fila = (o) => ({ key: 'k', state: 'working', since: 10, project: 'Bots', workspace: 'Kevinito', worktreeId: 'f:bot', path: '/b', title: 'Kevinito', lastMessage: 'Hola', terminalId: null, ...o })
  const foto = (filas, bots = [{ worktreeId: 'f:bot' }]) => ({ bots, waiting: filas.filter((f) => f.state !== 'working'), working: filas.filter((f) => f.state === 'working') })
  const v0 = chatNotices(null, foto([fila({ state: 'done', since: 5 })]), 100)
  check('la primera vuelta de los chats solo toma nota', v0.notices.length === 0 && v0.seen.size === 1)
  const v1 = chatNotices(v0.seen, foto([fila({ state: 'done', since: 50 })]), 200)
  check('avisa cuando un bot termina, con su mensaje', v1.notices.length === 1 && v1.notices[0].title === 'Kevinito terminó' && v1.notices[0].body === 'Hola' && v1.notices[0].path === '/b')
  check('no repite el aviso del bot en la vuelta siguiente', chatNotices(v1.seen, foto([fila({ state: 'done', since: 50 })]), 300).notices.length === 0)
  check('no avisa cuando un chat común termina', chatNotices(v0.seen, foto([fila({ state: 'done', since: 50 })], []), 200).notices.length === 0)
  check('avisa cuando un chat común pregunta', chatNotices(v0.seen, foto([fila({ state: 'waiting', since: 50 })], []), 200).notices[0]?.title === 'Kevinito tiene una pregunta')
  check('los chats con terminal quedan para el evento', chatNotices(new Map(), foto([fila({ state: 'blocked', since: 50, terminalId: 'term_x' })]), 200).notices.length === 0)
  check('no avisa del estado viejo de una sesión que recién se abre', chatNotices(new Map(), foto([fila({ state: 'done', since: 50 })]), 200, 60).notices.length === 0)
  const bandeja = addNotice(addNotice(addNotice([], { id: 'a' }), { id: 'b' }), { id: 'a' }, 2)
  check('la bandeja pone lo nuevo primero, sin repetir y con tope', bandeja.map((n) => n.id).join() === 'a,b')
  const { statusBarOf } = await import('./pitwall.mjs')
  check('la barra de estado se esconde sin avisos nuevos', statusBarOf([{ at: 5, title: 'x' }], 5).visible === false)
  const barra = statusBarOf([{ at: 9, title: 'Kevinito terminó', state: 'done' }, { at: 8, title: 'y', state: 'waiting' }, { at: 2 }], 5)
  check('la barra de estado cuenta los no leídos y muestra el último', barra.text === '2 avisos' && barra.tone === 'warning' && barra.tooltip.startsWith('Kevinito terminó'))
  const [codigoWall, wall] = await call('/api/pitwall')
  check('/api/pitwall devuelve las sesiones', codigoWall === 200 && wall.working.length === 1 && wall.error === null)
  check('/api/open enfoca la terminal', (await call('/api/open', { worktreeId: 'r1::/p/app', terminalId: 'term_a1' }))[0] === 200 && enfocadas.join() === 'term_a1')
  check('/api/open abre el workspace si la terminal se cerró', (await call('/api/open', { worktreeId: 'r1::/p/app', terminalId: 'term_b2' }))[0] === 200 && activados.join() === 'r1::/p/app')
  check('/api/open no enfoca una terminal de otro workspace', (await call('/api/open', { worktreeId: 'r1::/p/app', terminalId: 'term_zz' }))[0] === 200 && enfocadas.length === 1 && activados.length === 2)
  check('sirve el código de la página sin token', (await fetch(base + '/app.js')).status === 200 && (await fetch(base + '/app.css')).status === 200)
  check('/api/open rechaza un workspace desconocido', (await call('/api/open', { worktreeId: 'otro' }))[0] === 400)

  // Jira
  const { adfLines, blockerIn, branchFor, briefOf, jiraConfig, jiraNews, parseEnv, sessionsOf, slugOf } = await import('./jira.mjs')
  check('jira: por defecto oculta Testing y separa lo de más de 90 días', jiraConfig({ site: 'https://x.test', project: 'ABC', credentials: 'c' }).hideStatuses.join() === 'Testing' && jiraConfig({ site: 'https://x.test', project: 'ABC', credentials: 'c', staleDays: 30, hideStatuses: [] }).staleDays === 30)
  check('jira: sin https o sin proyecto válido no hay configuración', jiraConfig({ site: 'http://x.test', project: 'ABC', credentials: 'c' }) === null && jiraConfig({ site: 'https://x.test', project: 'abc', credentials: 'c' }) === null)
  check('jira: lee el .env con comillas y export', parseEnv('A="1"\nexport B=\'2\'\n# nada').A === '1' && parseEnv('export B=\'2\'').B === '2')
  check('jira: la descripción breve saltea títulos, rótulos en negrita y código', briefOf(adf({ type: 'heading', content: [{ type: 'text', text: 'Título' }] }, parrafo('Ejemplo', true), parrafo('Hacer esto.'), { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }, parrafo('Y aquello.'))) === 'Hacer esto. Y aquello.')
  check('jira: la descripción breve se recorta', briefOf(adf(parrafo('x'.repeat(500)))).length === 220 && briefOf(null) === null)
  check('jira: el texto de listas y menciones también cuenta', adfLines(adf({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Ana' } }, { type: 'text', text: ' revisa' }] }] }] })).map((l) => l.text).join() === '@Ana revisa')
  check('jira: la rama lleva la clave y el título sin tildes', branchFor('ABC-8', 'Revisar el envío de mails ¡ya!') === 'ABC-8-revisar-el-envio-de-mails-ya' && slugOf('a'.repeat(60)).length === 40)
  const conRamas = [
    { worktreeId: 'w1', branch: 'refs/heads/ABC-12-algo', agents: [{ address: 'term_1', state: 'working' }, { address: 'orca_session_id:c1', orcaSessionId: 'c1' }, { address: 'orca_session_id:c2', orcaSessionId: 'c2' }] },
    { worktreeId: 'w2', branch: 'ABC-123-otro', agents: [] }, { worktreeId: 'w3', branch: 'ABC-12-bot', bot: 'x', agents: [] }, { worktreeId: 'w4', displayName: 'main', branch: 'main', agents: [] }
  ]
  const sesiones12 = sessionsOf('ABC-12', conRamas, new Set(['c1']))
  check('jira: el workspace se reconoce por la rama, sin confundir ABC-12 con ABC-123 ni contar bots', sesiones12.length === 1 && sesiones12[0].terminals === 1 && sesiones12[0].chats === 1 && sesiones12[0].agentWorking)
  const conRecuerdo = sessionsOf('ABC-12', conRamas, new Set(), [{ worktreeId: 'w4' }, { worktreeId: 'ya-no-esta' }])
  check('jira: el workspace donde lo arrancaste va primero, aunque la rama no lleve la clave', conRecuerdo.map((p) => p.worktreeId + (p.remembered ? '*' : '')).join() === 'w4*,w1')
  const { rememberStart } = await import('./jira.mjs')
  const recuerdos = rememberStart(rememberStart(rememberStart({}, 'A-1', { worktreeId: 'x' }), 'A-1', { worktreeId: 'y' }), 'A-1', { worktreeId: 'x', sessionId: 's' })
  check('jira: recuerda dónde arrancaste, lo último primero y sin repetir', recuerdos['A-1'].map((e) => e.worktreeId).join() === 'x,y' && recuerdos['A-1'][0].sessionId === 's')
  const { cliError, outcomeOf, runningCli } = await import('./orca-tab.mjs')
  check('orca: el motivo de una falla sale del JSON de la CLI o de su stderr', cliError('{"ok":false,"error":{"message":"no existe ese worktree"}}', '', 'x') === 'no existe ese worktree' && cliError('', 'algo\nOrca CLI is unavailable\n', 'x') === 'Orca CLI is unavailable' && cliError('', '', 'x') === 'x')
  writeFileSync(join(tmp, 'runtime.json'), JSON.stringify({ pid: process.pid }))
  check('orca: sin la CLI junto al ejecutable que corre, queda la del PATH', runningCli(join(tmp, 'runtime.json')) === null && runningCli(join(tmp, 'no-existe.json')) === null)
  const salida = outcomeOf('{"result":{"outcome":{"kind":"structured","sessionId":"aaaaaaaa-0000-0000-0000-000000000001","handle":"structured-agent-session-aaaaaaaa-0000-0000-0000-000000000001"},"receipt":{"detail":"porque sí"}}}')
  check('orca: lee si abrió chat o terminal, por qué y el id de la sesión', salida.surface === 'chat' && salida.sessionId === 'aaaaaaaa-0000-0000-0000-000000000001' && salida.detail === 'porque sí' && outcomeOf('{"result":{"launch":{"outcome":{"kind":"terminal"}}}}').surface === 'terminal' && outcomeOf('no').surface === null)
  check('jira: la traba abierta se lee de la línea ⛔ y la resuelta no cuenta', blockerIn('- ⛔ **Decisión de negocio:** el texto') === 'el texto' && blockerIn('✅ Decisión de negocio resuelta: listo') === null)
  const { jiraSections, visibleRows } = await import('./jira.mjs')
  const dia = 86_400_000
  const filaJ = (key, status, dias, o = {}) => ({ key, status, category: status === 'Draft' ? 'new' : 'indeterminate', updated: 1000 * dia - dias * dia, sessions: [], ...o })
  const filasJ = [filaJ('A-1', 'To Do', 254), filaJ('A-2', 'To Do', 3), filaJ('A-3', 'Bloqueados', 1), filaJ('A-4', 'Revisión', 5), filaJ('A-5', 'Draft', 2), filaJ('A-6', 'Draft', 1, { sessions: [{}] }), filaJ('A-7', 'testing', 1)]
  check('jira: oculta los estados configurados, sin importar mayúsculas', visibleRows(filasJ, ['Testing']).map((r) => r.key).join() === 'A-1,A-2,A-3,A-4,A-5,A-6')
  const secs = jiraSections(visibleRows(filasJ, ['Testing']), { order: ['Bloqueados', 'To Do', 'Draft'], staleDays: 90, now: 1000 * dia })
  check('jira: una sección por estado en el orden pedido, con workspace o en otro estado van a En curso', secs.map((x) => `${x.title}:${x.keys.join('+')}`).join() === 'En curso:A-6+A-4,Bloqueados:A-3,To Do:A-2,Draft:A-5')
  check('jira: lo que no cambia hace más de 90 días va aparte', secs.find((x) => x.title === 'To Do').staleKeys.join() === 'A-1')
  const { defaultHidden, doneStatuses, hiddenFrom, projectStatuses, trailLine, appendTrail } = await import('./jira.mjs')
  const secsCola = jiraSections([...filasJ, { key: 'A-9', status: 'Done', sessions: [{}], updated: 999 * dia }], { order: ['To Do'], tail: ['Testing', 'Done'], staleDays: 90, now: 1000 * dia })
  check('jira: los estados ocultos por defecto, si se prenden, van al final en su sección, aunque tengan workspace', secsCola.map((x) => x.title).slice(-1).join() === 'Done' && secsCola.at(-1).keys.join() === 'A-9')
  const ests = projectStatuses([{ statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'Done', statusCategory: { key: 'done' } }] }, { statuses: [{ name: 'to do' }, { name: '' }] }])
  check('jira: los estados del proyecto salen de Jira, sin repetir', ests.map((x) => x.name + '/' + x.category).join() === 'To Do/new,Done/done' && projectStatuses(null).length === 0)
  check('jira: por defecto se ocultan Testing y los terminados; sin lista de Jira, «Done»', defaultHidden(['Testing'], ests).join() === 'Testing,Done' && doneStatuses([]).join() === 'Done')
  check('jira: la selección del panel se valida', hiddenFrom('["Testing", 3, ""]').join() === 'Testing' && hiddenFrom('[]').length === 0 && hiddenFrom('x') === null && hiddenFrom(null) === null && hiddenFrom('{}') === null)
  check('jira: la línea del rastro lleva fecha, hora, estados y no imita las marcas del harness', trailLine('To Do', '🚧 Bloq\nueados ⛔✅↪', new Date(2026, 0, 2, 3, 4)) === '- 2026-01-02 03:04 Jira: To Do → Bloq ueados (desde Command Deck)')
  const sinRoadmap = join(tmp, 'sin-roadmap')
  mkdirSync(sinRoadmap)
  check('jira: sin roadmap.md no se crea nada', appendTrail(sinRoadmap, '- x') === false && !existsSync(join(sinRoadmap, 'roadmap.md')))
  const { harnessStateFor, withUsState, withIndexState, jiraConfig: cfgJ } = await import('./jira.mjs')
  check('jira: Testing e In Progress tienen estado del harness por defecto; Done y Bloqueados no', harnessStateFor(cfgJ({ site: 'https://x.test', project: 'ABC', credentials: 'c' }).harnessStates, 'testing') === 'listo-para-probar' && harnessStateFor(undefined, 'Testing') === null && harnessStateFor({ Testing: 'listo-para-probar' }, 'Done') === null)
  check('jira: el mapa de policy.json se valida (estados del harness que no existen se descartan)', JSON.stringify(cfgJ({ site: 'https://x.test', project: 'ABC', credentials: 'c', harnessStates: { Done: 'desplegado', Raro: 'inventado' } }).harnessStates) === '{"Done":"desplegado"}')
  check('jira: el estado de US.md cambia en la viñeta o en línea, sin pisar texto libre', withUsState('# A\n- **Estado:** `en-review` — falta X\n', 'listo-para-probar') === '# A\n- **Estado:** `listo-para-probar` — falta X\n' && withUsState('**Etiqueta:** x · **Estado:** nuevo ·', 'en-progreso') === '**Etiqueta:** x · **Estado:** en-progreso ·' && withUsState('- **Estado:** en curso', 'en-progreso') === null && withUsState('# sin estado', 'en-progreso') === null && withUsState('- **Estado:** en-progreso', 'en-progreso') === null)
  check('jira: el estado de INDEX.md cambia solo en la fila del ticket', withIndexState('| A-1 | `x` | `en-review` | a |\n| A-10 | `en-review` |', 'A-1', 'listo-para-probar') === '| A-1 | `x` | `listo-para-probar` | a |\n| A-10 | `en-review` |' && withIndexState('| A-2 | `nuevo` |', 'A-1', 'en-progreso') === null)
  writeFileSync(join(sinRoadmap, 'roadmap.md'), '# R\n- a')
  appendTrail(sinRoadmap, '- b')
  check('jira: el rastro va en su propio renglón aunque el archivo no termine en salto', readFileSync(join(sinRoadmap, 'roadmap.md'), 'utf8') === '# R\n- a\n- b\n')
  const n0 = jiraNews(null, ['ABC-1'], 10)
  check('jira: la primera vuelta solo toma nota', n0.fresh.length === 0 && n0.known['ABC-1'] === 0)
  const n1 = jiraNews(n0.known, ['ABC-1', 'ABC-2'], 20)
  check('jira: avisa el ticket que te asignaron, una vez', n1.fresh.join() === 'ABC-2' && n1.known['ABC-2'] === 20 && jiraNews(n1.known, ['ABC-1', 'ABC-2'], 30).fresh.length === 0)
  const n2 = jiraNews(jiraNews(n1.known, ['ABC-1'], 40).known, ['ABC-1', 'ABC-2'], 50)
  check('jira: si te lo sacan y te lo vuelven a asignar, avisa de nuevo', n2.fresh.join() === 'ABC-2' && n2.known['ABC-2'] === 50)
  sh(repo, 'git', 'branch', '-q', 'ABC-8-algo', 'origin/master')
  sh(repo, 'git', 'push', '-q', 'origin', 'ABC-8-algo')
  sh(repo, 'git', 'branch', '-q', '-D', 'ABC-8-algo')
  const [codigoJira, mios] = await call('/api/jira')
  const t8 = mios.issues?.find((t) => t.key === 'ABC-8')
  const t7 = mios.issues?.find((t) => t.key === 'ABC-7')
  check('/api/jira devuelve tus tickets, con workspace primero y sin los de Testing', codigoJira === 200 && mios.enabled && mios.error === null && mios.issues.map((t) => t.key).join() === 'ABC-7,ABC-8')
  check('/api/jira compara todos tus tickets para avisar, también los ocultos', [...mios.allKeys].sort().join() === 'ABC-7,ABC-8,ABC-9')
  check('/api/jira agrupa: en curso (con workspace) primero, después los de categoría new', mios.sections.map((x) => `${x.title}:${x.keys.join('+')}/${x.staleKeys.join('+')}`).join() === 'En curso:ABC-7/,To Do:/ABC-8')
  check('/api/jira arma la descripción breve y el link', t8.brief === 'Hay que mandar los mails desde un solo lugar.' && t8.url === 'https://jira.example.test/browse/ABC-8')
  check('/api/jira marca el ticket que tiene workspace en Orca', t7.sessions.length === 1 && t7.sessions[0].worktreeId === 'r1::/p/abc7' && t8.sessions.length === 0)
  check('/api/jira suma el estado del harness y la traba', t8.harness.state === 'listo-para-deploy' && !t8.harness.deployed && t8.blocker?.startsWith('qué texto ve el cliente') && t7.harness.state === 'en-progreso' && t7.blocker === null)
  // ABC-7 ya está en el remoto desde las pruebas de tickets, y los otros clones lo trajeron al clonar.
  check('/api/jira marca la rama pusheada, según lo que cada repo trajo del remoto', t8.pushed.join() === 'app' && t7.pushed.includes('sin-regla'))
  const pedido = jiraPedidos[0]
  check('jira: consulta tus tickets abiertos del proyecto, con el token solo en el encabezado', jiraPedidos.length === 1 && /project\+%3D\+ABC\+AND\+assignee\+%3D\+currentUser/.test(pedido.url) && !pedido.url.includes('token-de-prueba') && pedido.auth === `Basic ${Buffer.from('persona@example.com:token-de-prueba').toString('base64')}`)
  await call('/api/jira')
  check('jira: la segunda consulta sale de la caché', jiraPedidos.length === 1)
  const [codigoPlan, plan] = await call('/api/jira-start?key=ABC-8&repo=app')
  check('/api/jira-start arma la rama desde origin/<base> y el primer mensaje', codigoPlan === 200 && plan.branch === 'ABC-8-revisar-el-envio-de-mails' && plan.baseRef === 'origin/master' && plan.existing.join() === 'origin/ABC-8-algo' && plan.prompt === 'Arrancamos ABC-8: Revisar el envío de mails (https://jira.example.test/browse/ABC-8)' && plan.agent === 'claude')
  check('/api/jira-start no escribe git ni crea nada', creados.length === 0 && !sh(repo, 'git', 'branch', '--list', 'ABC-8-*').trim())
  check('/api/jira-start rechaza un ticket que no es tuyo', (await call('/api/jira-start?key=ABC-99&repo=app'))[0] === 400 && (await call('/api/jira-start?key=x;rm&repo=app'))[0] === 400)
  const { jiraTargets } = await import('./jira.mjs')
  const reposT = [{ key: '/r/a', name: 'a', path: '/r/a', group: 'G1' }, { key: '/w/a-x', name: 'a-x', path: '/w/a-x', group: 'G1', worktreeOf: '/r/a' }, { key: '/r/b', name: 'b', path: '/r/b', group: 'G2' }]
  const wtsT = [
    { worktreeId: 'b::/r/b', repo: 'b', displayName: 'main', path: '/r/b', branch: 'refs/heads/main', workspaceKind: 'git', agents: [] },
    { worktreeId: 'a::/w/a-x', repo: 'a', displayName: 'X', path: '/w/a-x/', branch: 'refs/heads/x', workspaceKind: 'git', agents: [{ address: 'term_1' }, { orcaSessionId: 'cerrada' }, { orcaSessionId: 'abierta' }] },
    { worktreeId: 'a::/r/a', repo: 'a', displayName: 'Principal', path: '/r/a', branch: 'refs/heads/main', workspaceKind: 'git', agents: [] },
    { worktreeId: 'bot', repo: 'a', path: '/r/a', bot: 'k', workspaceKind: 'git' },
    { worktreeId: 'f:1', path: '/r/a', workspaceKind: 'folder-workspace' }
  ]
  const destinos = jiraTargets(wtsT, reposT, new Set(['abierta']))
  check('jira: los workspaces para arrancar van agrupados por proyecto, en el orden de Orca, sin bots ni carpetas', destinos.map((p) => `${p.group}/${p.project}:${p.workspaces.map((w) => w.name + w.agents).join('+')}`).join() === 'G1/a:X2+Principal0,G2/b:main0')
  const [codigoDest, dest] = await call('/api/jira-targets')
  check('/api/jira-targets lista los workspaces abiertos con el repo para uno nuevo', codigoDest === 200 && dest.projects.length === 1 && dest.projects[0].repo === 'app' && dest.projects[0].workspaces[0].worktreeId === 'r1::/p/app' && dest.projects[0].workspaces[0].agents === 4)
  const [codigoChat, chat] = await call('/api/jira-chat', { key: 'ABC-8', worktreeId: 'r1::/p/app' })
  check('/api/jira-chat abre un chat nativo en ese workspace con el primer mensaje, sin tocar git', codigoChat === 200 && chat.surface === 'chat' && chat.action === 'chat' && chats.length === 1 && chats[0].worktreeId === 'r1::/p/app' && chats[0].agent === 'claude' && chats[0].prompt.startsWith('Arrancamos ABC-8: ') && !sh(repo, 'git', 'branch', '--list', 'ABC-8-*').trim())
  check('/api/jira-chat rechaza un workspace que no está o un ticket ajeno', (await call('/api/jira-chat', { key: 'ABC-8', worktreeId: 'b1::/bots/k' }))[0] === 400 && (await call('/api/jira-chat', { key: 'ABC-99', worktreeId: 'r1::/p/app' }))[0] === 400 && chats.length === 1)
  check('/api/jira-chat recuerda dónde lo arrancaste', JSON.parse(readFileSync(arranques, 'utf8'))['ABC-8'][0].sessionId === 'aaaaaaaa-0000-0000-0000-000000000001')
  const recordado = (await call('/api/jira'))[1].issues.find((t) => t.key === 'ABC-8')
  check('/api/jira muestra el workspace donde lo arrancaste, con sus chats', recordado.sessions.length === 1 && recordado.sessions[0].worktreeId === 'r1::/p/app' && recordado.sessions[0].remembered && recordado.sessions[0].chats === 1 && recordado.sessions[0].terminals === 3)
  const activadosAntes = activados.length
  const [codigoAbrir, abrir] = await call('/api/jira-open', { key: 'ABC-8', worktreeId: 'r1::/p/app' })
  check('/api/jira-open con un chat abierto muestra ese workspace, sin abrir otro chat', codigoAbrir === 200 && abrir.action === 'opened' && activados.length === activadosAntes + 1 && chats.length === 1)
  const [codigoSoloTerm, soloTerm] = await call('/api/jira-open', { key: 'ABC-7', worktreeId: 'r1::/p/abc7' })
  check('/api/jira-open sin chat abre un chat nativo nuevo ahí', codigoSoloTerm === 200 && soloTerm.action === 'chat' && chats.length === 2 && chats[1].worktreeId === 'r1::/p/abc7')
  check('/api/jira-open rechaza un workspace que no es del ticket', (await call('/api/jira-open', { key: 'ABC-7', worktreeId: 'b1::/bots/k' }))[0] === 400)
  const [codigoNuevo, nuevo] = await call('/api/jira-new', { key: 'ABC-8', repo: 'app' })
  check('/api/jira-new crea el workspace con la rama del ticket desde origin/<base>', codigoNuevo === 200 && nuevo.branch === 'ABC-8-revisar-el-envio-de-mails' && nuevo.surface === 'terminal' && creados.length === 1 && creados[0].baseRef === 'origin/master' && creados[0].path === repo && creados[0].branch === nuevo.branch)
  const [codigoTr, tr] = await call('/api/jira-transitions?key=ABC-8')
  check('/api/jira-transitions lista solo lo que Jira ofrece y está disponible', codigoTr === 200 && tr.transitions.map((x) => `${x.id}:${x.name}>${x.to}`).join() === '21:Empezar>En curso,31:Testing>Testing,41:Cerrar>Done' && transPedidos.at(-1).url === 'https://jira.example.test/rest/api/3/issue/ABC-8/transitions' && transPedidos.at(-1).method === 'GET')
  check('/api/jira-transitions rechaza un ticket ajeno o inválido sin consultar Jira', (await call('/api/jira-transitions?key=ABC-99'))[0] === 400 && (await call('/api/jira-transitions?key=x/../y'))[0] === 400 && transPedidos.length === 1)
  check('/api/jira-transition rechaza un id que Jira no ofrece, sin POST', (await call('/api/jira-transition', { key: 'ABC-8', id: '99' }))[0] === 400 && (await call('/api/jira-transition', { key: 'ABC-8', id: '1;x' }))[0] === 400 && !transPedidos.some((x) => x.method === 'POST'))
  const [codigoMal, mal] = await call('/api/jira-transition', { key: 'ABC-8', id: '21' })
  check('/api/jira-transition muestra el error de Jira y deja el estado', codigoMal === 400 && /400: Falta la resolución/.test(mal.error) && !mal.error.includes('token-de-prueba') && (await call('/api/jira'))[1].issues.find((t) => t.key === 'ABC-8').status === 'To Do')
  const [codigoOk, ok] = await call('/api/jira-transition', { key: 'ABC-8', id: '31' })
  const post = transPedidos.filter((x) => x.method === 'POST').at(-1)
  const trasMover = (await call('/api/jira'))[1]
  check('/api/jira-transition hace el POST con el id y las mismas credenciales', codigoOk === 200 && ok.status === 'Testing' && JSON.parse(post.body).transition.id === '31' && post.auth === `Basic ${Buffer.from('persona@example.com:token-de-prueba').toString('base64')}`)
  check('/api/jira-transition: la lista toma el estado nuevo (Testing se oculta)', !trasMover.issues.some((t) => t.key === 'ABC-8') && trasMover.allKeys.includes('ABC-8'))
  const roadmap8 = join(tickets, 'ABC-8-mails/roadmap.md')
  const us8 = readFileSync(join(tickets, 'ABC-8-mails/US.md'), 'utf8')
  check('/api/jira-transition deja el rastro al final del roadmap.md del ticket', ok.trail === 'ok' && ok.from === 'To Do' && /\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} Jira: To Do → Testing \(desde Command Deck\)\n$/.test(readFileSync(roadmap8, 'utf8')) && readFileSync(roadmap8, 'utf8').startsWith('# Roadmap\n\n- ⛔'))
  check('/api/jira-transition a Testing pasa el US.md a listo-para-probar, sin tocar el resto', ok.stateWrite === 'ok' && ok.harnessState === 'listo-para-probar' && readFileSync(join(tickets, 'ABC-8-mails/US.md'), 'utf8') === us8.replace('listo-para-deploy', 'listo-para-probar'))
  const index0 = readFileSync(join(tickets, 'INDEX.md'), 'utf8')
  const [codigo7, mov7] = await call('/api/jira-transition', { key: 'ABC-7', id: '31' })
  check('/api/jira-transition sin roadmap.md no crea nada', codigo7 === 200 && mov7.trail === 'none' && !existsSync(join(tickets, 'ABC-7-prueba/roadmap.md')))
  check('/api/jira-transition cambia la fila de INDEX.md y no pisa un estado de US.md que no es de los fijos', mov7.stateWrite === 'ok' && readFileSync(join(tickets, 'INDEX.md'), 'utf8') === index0.replace('`en-progreso`', '`listo-para-probar`') && readFileSync(join(tickets, 'ABC-7-prueba/US.md'), 'utf8').includes('en curso'))
  chmodSync(roadmap8, 0o444)
  const [codigoRo, ro] = await call('/api/jira-transition', { key: 'ABC-8', id: '31' })
  chmodSync(roadmap8, 0o644)
  check('/api/jira-transition: si no puede escribir el rastro, la transición cuenta igual y lo avisa', codigoRo === 200 && ro.status === 'Testing' && ro.trail === 'error' && ro.trailError)
  const [, porDefecto] = await call('/api/jira')
  check('/api/jira lista los estados de Jira y oculta por defecto Testing y los terminados', porDefecto.statuses.map((x) => x.name).join() === 'To Do,En curso,Testing,Done' && porDefecto.hidden.join() === 'Testing,Done' && porDefecto.done === null && terminadosPedidos.length === 0 && estadosPedidos.length === 1)
  const [codigoTodos, todos] = await call('/api/jira?hide=' + encodeURIComponent('[]'))
  const jqlDone = decodeURIComponent(terminadosPedidos[0]?.replace(/\+/g, ' ') ?? '')
  check('/api/jira con Testing y Done prendidos los trae, con Done limitado a 30 días y 50', codigoTodos === 200 && ['ABC-5', 'ABC-7', 'ABC-8'].every((k) => todos.issues.some((t) => t.key === k)) && jqlDone.includes('updated >= -30d') && jqlDone.includes('maxResults=50') && todos.done.days === 30 && todos.done.max === 50 && todos.done.count === 1)
  check('/api/jira: Testing y Done van en su sección al final; los avisos siguen comparando solo los abiertos', todos.sections.map((x) => x.title).slice(-2).join() === 'Testing,Done' && todos.sections.find((x) => x.title === 'Done').keys.join() === 'ABC-5' && !todos.allKeys.includes('ABC-5'))
  const [, soloDone] = await call('/api/jira?hide=' + encodeURIComponent(JSON.stringify(['To Do', 'En curso', 'Testing'])))
  check('/api/jira respeta la selección del panel', soloDone.issues.map((t) => t.key).join() === 'ABC-5' && soloDone.hidden.join() === 'To Do,En curso,Testing' && estadosPedidos.length === 1)
  const caido = await startServer({ orca: orcaFalso, jiraFetch: async () => new Response('{}', { status: 401 }) })
  const rCaido = await fetch(`http://127.0.0.1:${caido.port}/api/jira`, { headers: { 'X-Token': caido.token } })
  const jCaido = await rCaido.json()
  caido.close()
  check('jira: si Jira rechaza, el panel recibe el error sin el token y sin romperse', rCaido.status === 200 && jCaido.enabled && jCaido.issues.length === 0 && /401/.test(jCaido.error) && !JSON.stringify(jCaido).includes('token-de-prueba'))
  // El panel corre app.js entero de una: una función que se llama y no existe corta todo lo que viene después (pasó
  // con loadNotices: la pestaña Git quedaba vacía). Cada llamada a un nombre suelto tiene que estar declarada.
  const appSrc = readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/(?![*/])(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, '0')
  const declaradas = new Set()
  for (const m of appSrc.matchAll(/\bfunction\s*(\w*)\s*\(([^)]*)\)/g)) [m[1], ...m[2].split(',')].map((x) => x.trim()).filter(Boolean).forEach((x) => declaradas.add(x))
  for (const m of appSrc.matchAll(/\bvar\s+([^;=]+)/g)) m[1].split(',').forEach((x) => declaradas.add(x.trim().split(/\s/)[0]))
  const NATIVAS = ['if', 'for', 'while', 'switch', 'function', 'return', 'catch', 'typeof', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Number', 'String', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'Date', 'Error', 'RegExp', 'Array', 'Object', 'Promise', 'ResizeObserver', 'fetch', 'requestAnimationFrame', 'Set', 'Map', 'KeyboardEvent', 'URLSearchParams', 'matchMedia']
  const sueltas = [...new Set([...appSrc.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))].filter((x) => !declaradas.has(x) && !NATIVAS.includes(x))
  check(`app.js: toda función que se llama está declarada${sueltas.length ? ` (faltan: ${sueltas.join(', ')})` : ''}`, sueltas.length === 0)
} finally {
  close()
}
console.log(failures ? `\n${failures} FALLAS` : '\nTODO OK')
process.exit(failures ? 1 : 0)
