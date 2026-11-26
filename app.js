(function () {
'use strict'
// Un error que corta el script deja la pantalla a medio dibujar: se muestra arriba en vez de quedar mudo.
window.addEventListener('error', function (e) { showFatal(e.message + ' (' + e.lineno + ')') })
window.addEventListener('unhandledrejection', function (e) { showFatal(String((e.reason && e.reason.message) || e.reason)) })
function showFatal(text) {
  var box = document.getElementById('alerts')
  if (!box) return
  var n = document.createElement('div')
  n.className = 'alert'
  n.style.setProperty('--c', 'var(--c-blocked)')
  n.textContent = 'Error: ' + text
  box.appendChild(n)
}
var TOKEN = new URLSearchParams(location.search).get('t')
var PANEL = !!(window.orca && window.orca.plugin)
// Las escrituras de git pueden tardar hasta dos minutos en el servidor.
var PANEL_REQUEST_MS = 130000
// En el panel, Orca pone la clase light o dark en <html>; en la pestaña se sigue al sistema.
if (!PANEL) {
  var lightQuery = matchMedia('(prefers-color-scheme: light)')
  var paintTheme = function () { document.documentElement.classList.toggle('light', lightQuery.matches) }
  paintTheme()
  lightQuery.addEventListener('change', paintTheme)
}
var data = []
var snapshot = ''
var expanded = {}
var tab = {}
var drafts = {}
var logs = {}
var selected = ''
var closedSpaces = readClosed()
// Cada render rehace los botones: lo que está en curso se guarda acá y no en el botón.
var busy = {}
var diffRequest = 0
var OFFLINE_POLLS = 3
var SPLIT_WIDTH = 900
var MAX_WORD_DIFF = 2000
var MIN_SAME_RATIO = 0.3
var TAIL_CHARS = 12
var SHORT_BRANCH = 24
var filter = ''
var firstRank = null
var lastDiff = null
var splitShown = false
var offline = 0
var lostToast = false
var BUSY_TEXT = {
  stage: 'Pasando a Staged', unstage: 'Sacando de Staged', stage_all: 'Pasando a Staged', unstage_all: 'Sacando de Staged',
  discard: 'Descartando', commit: 'Commiteando', push: 'Subiendo', pull: 'Trayendo', fetch: 'Consultando el remoto',
  switch: 'Cambiando de rama', create_branch: 'Creando la rama'
}
var list = document.getElementById('list')
var find = document.getElementById('find')

var ICONS = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  lock: '<rect width="16" height="11" x="4" y="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  fetch: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  pull: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  push: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'
}
function svg(name, size) {
  var wrap = document.createElement('span')
  var s = size || 14
  wrap.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>'
  return wrap.firstChild
}
function readClosed() {
  try {
    return JSON.parse(localStorage.getItem('closedSpaces')) || {}
  } catch (e) {
    return {} // sin almacenamiento, todos los grupos arrancan abiertos
  }
}
function saveClosed() { store('closedSpaces', closedSpaces) }
function el(tag, cls, text) {
  var n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
function answer(status, j) {
  if (status >= 400) throw Object.assign(new Error((j && j.error) || 'Error'), { sensitive: j && j.sensitive })
  return j
}
// Sin respuesta del servidor: el servicio se reinicia al actualizarse, o el worker del plugin no arrancó.
function lost(e) {
  return Object.assign(new Error((e && e.message) || 'Sin conexión'), { offline: true })
}
// En la pestaña del navegador habla directo con el servidor; en el panel lateral de Orca, que no puede abrir conexiones,
// a través del worker del plugin. Sin body es un GET.
function send(path, body) {
  if (PANEL) {
    return orca.plugin.request('api', { path: path, body: body === undefined ? null : body }, { timeoutMs: PANEL_REQUEST_MS })
      .then(function (r) { return answer(r.status, r.data) }, function (e) { throw lost(e) })
  }
  var init = body === undefined
    ? { headers: { 'X-Token': TOKEN } }
    : { method: 'POST', headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  return fetch(path, init).then(function (r) {
    return r.json().then(function (j) { return answer(r.status, j) })
  }, function (e) { throw lost(e) })
}
function api(path) { return send(path) }
function toast(text, ok) {
  var t = document.getElementById('toast')
  t.textContent = text
  t.className = ok ? '' : 'bad'
  t.style.display = 'block'
  if (ok) setTimeout(function () { t.style.display = 'none' }, 2500)
}
document.getElementById('toast').onclick = function () { this.style.display = 'none' }
// Una cosa por repo a la vez: un segundo clic haría el commit dos veces o abriría otra terminal.
function whileBusy(repo, text, work) {
  if (busy[repo]) return Promise.resolve()
  busy[repo] = text
  render()
  return work().finally(function () {
    delete busy[repo]
    render()
  })
}
function act(repo, action, extra, okText) {
  var body = Object.assign({ repo: repo, action: action }, extra || {})
  return whileBusy(repo, BUSY_TEXT[action], function () {
    return send('/api/action', body).then(function () {
      if (okText) toast(okText, true)
      delete logs[repo]
      return load(true)
    }).catch(function (e) {
      if (e.sensitive) sensitiveDialog(repo, action, extra, okText, e.sensitive)
      else toast(e.message)
    })
  })
}
// Marca solo lo que cambió dentro de la línea: alcanza con recortar lo común de cada punta.
function changedRange(text, other) {
  if (text.length > MAX_WORD_DIFF || other.length > MAX_WORD_DIFF) return null
  var max = Math.min(text.length, other.length)
  var start = 0
  while (start < max && text[start] === other[start]) start++
  var end = 0
  while (end < max - start && text[text.length - 1 - end] === other[other.length - 1 - end]) end++
  if (start + end === text.length || (start + end) / text.length < MIN_SAME_RATIO) return null
  return [start, text.length - end]
}
function lineNode(tag, cls, sign, text, other) {
  var n = el(tag, cls)
  var range = other === undefined ? null : changedRange(text, other)
  if (!range) {
    n.textContent = sign + text || ' '
    return n
  }
  n.appendChild(document.createTextNode(sign + text.slice(0, range[0])))
  n.appendChild(el('span', 'w', text.slice(range[0], range[1])))
  n.appendChild(document.createTextNode(text.slice(range[1])))
  return n
}
function diffItems(text) {
  var items = []
  var del = []
  var add = []
  var inHunk = false
  function flush() {
    if (del.length || add.length) items.push({ del: del, add: add })
    del = []
    add = []
  }
  text.split('\n').forEach(function (line) {
    if (/^diff /.test(line)) inHunk = false
    if (inHunk && line[0] === '-') return del.push(line.slice(1))
    if (inHunk && line[0] === '+') return add.push(line.slice(1))
    flush()
    if (/^@@/.test(line)) inHunk = true
    var kind = /^@@/.test(line) ? 'hunk' : inHunk ? 'same' : /^(diff |index |\+\+\+|---)/.test(line) ? 'meta-line' : ''
    items.push({ kind: kind, line: line })
  })
  flush()
  return items
}
function unifiedItem(pre, item) {
  if (!item.del && !item.add) return pre.appendChild(el('div', item.kind === 'same' ? '' : item.kind, item.line || ' '))
  item.del.forEach(function (l, i) { pre.appendChild(lineNode('div', 'del', '-', l, item.add[i])) })
  item.add.forEach(function (l, i) { pre.appendChild(lineNode('div', 'add', '+', l, item.del[i])) })
}
function splitItem(pre, item) {
  var row
  if (item.kind === 'same') {
    row = el('div', 'sb')
    row.appendChild(el('span', '', item.line.slice(1) || ' '))
    row.appendChild(el('span', '', item.line.slice(1) || ' '))
    return pre.appendChild(row)
  }
  if (!item.del) return unifiedItem(pre, item)
  for (var i = 0; i < Math.max(item.del.length, item.add.length); i++) {
    row = el('div', 'sb')
    row.appendChild(i < item.del.length ? lineNode('span', 'del', '', item.del[i], item.add[i]) : el('span', '', ' '))
    row.appendChild(i < item.add.length ? lineNode('span', 'add', '', item.add[i], item.del[i]) : el('span', '', ' '))
    pre.appendChild(row)
  }
}
function paintDiff() {
  var pre = document.getElementById('diff')
  splitShown = document.getElementById('main').clientWidth >= SPLIT_WIDTH
  pre.textContent = ''
  diffItems(lastDiff).forEach(function (item) { (splitShown ? splitItem : unifiedItem)(pre, item) })
}
function showDiff(title, text) {
  document.getElementById('title').textContent = title
  var pre = document.getElementById('diff')
  pre.hidden = false
  lastDiff = text
  paintDiff()
  pre.scrollTop = 0
}
new ResizeObserver(function () {
  var wide = document.getElementById('main').clientWidth >= SPLIT_WIDTH
  if (lastDiff !== null && wide !== splitShown) paintDiff()
}).observe(document.getElementById('main'))
// El diff solo ocupa lugar mientras hay algo abierto: sin nada elegido, la lista usa todo el ancho.
function closeDiff() {
  if (!document.body.classList.contains('detail')) return false
  diffRequest++
  document.body.classList.remove('detail')
  document.getElementById('diff').hidden = true
  lastDiff = null
  if (selected) { selected = ''; render() }
  return true
}
document.getElementById('back').appendChild(svg('back'))
document.getElementById('back').onclick = closeDiff
document.getElementById('close').appendChild(svg('close'))
document.getElementById('close').onclick = closeDiff
// Si se elige otro archivo antes de que llegue la respuesta, gana el último elegido.
function openDiff(title, query) {
  var request = ++diffRequest
  var heading = document.getElementById('title')
  heading.textContent = 'Cargando…'
  document.getElementById('diff').hidden = true
  document.body.classList.add('detail')
  api(query).then(function (j) {
    if (request === diffRequest) showDiff(title, j.diff || 'Sin diferencias de texto')
  }).catch(function (e) {
    if (request === diffRequest) closeDiff()
    toast(e.message)
  })
}
function openFile(r, f, staged) {
  selected = r.key + '|' + staged + '|' + f.p
  render()
  openDiff(r.name + ' · ' + f.p, '/api/diff?repo=' + encodeURIComponent(r.key) + '&path=' + encodeURIComponent(f.p) + '&staged=' + (staged ? 1 : 0))
}
function iconBtn(name, title, fn) {
  var b = el('button', 'icon')
  b.title = title
  b.setAttribute('aria-label', title)
  b.appendChild(svg(name))
  b.onclick = function (e) { e.stopPropagation(); fn() }
  return b
}
function fileRow(r, f, staged) {
  var row = el('div', 'row' + (selected === r.key + '|' + staged + '|' + f.p ? ' on' : ''))
  row.appendChild(el('span', 'st ' + f.s, f.s))
  var p = el('span', 'path' + (f.sensitive ? ' warn' : ''), f.p)
  p.title = f.sensitive ? 'Parece un secreto: ' + f.p : f.p
  row.appendChild(p)
  row.onclick = function () { openFile(r, f, staged) }
  if (!staged) row.appendChild(iconBtn('undo', f.new ? 'Borrar archivo nuevo' : 'Descartar cambios', function () { discardDialog(r, f) }))
  row.appendChild(iconBtn(staged ? 'minus' : 'plus', staged ? 'Sacar de Staged' : 'Pasar a Staged', function () {
    act(r.key, staged ? 'unstage' : 'stage', { path: f.p })
  }))
  return row
}
function group(r, label, files, staged, wrap) {
  if (!files.length) return
  var g = el('div', 'group')
  g.appendChild(el('span', 'grow', label + ' · ' + files.length))
  g.appendChild(iconBtn(staged ? 'minus' : 'plus', staged ? 'Sacar todo de Staged' : 'Pasar todo a Staged', function () {
    act(r.key, staged ? 'unstage_all' : 'stage_all')
  }))
  wrap.appendChild(g)
  files.forEach(function (f) { wrap.appendChild(fileRow(r, f, staged)) })
}
// Subir y traer quedan a la vista: el commit es local y sin esto no se nota que falta el push.
function syncButtons(r, blocked) {
  var out = []
  function add(label, fn) {
    var b = el('button', 'commit ghost', label)
    b.onclick = fn
    out.push(b)
  }
  // Con algo en Staged, un Push suelto parece que sube eso también: ahí va «Commit y Push».
  var pending = r.staged.length
  if (!blocked && !pending && !r.upstream) add('Publicar rama', function () { pushDialog(r) })
  else if (!blocked && !pending && r.ahead) add('Push ↑' + r.ahead, function () { pushDialog(r) })
  if (r.behind) add('Pull ↓' + r.behind, function () { act(r.key, 'pull', null, 'Pull listo') })
  if (r.pr) {
    var link = el('a', 'commit ghost', 'Abrir PR')
    link.href = r.pr
    link.target = '_blank'
    // El panel es un frame aislado: los enlaces salen por Orca, que pide confirmación.
    if (PANEL) link.onclick = function (e) { e.preventDefault(); if (orca.shell) orca.shell.openExternal(r.pr) }
    link.rel = 'noopener noreferrer'
    out.push(link)
  }
  return out
}
function changesView(r, wrap) {
  var blocked = r.protected || r.detached
  var box = el('textarea')
  box.rows = 2
  box.placeholder = 'Mensaje de commit'
  box.value = drafts[r.key] || ''
  box.oninput = function () { drafts[r.key] = box.value }
  function commit(thenPush) {
    act(r.key, 'commit', { message: box.value }, 'Commit hecho').then(function () {
      var now = data.find(function (x) { return x.key === r.key })
      if (!now || now.staged.length) return // falló: el aviso de error ya se mostró
      drafts[r.key] = ''
      render()
      if (thenPush) pushDialog(now)
    })
  }
  box.onkeydown = function (e) { if (e.key === 'Enter' && e.ctrlKey && !blocked) commit(false) }
  wrap.appendChild(box)
  var buttons = el('div', 'commit-row')
  var btn = el('button', 'commit', 'Commit')
  btn.disabled = blocked || !r.staged.length
  btn.title = 'Ctrl+Enter'
  btn.onclick = function () { commit(false) }
  buttons.appendChild(btn)
  if (!blocked) {
    var both = el('button', 'commit ghost', r.ahead ? 'Commit y Push ↑' + (r.ahead + 1) : 'Commit y Push')
    both.disabled = !r.staged.length
    both.onclick = function () { commit(true) }
    buttons.appendChild(both)
  }
  wrap.appendChild(buttons)
  syncButtons(r, blocked).forEach(function (b) { wrap.appendChild(b) })
  if (blocked) wrap.appendChild(el('div', 'note', r.detached ? 'HEAD suelto: cambiá a una rama para commitear.' : r.branch + ' está protegida. Creá una rama desde origin/' + r.base + ' tocando el nombre de la rama.'))
  if (r.crossedUpstream) wrap.appendChild(el('div', 'note warn', 'Esta rama sigue a ' + r.crossedUpstream + ': un git push a secas desde la terminal sube ahí.'))
  if (r.ticket) wrap.appendChild(el('div', 'note', ticketNote(r.ticket)))
  if (r.staged.some(function (f) { return f.sensitive })) wrap.appendChild(el('div', 'note warn', 'Hay archivos en Staged que parecen secretos.'))
  group(r, 'Staged', r.staged, true, wrap)
  group(r, 'Cambios', r.changes, false, wrap)
  if (!r.staged.length && !r.changes.length) wrap.appendChild(el('div', 'note', 'Sin cambios.'))
}
function historyView(r, wrap) {
  if (!logs[r.key]) {
    api('/api/history?repo=' + encodeURIComponent(r.key)).then(function (j) { logs[r.key] = j; render() }).catch(function (e) { toast(e.message) })
    wrap.appendChild(el('div', 'meta', 'Cargando…'))
    return
  }
  logs[r.key].forEach(function (c) {
    var item = el('div', 'log')
    item.appendChild(el('div', '', c.t))
    item.appendChild(el('div', 'meta', c.h + ' · ' + c.a + ' · ' + c.w))
    item.title = c.r || ''
    item.onclick = function () { openDiff(r.name + ' · ' + c.t, '/api/commit?repo=' + encodeURIComponent(r.key) + '&h=' + c.h) }
    wrap.appendChild(item)
  })
}
function closeModal() { document.getElementById('modal').style.display = 'none' }
document.getElementById('modal').onclick = function (e) { if (e.target === this) closeModal() }
// Esc cierra primero el diálogo y, si no hay ninguno, el diff.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return
  var modal = document.getElementById('modal')
  if (modal.style.display && modal.style.display !== 'none') closeModal()
  else if (!/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) closeDiff()
})
// El botón que queda con foco siempre es la salida segura.
function ticketNote(t) {
  var parts = [t.id]
  if (t.state) parts.push(t.state)
  if (t.testMissing) parts.push('falta test.md')
  if (t.deployPending) parts.push('deploy.md con pasos a mano')
  return parts.join(' · ')
}
function dialog(title, lines, items, actions) {
  var box = document.getElementById('box')
  box.textContent = ''
  var d = el('div', 'dlg')
  d.appendChild(el('h2', '', title))
  lines.forEach(function (l) { d.appendChild(el('p', l.warn ? 'warn' : '', l.text)) })
  if (items.length) {
    var ul = el('ul')
    items.forEach(function (item) { ul.appendChild(item) })
    d.appendChild(ul)
  }
  var acts = el('div', 'acts')
  var safe = null
  actions.forEach(function (a) {
    var b = el('button', a.kind || '', a.label)
    b.onclick = function () { closeModal(); if (a.run) a.run() }
    acts.appendChild(b)
    if (a.safe) safe = b
  })
  d.appendChild(acts)
  box.appendChild(d)
  document.getElementById('modal').style.display = 'flex'
  if (safe) safe.focus()
}
function fileItem(path) {
  var li = el('li', '', path)
  li.title = path
  return li
}
function sensitiveDialog(repo, action, extra, okText, files) {
  var with_ = function (allow) { return Object.assign({}, extra || {}, { allow: allow }) }
  var actions = [{ label: 'Cancelar', safe: action !== 'stage_all' }]
  if (action === 'stage_all') actions.push({ label: 'Agregar el resto', kind: 'primary', safe: true, run: function () { act(repo, action, with_('skip'), okText) } })
  actions.push({ label: action === 'stage_all' ? 'Agregar todo igual' : 'Agregar igual', kind: 'danger', run: function () { act(repo, action, with_('all'), okText) } })
  dialog('Esto parece un secreto', [{ text: 'Si entra en un commit y lo subís, queda en el historial del remoto aunque después lo borres.' }], files.map(fileItem), actions)
}
function runInTerminal(r, command, extra) {
  whileBusy(r.key, 'Abriendo la terminal', function () {
    return send('/api/run', Object.assign({ repo: r.key, command: command }, extra || {})).catch(function (e) { toast(e.message) })
  })
}
function commandClick(r, c) {
  if (!c.warn || !r.deploys) return runInTerminal(r, c.id)
  dialog(c.label, [
    { warn: true, text: 'En este repo, lo que llega a ' + r.base + ' por push se despliega.' },
    { text: 'Se abre una terminal con tu comando. Antes del push te va a pedir confirmación ahí.' }
  ], [fileItem(c.run)], [
    { label: 'Cancelar', safe: true },
    { label: 'Abrir terminal', kind: 'primary', run: function () { runInTerminal(r, c.id) } }
  ])
}
function newWorktreeDialog(r) {
  var input = el('input')
  input.placeholder = 'Nombre de la rama'
  function create() {
    var branch = input.value.trim()
    closeModal()
    if (branch) runInTerminal(r, 'wt-create', { branch: branch })
  }
  dialog('Nuevo worktree de ' + r.name, [{ text: 'Si la rama no existe, se crea desde origin/' + r.base + '. Si ya existe, se usa esa.' }], [], [
    { label: 'Cancelar' },
    { label: 'Crear', kind: 'primary', run: create }
  ])
  var d = document.querySelector('.dlg')
  d.insertBefore(input, d.querySelector('.acts'))
  input.onkeydown = function (e) { if (e.key === 'Enter') create() }
  input.focus()
}
function removeWorktreeDialog(r) {
  var dirty = r.staged.length + r.changes.length
  if (!r.detached) {
    return dialog('Borrar worktree', [{ text: 'Se abre una terminal con tu comando. Si hay cambios sin commitear, se frena ahí.' }], [fileItem(r.branch)], [
      { label: 'Cancelar', safe: true },
      { label: 'Borrar', kind: 'danger', run: function () { runInTerminal(r, 'wt-remove') } }
    ])
  }
  // Detached no tiene rama que quede: se borra la carpeta y lo que no esté commiteado se pierde.
  var lines = [{ text: 'Está detached: no hay rama que quede. Se abre una terminal con git worktree remove.' }]
  if (dirty) lines.unshift({ warn: true, text: 'Tiene ' + dirty + ' cambio(s) sin commitear: se pierden y no se pueden recuperar.' })
  dialog('Borrar worktree', lines, [fileItem(r.name)], [
    { label: 'Cancelar', safe: true },
    { label: dirty ? 'Borrar con los cambios' : 'Borrar', kind: 'danger', run: function () { runInTerminal(r, 'wt-remove', dirty ? { force: true } : null) } }
  ])
}
function moreActions(r, wrap) {
  var row = el('div', 'more')
  function add(label, hint, fn, cls) {
    var b = el('button', 'chip' + (cls || ''), label)
    b.title = hint
    b.onclick = fn
    row.appendChild(b)
  }
  // Un merge frenado va primero: es lo que hay que resolver antes que nada.
  r.commands.filter(function (c) { return c.urgent }).forEach(function (c) { add(c.label, c.hint, function () { commandClick(r, c) }, ' on') })
  r.commands.filter(function (c) { return !c.urgent }).forEach(function (c) { add(c.label, c.hint, function () { commandClick(r, c) }) })
  if (r.canCreateWorktree && !r.worktreeOf) add('Nuevo worktree', 'Otra carpeta del repo, en su propia rama', function () { newWorktreeDialog(r) })
  if (r.canRemoveWorktree && r.worktreeOf) add('Borrar worktree', 'Borra la carpeta; la rama queda', function () { removeWorktreeDialog(r) })
  if (row.firstChild) wrap.appendChild(row)
}
function discardDialog(r, f) {
  var text = f.new ? 'Es un archivo nuevo: se borra del disco y no se puede recuperar.' : 'Vuelve a la última versión guardada. Lo que cambiaste se pierde y no se puede recuperar.'
  dialog(f.new ? 'Borrar archivo nuevo' : 'Descartar cambios', [{ text: text }], [fileItem(f.p)], [
    { label: 'Cancelar', safe: true },
    { label: f.new ? 'Borrar' : 'Descartar', kind: 'danger', run: function () { act(r.key, 'discard', { path: f.p }, 'Cambios descartados') } }
  ])
}
function pushDialog(r) {
  whileBusy(r.key, 'Revisando qué se sube', function () { return api('/api/push?repo=' + encodeURIComponent(r.key)).then(function (j) {
    var run = function () { act(r.key, 'push', null, 'Push listo') }
    var lines = [{ text: j.remote }]
    if (j.deploysBase) lines.push({ warn: true, text: 'En este repo, lo que llega a ' + j.deploysBase + ' por push se despliega.' })
    if (j.crossedUpstream) lines.push({ warn: true, text: 'Esta rama sigue a ' + j.crossedUpstream + '. Desde acá sube a origin/' + j.branch + ' y corrige el seguimiento.' })
    if (j.sensitive.length) lines.push({ warn: true, text: 'Estos commits tocan archivos que parecen secretos: ' + j.sensitive.join(', ') })
    if (j.contentHits.length) lines.push({ warn: true, text: 'Lo agregado parece tener datos sensibles: ' + j.contentHits.join(', ') })
    if (j.scanFailed) lines.push({ warn: true, text: 'No se pudo revisar el contenido en busca de datos sensibles.' })
    if (j.ticket && j.ticket.testMissing) lines.push({ text: j.ticket.id + ': falta test.md.' })
    if (j.ticket && j.ticket.deployPending) lines.push({ text: j.ticket.id + ': deploy.md tiene pasos a mano.' })
    if (j.isNew) lines.push({ text: 'La rama todavía no existe en el remoto: se va a crear.' })
    var items = j.commits.map(function (c) {
      var li = el('li')
      li.appendChild(el('span', '', c.h + ' '))
      li.appendChild(document.createTextNode(c.t))
      li.title = c.t
      return li
    })
    var more = j.count - j.commits.length
    if (more > 0) items.push(el('li', '', 'y ' + more + ' más'))
    var nothing = !j.isNew && !j.count
    var title = nothing ? 'Nada para subir en ' + j.branch : 'Subir ' + j.count + (j.count === 1 ? ' commit' : ' commits') + ' de ' + j.branch
    var risky = !!(j.deploysBase || j.sensitive.length || j.contentHits.length || j.scanFailed)
    var actions = [{ label: nothing ? 'Cerrar' : 'Cancelar', safe: nothing || risky }]
    if (!nothing) actions.push({ label: risky ? 'Subir igual' : 'Subir', kind: risky ? 'danger' : 'primary', safe: !risky, run: run })
    dialog(title, lines, items, actions)
  }).catch(function (e) { toast(e.message) }) })
}
function branchPicker(r) {
  whileBusy(r.key, 'Cargando las ramas', function () { return api('/api/branches?repo=' + encodeURIComponent(r.key)).then(function (j) {
    var box = document.getElementById('box')
    box.textContent = ''
    var input = el('input')
    input.placeholder = 'Buscar rama o escribir una nueva'
    box.appendChild(input)
    var options = el('div', 'list')
    box.appendChild(options)
    function option(text, meta, fn) {
      var o = el('div', 'opt')
      o.appendChild(el('span', '', text))
      o.appendChild(el('span', 'meta', meta))
      o.onclick = fn
      options.appendChild(o)
    }
    function paint() {
      var term = input.value.trim()
      options.textContent = ''
      if (term) option('Crear ' + term, 'desde origin/' + r.base, function () {
        closeModal()
        act(r.key, 'create_branch', { branch: term }, 'Rama ' + term + ' creada')
      })
      j.local.concat(j.remote).forEach(function (b) {
        if (b.n.toLowerCase().indexOf(term.toLowerCase()) < 0 || b.n === r.branch) return
        option(b.n, b.w, function () {
          closeModal()
          act(r.key, 'switch', { branch: b.n }, 'Ahora en ' + b.n)
        })
      })
    }
    input.oninput = paint
    paint()
    document.getElementById('modal').style.display = 'flex'
    input.focus()
  }).catch(function (e) { toast(e.message) }) })
}
function folderIcon(r) {
  var icon = svg('folder')
  icon.setAttribute('class', 'folder')
  if (r.color) icon.style.color = r.color // el color que el repo tiene en Orca
  return icon
}
function dot(cls, title) {
  var d = el('span', 'dot' + cls)
  d.title = title
  return d
}
function repoView(r) {
  var wrap = el('section')
  var open = !!expanded[r.key]
  var h = el('div', 'repo' + (open ? ' open' : '') + (r.worktreeOf ? ' wt' : '') + (busy[r.key] ? ' busy' : ''))
  if (r.worktreeOf) h.title = 'Worktree'
  var chev = svg('chevron', 12)
  chev.setAttribute('class', 'chev' + (open ? ' down' : ''))
  h.appendChild(chev)
  h.appendChild(folderIcon(r))
  h.appendChild(el('span', 'name', r.name))
  if (FILTERS.cambios.test(r)) h.appendChild(dot('', 'Tiene cambios'))
  if (FILTERS.subir.test(r)) h.appendChild(dot(' up', 'Tiene commits sin subir'))
  var chip = el('button', 'branch' + (r.protected ? ' locked' : ''))
  chip.title = (r.protected ? 'Rama protegida. ' : '') + 'Cambiar de rama'
  chip.appendChild(svg(r.protected ? 'lock' : 'branch', 12))
  // Recorta el medio: en ramas largas lo que distingue suele estar al principio y al final.
  if (r.branch.length > SHORT_BRANCH) {
    chip.title = r.branch + (r.protected ? ' (protegida)' : '')
    chip.appendChild(el('span', '', r.branch.slice(0, -TAIL_CHARS)))
    chip.appendChild(el('span', 'tail', r.branch.slice(-TAIL_CHARS)))
  } else chip.appendChild(el('span', '', r.branch))
  chip.onclick = function (e) { e.stopPropagation(); branchPicker(r) }
  h.appendChild(chip)
  h.appendChild(el('span', 'grow'))
  var dirty = r.staged.length + r.changes.length
  if (r.ticket && r.ticket.state) {
    var ticket = el('span', 'count', r.ticket.state)
    ticket.title = ticketNote(r.ticket)
    h.appendChild(ticket)
  }
  if (r.merged) {
    var merged = el('span', 'count merged', r.merged === 'remote' ? 'mergeada' : 'mergeada sin pushear')
    merged.title = r.merged === 'remote'
      ? 'Esta rama ya está entera en origin/' + r.base
      : 'Esta rama ya está en ' + r.base + ' local, pero falta el push de ' + r.base
    h.appendChild(merged)
  }
  if (dirty) h.appendChild(el('span', 'count dirty', String(dirty)))
  var sync = (r.ahead ? '↑' + r.ahead + ' ' : '') + (r.behind ? '↓' + r.behind : '')
  if (sync) h.appendChild(el('span', 'count', sync.trim()))
  if (isUnpublished(r)) {
    var mark = el('span', 'count', 'sin publicar')
    mark.title = 'Esta rama todavía no existe en el remoto'
    h.appendChild(mark)
  }
  var tools = el('span', 'tools')
  tools.appendChild(iconBtn('fetch', 'Fetch', function () { act(r.key, 'fetch', null, 'Fetch listo') }))
  if (r.upstream) tools.appendChild(iconBtn('pull', 'Pull (solo fast-forward)', function () { act(r.key, 'pull', null, 'Pull listo') }))
  if (!r.protected) tools.appendChild(iconBtn('push', 'Push de esta rama', function () { pushDialog(r) }))
  if (r.canRemoveWorktree && r.worktreeOf) tools.appendChild(iconBtn('trash', 'Borrar worktree', function () { removeWorktreeDialog(r) }))
  h.appendChild(tools)
  if (busy[r.key]) {
    var doing = el('span', 'doing')
    doing.appendChild(el('span', 'spin'))
    doing.appendChild(el('span', '', busy[r.key] + '…'))
    h.appendChild(doing)
  }
  h.onclick = function () {
    expanded[r.key] = !expanded[r.key]
    render()
    if (expanded[r.key]) load(true)
  }
  wrap.appendChild(h)
  if (open) {
    var body = el('div', 'body')
    var seg = el('div', 'seg')
    ;['Cambios', 'Historial'].forEach(function (name) {
      var t = el('button', (tab[r.key] || 'Cambios') === name ? 'on' : '', name)
      t.onclick = function () { tab[r.key] = name; render() }
      seg.appendChild(t)
    })
    body.appendChild(seg)
    if ((tab[r.key] || 'Cambios') === 'Cambios') changesView(r, body)
    else historyView(r, body)
    moreActions(r, body)
    wrap.appendChild(body)
  }
  // Las pestañas Cambios e Historial solo miran: siguen andando mientras dura la acción.
  if (busy[r.key]) wrap.querySelectorAll('button:not(.seg button), textarea').forEach(function (n) { n.disabled = true })
  return wrap
}
function spaceView(name, repos, term) {
  var closed = closedSpaces[name] && !term && !filter
  var h = el('div', 'space' + (closed ? ' closed' : ''))
  var chev = svg('chevron', 12)
  chev.setAttribute('class', 'chev' + (closed ? '' : ' down'))
  h.appendChild(chev)
  h.appendChild(svg('layers'))
  h.appendChild(el('b', 'grow', name))
  var dirty = repos.reduce(function (n, r) { return n + (r.staged.length + r.changes.length ? 1 : 0) }, 0)
  h.appendChild(el('span', 'count' + (dirty ? ' dirty' : ''), dirty ? dirty + ' con cambios' : String(repos.length)))
  h.onclick = function () {
    closedSpaces[name] = !closedSpaces[name]
    saveClosed()
    render()
  }
  list.appendChild(h)
  if (closed) return
  var kids = el('div', 'kids')
  repos.forEach(function (r) { kids.appendChild(repoView(r)) })
  list.appendChild(kids)
}
function isUnpublished(r) { return !r.protected && !r.detached && !r.upstream }
var FILTERS = {
  cambios: { many: 'con cambios', test: function (r) { return r.staged.length + r.changes.length > 0 } },
  subir: { many: 'para subir', test: function (r) { return r.ahead > 0 || isUnpublished(r) } },
  traer: { many: 'para traer', test: function (r) { return r.behind > 0 } }
}
function renderSummary() {
  var box = document.getElementById('summary')
  box.textContent = ''
  var any = false
  Object.keys(FILTERS).forEach(function (key) {
    var count = data.filter(FILTERS[key].test).length
    if (!count) {
      if (filter === key) filter = ''
      return
    }
    any = true
    var chip = el('button', 'chip' + (filter === key ? ' on' : ''), count + ' ' + FILTERS[key].many)
    chip.onclick = function () {
      filter = filter === key ? '' : key
      render()
    }
    box.appendChild(chip)
  })
  if (!any && data.length) box.appendChild(el('span', '', 'Todo al día'))
}
function rootOf(r) { return r.worktreeOf || r.key }
function isPending(r) { return Object.keys(FILTERS).some(function (key) { return FILTERS[key].test(r) }) }
// Se calcula una vez, al abrir: si se reordenara en vivo, los repos saltarían mientras trabajás.
function rememberOrder() {
  if (firstRank || !data.length) return
  firstRank = {}
  data.forEach(function (r) { if (isPending(r)) firstRank[rootOf(r)] = true })
}
function pendingFirst(repos) {
  var blocks = []
  var byRoot = {}
  repos.forEach(function (r) {
    var root = rootOf(r)
    if (!byRoot[root]) blocks.push(byRoot[root] = { root: root, repos: [] })
    byRoot[root].repos.push(r) // el worktree queda pegado a su repo
  })
  var top = blocks.filter(function (b) { return firstRank && firstRank[b.root] })
  var rest = blocks.filter(function (b) { return !(firstRank && firstRank[b.root]) })
  return top.concat(rest).reduce(function (all, b) { return all.concat(b.repos) }, [])
}
function render() {
  rememberOrder()
  renderSummary()
  var top = list.scrollTop
  var term = find.value.trim().toLowerCase()
  var spaces = []
  data.forEach(function (r) {
    if (term && (r.name + ' ' + (r.branch || '')).toLowerCase().indexOf(term) < 0) return
    if (filter && !FILTERS[filter].test(r)) return
    var last = spaces[spaces.length - 1]
    if (last && last.name === r.group) last.repos.push(r)
    else spaces.push({ name: r.group, repos: [r] })
  })
  list.textContent = ''
  spaces.forEach(function (s) { spaceView(s.name, pendingFirst(s.repos), term) })
  if (!spaces.length && snapshot) list.appendChild(el('div', '', '')).id = 'empty'
  var none = document.getElementById('empty')
  if (none) none.textContent = term || filter ? 'Nada coincide.' : 'Orca no tiene proyectos.'
  list.scrollTop = top
  renderBoard()
}
find.oninput = render
function load(force) {
  return api('/api/repos' + (force ? '?fresh=1' : '')).then(function (j) {
    offline = 0
    if (lostToast) { lostToast = false; document.getElementById('toast').style.display = 'none' }
    var next = JSON.stringify(j)
    var typing = document.activeElement && document.activeElement !== find && /TEXTAREA|INPUT/.test(document.activeElement.tagName)
    if (next === snapshot && !force) return
    data = j
    snapshot = next
    if (!typing || force) render()
  }).catch(function (e) {
    // El servicio se reinicia al actualizarse: un corte de segundos no merece un aviso.
    if (!e.offline) return toast(e.message)
    offline++
    if (offline >= OFFLINE_POLLS && !lostToast) {
      lostToast = true
      toast('Se perdió la conexión con el servidor de la app.')
    }
  })
}
// ---------- Pit Wall: quién te espera, quién trabaja y los bots ----------
// Adaptado de github.com/Juanpe/orca-pit-wall. Los datos salen de /api/pitwall (worktree.ps de Orca).
var POLL_MS = 4000
// En el panel el refresco lo dispara cada cambio de estado de un agente; la consulta periódica queda de respaldo.
var PANEL_POLL_MS = 20000
var EVENT_DEBOUNCE_MS = 400
// Igual que en main.mjs: si el worker avisa cuando una sesión pide permiso o pregunta.
var NOTIFY_KEY = 'notify'
var STALE_POLLS = 3
var WHAT_NOW_MAX = 6
var VIEWS = ['resumen', 'sesiones', 'avisos', 'jira', 'git']
// Tus tickets: el servidor consulta Jira como mucho cada 5 min; esto solo lee su caché. El worker anota en
// jiraConocidos cuándo apareció cada ticket, y jiraVisto es hasta cuándo miraste la pestaña.
var JIRA_POLL_MS = 60000
var JIRA_KNOWN_KEY = 'jiraConocidos'
var JIRA_SEEN_KEY = 'jiraVisto'
var JIRA_REQUEST_MS = 180000
// La bandeja que llena el worker (main.mjs) y hasta cuándo la leíste.
var NOTICES_KEY = 'avisos'
var NOTICES_READ_KEY = 'avisosLeidos'
var NOTICES_POLL_MS = 5000
var STATE = {
  blocked: { tag: 'PERMISO', color: 'var(--c-blocked)', legend: 'pide permiso' },
  waiting: { tag: 'PREGUNTA', color: 'var(--c-waiting)', legend: 'pregunta' },
  idle: { tag: 'QUIETA', color: 'var(--c-idle)', legend: 'quieta' },
  done: { tag: 'TERMINÓ', color: 'var(--c-done)', legend: 'terminó' },
  working: { tag: 'TRABAJANDO', color: 'var(--c-working)', legend: 'trabajando' }
}
// Dentro de un proyecto, lo más urgente primero.
var URGENCY = { blocked: 0, waiting: 1, idle: 2, done: 3, working: 4 }
// Estado de un bot de Orca según `worktree.ps`.
var BOT_STATE = { working: ['trabajando', 'var(--c-working)'], active: ['activo', 'var(--c-done)'], inactive: ['dormido', 'var(--muted)'], closed: ['sin abrir en Orca', 'var(--faint)'] }
var board = document.getElementById('board')
var boardInner = document.getElementById('boardInner')
var view = readView()
var wall = null
var wallError = ''
var wallOk = 0
var seen = readSeen()
var wallRows = {}
var notices = []
var noticesRead = 0
var jira = null
var jiraError = ''
var jiraKnown = {}
var jiraSeen = 0
var jiraSeenShown = 0

function readView() {
  var linked = location.hash.slice(1) // #git, #prs…: abre directo en esa pestaña
  if (VIEWS.indexOf(linked) >= 0 && (PANEL || linked !== 'avisos')) return linked
  try {
    var v = localStorage.getItem('view')
    return VIEWS.indexOf(v) >= 0 && v !== 'avisos' ? v : 'resumen'
  } catch (e) {
    return 'resumen' // sin almacenamiento arranca en el resumen
  }
}
function readSeen() {
  try {
    return JSON.parse(localStorage.getItem('seen')) || {}
  } catch (e) {
    return {} // sin almacenamiento, ninguna sesión figura como vista
  }
}
function store(key, value) {
  // En el panel lo propio va al storage del plugin: un frame aislado puede no tener localStorage.
  if (PANEL) return orca.storage.set(key, value).catch(function (e) { console.error('[command-deck] no se guardó ' + key, e) })
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
  } catch (e) {
    // Es una comodidad de esta pestaña: si no se guarda, no se pierde nada.
  }
}
// Lo guardado en el panel llega después del primer dibujo.
function restorePanelState() {
  if (!PANEL) return Promise.resolve()
  return Promise.all(['seen', 'view', 'closedSpaces', 'zoom', JIRA_SEEN_KEY].map(function (k) { return orca.storage.get(k).catch(function () { return null }) })).then(function (v) {
    if (v[0] && typeof v[0] === 'object') seen = v[0]
    if (VIEWS.indexOf(v[1]) >= 0) view = v[1]
    if (v[2] && typeof v[2] === 'object') closedSpaces = v[2]
    if (typeof v[3] === 'number') setZoom(v[3], false)
    if (typeof v[4] === 'number') jiraSeen = v[4]
    if (view === 'jira') markJiraSeen()
    renderBoard()
    render()
  })
}
// Cambia cuando el agente cambia de estado: una sesión vista que se vuelve a mover, vuelve a estar pendiente.
function seenKey(a) { return (a.terminalId || a.key) + '|' + a.state + '|' + a.since }
// Solo se aparta lo terminado o quieto: una pregunta o un permiso siguen esperando.
function canBeSeen(a) { return a.state === 'done' || a.state === 'idle' }
function isSeen(a) { return canBeSeen(a) && seen[seenKey(a)] === true }
function pruneSeen() {
  var live = {}
  wall.waiting.forEach(function (a) { live[seenKey(a)] = true })
  var changed = false
  Object.keys(seen).forEach(function (k) { if (!live[k]) { delete seen[k]; changed = true } })
  if (changed) store('seen', seen)
}
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] })
}
// "5 s", "3 min", "16 h", "2 d". El espacio duro mantiene "16 h" en una línea.
function short(at) {
  var s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return s + ' s'
  var m = Math.floor(s / 60)
  if (m < 60) return m + ' min'
  var h = Math.floor(m / 60)
  if (h < 24) return h + ' h'
  return Math.floor(h / 24) + ' d'
}
function ago(at) { return at ? short(at) : '' }
function where(a) { return a.project === a.workspace ? a.project : a.project + ' › ' + a.workspace }
function initial(t) { return esc((String(t).trim()[0] || '?').toUpperCase()) }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many) }
function rowRef(a) { wallRows[a.key] = a; return esc(a.key) }

function buildWall() {
  var fresh = wall.waiting.filter(function (a) { return !isSeen(a) })
  var looked = wall.waiting.filter(isSeen)
  var byProject = {}
  var offices = []
  // Las sesiones de un bot van en la oficina de los bots, no en un proyecto aparte.
  var botWorkspaces = {}
  wall.bots.forEach(function (b) { if (b.worktreeId) botWorkspaces[b.worktreeId] = true })
  wall.waiting.concat(wall.working).forEach(function (a) {
    if (botWorkspaces[a.worktreeId]) return
    var o = byProject[a.project]
    if (!o) offices.push(o = byProject[a.project] = { project: a.project, sessions: [], fresh: 0, working: 0, seen: 0 })
    o.sessions.push(a)
    if (a.state === 'working') o.working++
    else if (isSeen(a)) o.seen++
    else o.fresh++
  })
  offices.forEach(function (o) {
    o.sessions.sort(function (a, b) { return (isSeen(a) - isSeen(b)) || URGENCY[a.state] - URGENCY[b.state] || a.since - b.since })
  })
  // Primero los proyectos que te esperan, después los que trabajan.
  offices.sort(function (a, b) {
    return (b.fresh > 0) - (a.fresh > 0) || (b.working > 0) - (a.working > 0) || b.sessions.length - a.sessions.length || a.project.localeCompare(b.project)
  })
  return {
    fresh: fresh, looked: looked, offices: offices,
    kpis: {
      fresh: fresh.length, working: wall.working.length,
      idle: wall.waiting.filter(function (a) { return a.state === 'idle' }).length,
      sessions: wall.waiting.length + wall.working.length, projects: offices.length, bots: wall.bots.length
    }
  }
}

function kpi(label, value, color, attrs) {
  var tag = attrs ? 'button' : 'div'
  return '<' + tag + ' class="kpi' + (value ? '' : ' zero') + '" style="--c:' + color + '"' + (attrs || '') + '><div class="label">' + label + '</div><div class="value">' + value + '</div></' + tag + '>'
}
function node(a) {
  var st = STATE[a.state]
  return '<button class="node' + (isSeen(a) ? ' seen' : '') + (a.state === 'working' ? ' working' : '') + '" data-row="' + rowRef(a) + '" title="' + esc(st.tag + ' · ' + a.title + ' · ' + where(a)) + '">' +
    '<span class="pdot" style="--c:' + st.color + '"></span>' +
    '<span class="nbody"><span class="ntitle trunc">' + esc(a.title) + '</span>' + (a.workspace !== a.project ? '<span class="wtname trunc">' + esc(a.workspace) + '</span>' : '') + '</span>' +
    '<span class="ago">' + ago(a.since) + '</span></button>'
}
function office(o) {
  var color = o.fresh ? 'var(--c-waiting)' : o.working ? 'var(--c-working)' : 'var(--c-done)'
  var parts = [o.fresh ? o.fresh + ' esperando' : '', o.working ? o.working + ' trabajando' : '', o.seen ? o.seen + ' vistas' : ''].filter(Boolean)
  return '<div class="office' + (o.fresh ? ' hot' : '') + '" style="--c:' + color + '" data-office><div class="ohead"><span class="oicon">' + initial(o.project) + '</span>' +
    '<div class="trunc"><b class="trunc">' + esc(o.project) + '</b><small>' + parts.join(' · ') + '</small></div></div>' +
    '<div class="sessions">' + o.sessions.map(node).join('') + '</div></div>'
}
// Un bot en el organigrama: su punto dice si te espera, trabaja o duerme.
function botNode(b) {
  var st = BOT_STATE[b.status] || [b.status || 'sin estado', 'var(--muted)']
  var color = b.agentsWaiting ? 'var(--c-waiting)' : b.agentsWorking ? 'var(--c-working)' : st[1]
  var what = b.agentsWaiting ? b.agentsWaiting + ' esperando' : b.agentsWorking ? b.agentsWorking + ' trabajando' : st[0]
  var open = b.worktreeId ? ' data-ws="' + esc(b.worktreeId) + '" data-path="' + esc(b.path) + '" title="Abrir ' + esc(b.name) + ' en Orca"' : ' disabled title="Orca no lo tiene abierto"'
  return '<button class="node' + (b.worktreeId ? '' : ' seen') + (b.agentsWorking ? ' working' : '') + '"' + open + '>' +
    '<span class="pdot" style="--c:' + color + '"></span>' +
    '<span class="nbody"><span class="ntitle trunc">' + esc(b.name) + '</span><span class="wtname trunc">' + esc(what) + '</span></span>' +
    '<span class="ago">' + ago(b.lastActivityAt) + '</span></button>'
}
function botOffice() {
  if (!wall.bots.length) return ''
  var waiting = wall.bots.reduce(function (n, b) { return n + b.agentsWaiting }, 0)
  var working = wall.bots.reduce(function (n, b) { return n + b.agentsWorking }, 0)
  var color = waiting ? 'var(--c-waiting)' : 'var(--c-working)'
  var parts = [plural(wall.bots.length, 'bot', 'bots'), waiting ? waiting + ' esperando' : '', working ? working + ' trabajando' : ''].filter(Boolean)
  return '<div class="office bots' + (waiting ? ' hot' : '') + '" style="--c:' + color + '" data-office><div class="ohead"><span class="oicon">🤖</span>' +
    '<div class="trunc"><b class="trunc">Bots</b><small>' + parts.join(' · ') + '</small></div></div>' +
    '<div class="sessions">' + wall.bots.map(botNode).join('') + '</div></div>'
}
function item(a, dim) {
  var st = STATE[a.state]
  var detail = a.state === 'working' ? a.activity : a.state === 'idle' ? 'Quieta en el prompt, esperándote' : a.lastMessage ? '“' + a.lastMessage + '”' : null
  return '<button class="item' + (dim ? ' seen' : '') + '" style="--c:' + st.color + '" data-row="' + rowRef(a) + '">' +
    '<div class="top"><span class="tag">' + st.tag + '</span><span class="ititle trunc">' + esc(a.title) + '</span><span class="ago">' + ago(a.since) + '</span></div>' +
    '<div class="sub trunc">' + esc(where(a)) + '</div>' + (detail ? '<div class="msg trunc">' + esc(detail) + '</div>' : '') + '</button>'
}
function heading(title, n) { return '<div class="label-h"><span>' + title + '</span><span>' + n + '</span></div>' }
function sessionList(title, items, empty, dim) {
  return heading(title, items.length) + (items.length ? items.map(function (a) { return item(a, dim) }).join('') : '<div class="none">' + empty + '</div>')
}
function agentChips(w) {
  var out = []
  if (w.agentsWaiting) out.push('<span class="pchip c" style="--c:var(--c-waiting)"><span class="pdot"></span>' + w.agentsWaiting + ' esperando</span>')
  if (w.agentsWorking) out.push('<span class="pchip c" style="--c:var(--c-working)"><span class="pdot"></span>' + w.agentsWorking + ' trabajando</span>')
  return out
}
function overviewView(v) {
  var k = v.kpis
  var legend = ['blocked', 'waiting', 'idle', 'done', 'working'].map(function (s) {
    return '<span><span class="pdot" style="--c:' + STATE[s].color + '"></span>' + STATE[s].legend + '</span>'
  }).join('')
  var gitKpis = Object.keys(FILTERS).map(function (key) {
    var n = data.filter(FILTERS[key].test).length
    return kpi('Repos ' + FILTERS[key].many, n, key === 'cambios' ? 'var(--warn)' : key === 'subir' ? 'var(--info)' : 'var(--muted)', ' data-filter="' + key + '" title="Ver en Git"')
  }).join('')
  return '<div class="kpis">' + kpi('Te esperan', k.fresh, 'var(--c-waiting)') + kpi('Trabajando', k.working, 'var(--c-working)') + kpi('Quietas', k.idle, 'var(--c-idle)') +
    kpi('Sesiones', k.sessions, 'var(--c-done)') + kpi('Proyectos', k.projects, 'var(--c-done)') + kpi('Bots', k.bots, 'var(--c-working)') + gitKpis + '</div>' +
    '<div class="chart" id="chart"><svg class="wires" id="wires"></svg>' +
    '<div class="me" id="me"><span class="badge">VOS</span><div><b>Vos · al mando</b><small>' + plural(k.sessions, 'sesión abierta', 'sesiones abiertas') + '</small></div></div>' +
    (v.offices.length || wall.bots.length ? '<div class="offices">' + v.offices.map(office).join('') + botOffice() + '</div>' : '<div class="none">No hay sesiones abiertas.</div>') +
    '<div class="legend">' + legend + '</div></div>' +
    sessionList('Qué hacer ahora', v.fresh.slice(0, WHAT_NOW_MAX), 'Nada nuevo. Todo visto o trabajando.') +
    (v.fresh.length > WHAT_NOW_MAX ? '<button class="hint" data-view="sesiones">Ver las ' + v.fresh.length + ' →</button>' : '') +
    '<p class="hint">Clic en una sesión → vas a su terminal. Las terminadas que abrís pasan a «ya vistas».</p>'
}
// Los bots de Orca, despiertos o dormidos: un bot sin sesión abierta no aparece en el organigrama.
function bot(b) {
  var st = BOT_STATE[b.status] || [b.status || 'sin estado', 'var(--muted)']
  var open = b.worktreeId ? ' data-ws="' + esc(b.worktreeId) + '" data-path="' + esc(b.path) + '" title="Abrir el bot en Orca"' : ' disabled title="Orca no lo tiene abierto: abrilo desde Orca una vez"'
  return '<button class="item' + (b.worktreeId ? '' : ' seen') + '" style="--c:' + st[1] + '"' + open + '>' +
    '<div class="top"><span class="tag">BOT</span><span class="ititle trunc">' + esc(b.name) + '</span><span class="ago">' + ago(b.lastActivityAt) + '</span></div>' +
    '<div class="pchips"><span class="pchip c" style="--c:' + st[1] + '"><span class="pdot"></span>' + esc(st[0]) + '</span>' + agentChips(b).join('') + '</div></button>'
}
function botList() {
  return wall.bots.length ? heading('Bots', wall.bots.length) + wall.bots.map(bot).join('') : ''
}
function sessionsView(v) {
  return sessionList('Te esperan', v.fresh, 'Nada nuevo. Todo visto o trabajando.') +
    sessionList('Trabajando ahora', wall.working, 'No hay agentes activos.') + botList() +
    (v.looked.length ? '<details><summary>' + heading('Abiertas, ya vistas', v.looked.length) + '</summary>' + v.looked.map(function (a) { return item(a, true) }).join('') + '</details>' : '')
}
// ---------- Avisos: lo que el worker te avisó, también lo que no viste en el escritorio ----------
function unreadNotices() { return notices.filter(function (n) { return n.at > noticesRead }) }
function noticeItem(n) {
  var st = n.jira ? { tag: 'JIRA', color: 'var(--info)' } : STATE[n.state] || STATE.done
  var unread = n.at > noticesRead
  var canOpen = n.terminalId || n.path || n.jira
  return '<button class="item notice' + (unread ? ' unread' : ' seen') + '" style="--c:' + st.color + '" data-notice="' + esc(n.id) + '"' + (canOpen ? '' : ' disabled') + '>' +
    '<div class="top"><span class="tag">' + (n.bot ? 'BOT' : st.tag) + '</span><span class="ititle trunc">' + esc(n.title) + '</span><span class="ago">' + ago(n.at) + '</span></div>' +
    (n.where ? '<div class="sub trunc">' + esc(n.where) + '</div>' : '') + (n.body ? '<div class="msg">“' + esc(n.body) + '”</div>' : '') + '</button>'
}
function noticesView() {
  if (!notices.length) return heading('Avisos', 0) + '<div class="none">Todavía no hay avisos. Llegan cuando una sesión pide permiso o pregunta, cuando un bot termina y cuando te asignan un ticket.</div>'
  return heading('Avisos', notices.length) + notices.map(noticeItem).join('') +
    '<p class="hint">Clic en un aviso → vas a esa sesión. Quedan los últimos 30.</p>'
}
function openNotice(id) {
  var n = notices.filter(function (x) { return x.id === id })[0]
  if (n && n.jira) setView('jira')
  else if (n) openInOrca(null, n.terminalId, n.path)
}
// ---------- Jira: tus tickets, cuáles trabajás, el estado del harness y cómo arrancar uno ----------
function isNewTicket(t, since) { return (jiraKnown[t.key] || 0) > since }
function jiraUnseen() { return jira && jira.enabled ? jira.issues.filter(function (t) { return isNewTicket(t, jiraSeen) }).length : 0 }
function markJiraSeen() {
  jiraSeenShown = jiraSeen
  jiraSeen = Date.now()
  store(JIRA_SEEN_KEY, jiraSeen)
}
var JIRA_CATEGORY = { new: 'var(--muted)', indeterminate: 'var(--info)', done: 'var(--c-done)' }
function chip(text, color, title) {
  return '<span class="pchip c" style="--c:' + color + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>'
}
function harnessChip(h) {
  if (!h) return ''
  if (h.deployed) return chip('deployado', 'var(--c-done)', 'Según el harness')
  if (h.state === 'listo-para-deploy') return chip('listo para deploy', 'var(--c-waiting)', 'Según el harness')
  return h.state ? chip(h.state, 'var(--muted)', 'Estado en el harness') : ''
}
function ticketItem(t, fresh) {
  var s = t.sessions[0]
  var stuck = /bloque/i.test(t.status || '')
  var color = fresh ? 'var(--c-waiting)' : s ? 'var(--c-working)' : stuck ? 'var(--c-blocked)' : 'var(--c-idle)'
  var chips = [chip(t.status || 'sin estado', stuck ? 'var(--c-blocked)' : JIRA_CATEGORY[t.category] || 'var(--muted)', 'Estado en Jira')]
  if (fresh) chips.push(chip('nuevo', 'var(--c-waiting)'))
  if (s) chips.push('<button class="pchip c" style="--c:var(--c-working)" data-tsession="' + esc(t.key) + '" title="Ir a su sesión en Orca"><span class="pdot"></span>trabajando · ' + esc(s.name) + '</button>')
  chips.push(harnessChip(t.harness))
  if (t.pushed.length) chips.push(chip('rama pusheada', 'var(--add)', 'En origin (último fetch): ' + t.pushed.join(', ')))
  if (t.blocker) chips.push(chip('⛔ decisión de negocio', 'var(--c-blocked)', t.blocker))
  if (!s && PANEL) chips.push('<button class="pchip" data-tstart="' + esc(t.key) + '" title="Workspace nuevo en Orca, con la rama del ticket">▶ Arrancar</button>')
  chips.push('<button class="pchip" data-tjira="' + esc(t.key) + '" title="Abrir en Jira">Jira ↗</button>')
  return '<div class="item ticket' + (fresh ? ' unread' : '') + '" style="--c:' + color + '" data-ticket="' + esc(t.key) + '" title="' + esc(t.title) + '">' +
    '<div class="top"><span class="tag">' + esc(t.key) + '</span><span class="ititle trunc">' + (t.blocker ? '⛔ ' : '') + esc(t.title) + '</span><span class="ago">' + ago(t.updated) + '</span></div>' +
    (t.brief ? '<div class="msg">' + esc(t.brief) + '</div>' : '') + '<div class="pchips">' + chips.join('') + '</div></div>'
}
function ticketGroup(title, rows, fresh) {
  return rows.length ? heading(title, rows.length) + rows.map(function (t) { return ticketItem(t, fresh) }).join('') : ''
}
function jiraView() {
  if (!jira) return jiraError ? '<div class="none">' + esc(jiraError) + '</div>' : '<p class="hint">Cargando…</p>'
  if (!jira.enabled) return heading('Jira', 0) + '<div class="none">Sin configurar: agregá «jira» a policy.json (mirá policy.example.json).</div>'
  var out = ''
  if (jira.error) out += '<div class="alert" style="--c:var(--c-waiting)">No pude consultar Jira: ' + esc(jira.error) + (jira.fetchedAt ? ' Muestro lo de hace ' + short(jira.fetchedAt) + '.' : '') + '</div>'
  var fresh = jira.issues.filter(function (t) { return isNewTicket(t, jiraSeenShown) })
  var rest = jira.issues.filter(function (t) { return !isNewTicket(t, jiraSeenShown) })
  var working = rest.filter(function (t) { return t.sessions.length })
  var others = rest.filter(function (t) { return !t.sessions.length })
  if (!jira.issues.length) out += heading('Mis tickets · ' + jira.project, 0) + '<div class="none">No tenés tickets abiertos en ' + esc(jira.project) + '.</div>'
  out += ticketGroup('Nuevos', fresh, true) + ticketGroup('Trabajando', working, false) + ticketGroup('Asignados · ' + jira.project, others, false)
  return out + '<p class="hint">Clic en un ticket → su sesión en Orca, o Jira si no tiene. Jira se consulta cada 5 min' + (jira.fetchedAt ? ' · última hace ' + short(jira.fetchedAt) : '') + '.</p>'
}
function ticketOf(key) { return jira && jira.issues ? jira.issues.filter(function (t) { return t.key === key })[0] : null }
function openExternal(url) {
  if (!/^https:\/\//.test(url || '')) return
  if (PANEL) { if (orca.shell) orca.shell.openExternal(url) } else window.open(url, '_blank', 'noopener')
}
function openTicket(key, toJira) {
  var t = ticketOf(key)
  if (!t) return
  var s = t.sessions[0]
  if (s && !toJira) openInOrca(s.worktreeId, s.terminalId, s.path)
  else openExternal(t.url)
}
function loadJira() {
  return api('/api/jira').then(function (j) { jira = j; jiraError = '' }, function (e) { jiraError = e.message }).then(function () {
    if (!PANEL) return
    return orca.storage.get(JIRA_KNOWN_KEY).then(function (v) { jiraKnown = v && typeof v === 'object' ? v : {} })
  }).catch(function (e) { console.error('[command-deck] no pude leer Jira', e) }).then(renderBoard)
}
// Arrancar: elegís el repo (agrupados como en Orca), ves qué se va a crear y confirmás. Lo crea el worker.
function startPicker(key) {
  var t = ticketOf(key)
  if (!t) return
  orca.plugin.request('projects').then(function (paths) {
    var roots = data.filter(function (r) { return !r.worktreeOf && paths.indexOf(r.key) >= 0 })
    var box = document.getElementById('box')
    box.textContent = ''
    var input = el('input')
    input.placeholder = 'Repo donde arrancar ' + key
    box.appendChild(input)
    var options = el('div', 'list')
    box.appendChild(options)
    function paint() {
      var term = input.value.trim().toLowerCase()
      options.textContent = ''
      var last = null
      roots.forEach(function (r) {
        if (term && (r.name + ' ' + r.group).toLowerCase().indexOf(term) < 0) return
        if (r.group !== last) { options.appendChild(el('div', 'opt-h', r.group || 'Sin grupo')); last = r.group }
        var o = el('div', 'opt')
        o.appendChild(el('span', '', r.name))
        o.appendChild(el('span', 'meta', 'base ' + r.base))
        o.onclick = function () { closeModal(); confirmStart(t, r) }
        options.appendChild(o)
      })
      if (!options.childNodes.length) options.appendChild(el('div', 'opt-h', 'Ningún repo coincide.'))
    }
    input.oninput = paint
    paint()
    document.getElementById('modal').style.display = 'flex'
    input.focus()
  }).catch(function (e) { toast(e.message || 'No pude leer los proyectos de Orca.') })
}
function confirmStart(t, r) {
  api('/api/jira-start?key=' + encodeURIComponent(t.key) + '&repo=' + encodeURIComponent(r.key)).then(function (plan) {
    var lines = [
      { text: 'Repo: ' + plan.repo + (plan.group ? ' (' + plan.group + ')' : '') },
      { text: 'Rama nueva: ' + plan.branch },
      { text: 'Sale de: ' + plan.baseRef + ', la base del repo, como quedó en el último fetch.' }
    ]
    if (plan.existing.length) lines.push({ warn: true, text: 'Ya hay ramas de este ticket en el repo: ' + plan.existing.join(', ') })
    lines.push({ text: 'Abre un workspace nuevo en Orca y arranca ' + plan.agent + ' con: «' + plan.prompt + '»' })
    dialog('Arrancar ' + t.key, lines, [], [
      { label: 'Cancelar', safe: true },
      { label: 'Crear workspace', kind: 'primary', run: function () { runStart(t.key, r.key) } }
    ])
  }).catch(function (e) { toast(e.message) })
}
function runStart(key, repo) {
  toast('Creando el workspace de ' + key + '…', true)
  orca.plugin.request('jiraStart', { key: key, repo: repo }, { timeoutMs: JIRA_REQUEST_MS }).then(function (r) {
    toast(r.branch === r.expected ? 'Workspace creado en ' + r.branch : 'Workspace creado, pero Orca le puso a la rama ' + r.branch + ' (esperaba ' + r.expected + ')', r.branch === r.expected)
    loadJira()
  }).catch(function (e) { toast(e.message || 'Orca no pudo crear el workspace.') })
}
function markNoticesRead() {
  var last = notices.length ? notices[0].at : 0
  if (last <= noticesRead) return
  noticesRead = last
  store(NOTICES_READ_KEY, noticesRead)
}
// La bandeja la escribe el worker: el panel la relee cada tanto y avisa con un cartel lo nuevo.
function loadNotices() {
  return Promise.all([orca.storage.get(NOTICES_KEY), orca.storage.get(NOTICES_READ_KEY)]).then(function (v) {
    var list = Array.isArray(v[0]) ? v[0] : []
    var read = Math.max(noticesRead, typeof v[1] === 'number' ? v[1] : 0)
    var before = notices.length ? notices[0].id : null
    var top = list.length ? list[0] : null
    var changed = (top ? top.id : null) !== before || read !== noticesRead
    var fresh = before !== null && top && top.id !== before && top.at > read
    notices = list
    noticesRead = read
    if (view === 'avisos' && !document.hidden) markNoticesRead()
    else if (fresh) toast('🔔 ' + top.title, true)
    if (changed) renderBoard()
  }).catch(function (e) { console.error('[command-deck] no pude leer los avisos', e) })
}
function renderTabs(v) {
  var dirty = data.filter(FILTERS.cambios.test).length
  var t = function (id, label, n) {
    return '<button role="tab" data-view="' + id + '" aria-selected="' + (view === id) + '">' + label + (n !== undefined ? '<span class="n">' + n + '</span>' : '') + '</button>'
  }
  document.getElementById('tabs').innerHTML = t('resumen', 'Resumen') + t('sesiones', 'Sesiones', v ? v.kpis.fresh : undefined) +
    (PANEL ? t('avisos', 'Avisos', unreadNotices().length || undefined) : '') +
    (jira && jira.enabled ? t('jira', 'Jira', jiraUnseen() || undefined) : '') + t('git', 'Git', dirty || undefined)
}
function renderAlerts() {
  var out = []
  if (wallError) out.push('<div class="alert" style="--c:var(--c-blocked)">' + esc(wallError) + '</div>')
  else if (wall && wall.error) out.push('<div class="alert" style="--c:var(--c-waiting)">' + esc(wall.error) + ' Sin sesiones ni bots; la pestaña Git sigue andando.</div>')
  document.getElementById('alerts').innerHTML = view === 'git' ? '' : out.join('')
}
function renderBoard() {
  var v = wall ? buildWall() : null
  renderTabs(v)
  renderAlerts()
  var onGit = view === 'git'
  document.getElementById('git').hidden = !onGit
  board.hidden = onGit
  if (onGit) return
  wallRows = {}
  if (view === 'avisos') {
    boardInner.innerHTML = noticesView()
    return
  }
  if (view === 'jira') {
    var top = board.scrollTop
    boardInner.innerHTML = jiraView()
    board.scrollTop = top
    return
  }
  if (!wall) {
    boardInner.innerHTML = '<p class="hint">Cargando…</p>'
    return
  }
  var y = board.scrollTop
  var openDetails = !!boardInner.querySelector('details[open]')
  boardInner.innerHTML = view === 'resumen' ? overviewView(v) : sessionsView(v)
  if (openDetails && boardInner.querySelector('details')) boardInner.querySelector('details').setAttribute('open', '')
  board.scrollTop = y
  drawWires()
}
// Cables de vos a cada proyecto, como en un organigrama.
var TRUNK_X = 14
var BRANCH_Y = 17
var BEND = 6
function drawWires() {
  var chart = document.getElementById('chart')
  var wires = document.getElementById('wires')
  var me = document.getElementById('me')
  if (!chart || !wires || !me || board.hidden) return
  var box = chart.getBoundingClientRect()
  var m = me.getBoundingClientRect()
  // El tronco baja desde «Vos» y una rama sale hacia cada proyecto, a la altura de su título.
  var x0 = m.left + TRUNK_X - box.left
  var y0 = m.bottom - box.top
  var paths = Array.prototype.map.call(chart.querySelectorAll('[data-office]'), function (o) {
    var r = o.getBoundingClientRect()
    var x1 = r.left - box.left
    var y1 = r.top + BRANCH_Y - box.top
    return '<path d="M' + x0 + ',' + y0 + ' V' + (y1 - BEND) + ' Q' + x0 + ',' + y1 + ' ' + (x0 + BEND) + ',' + y1 + ' H' + x1 + '" />'
  })
  wires.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height)
  wires.innerHTML = paths.join('')
}
new ResizeObserver(drawWires).observe(board)

function setView(next) {
  if (next === 'jira' && view !== 'jira') markJiraSeen()
  view = next
  store('view', next)
  if (next === 'avisos') markNoticesRead()
  board.scrollTop = 0
  renderBoard()
  if (next === 'git') render()
}
// En el panel abre el worker con la API de plugins (también carpetas, como los bots); en la pestaña, el servidor.
function openInOrca(worktreeId, terminalId, path) {
  var done = PANEL
    ? orca.plugin.request('open', { terminalId: terminalId || null, path: path || null })
    : send('/api/open', { worktreeId: worktreeId, terminalId: terminalId || null })
  done.catch(function (e) { toast(e.message || 'Orca no pudo abrirlo.') })
}
function openSession(a) {
  if (canBeSeen(a) && !seen[seenKey(a)]) {
    seen[seenKey(a)] = true
    store('seen', seen)
    renderBoard()
  }
  openInOrca(a.worktreeId, a.terminalId, a.path)
}
function onBoardClick(e) {
  var t = e.target.closest('[data-filter],[data-view],[data-row],[data-ws],[data-notice],[data-tjira],[data-tstart],[data-tsession],[data-ticket]')
  if (!t) return
  if (t.dataset.tjira) return openTicket(t.dataset.tjira, true)
  if (t.dataset.tstart) return startPicker(t.dataset.tstart)
  if (t.dataset.tsession || t.dataset.ticket) return openTicket(t.dataset.tsession || t.dataset.ticket, false)
  if (t.dataset.filter) { filter = t.dataset.filter; find.value = ''; setView('git') }
  else if (t.dataset.view) setView(t.dataset.view)
  else if (t.dataset.row) { if (wallRows[t.dataset.row]) openSession(wallRows[t.dataset.row]) }
  else if (t.dataset.ws) openInOrca(t.dataset.ws, null, t.dataset.path)
  else if (t.dataset.notice) openNotice(t.dataset.notice)
}
board.addEventListener('click', onBoardClick)
document.getElementById('tabs').addEventListener('click', onBoardClick)

// "en vivo · 13:58:02" mientras los datos están frescos; si no, hace cuánto llegaron.
function paintLive() {
  var stale = !wallOk || Date.now() - wallOk > STALE_POLLS * POLL_MS
  var ok = !wallError && !stale
  var live = document.getElementById('live')
  live.classList.toggle('off', !ok)
  live.lastChild.textContent = ok ? 'en vivo · ' + new Date().toLocaleTimeString('es-AR', { hour12: false }) : wallOk ? 'sin datos · último hace ' + short(wallOk) : 'sin conexión'
  live.title = live.lastChild.textContent // en un panel angosto el texto se corta con puntos
}
var wallInFlight = false
function loadWall() {
  if (wallInFlight) return
  wallInFlight = true
  api('/api/pitwall').then(function (j) {
    wall = j
    wallOk = Date.now()
    wallError = ''
    pruneSeen()
  }).catch(function (e) {
    wallError = e.offline ? 'Se perdió la conexión con el servidor de la app.' : e.message
  }).finally(function () {
    wallInFlight = false
    renderBoard()
    paintLive()
  })
}
window.addEventListener('storage', function (e) { if (e.key === 'seen') { seen = readSeen(); renderBoard() } })
// Zoom propio: dentro del panel, el zoom de Orca no siempre llega. Se guarda como lo demás.
var ZOOM_MIN = 0.8
var ZOOM_MAX = 1.8
var ZOOM_STEP = 0.1
var zoom = 1
function setZoom(next, save) {
  zoom = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) * 10) / 10
  document.documentElement.style.zoom = String(zoom)
  document.getElementById('zoomOut').disabled = zoom <= ZOOM_MIN
  document.getElementById('zoomIn').disabled = zoom >= ZOOM_MAX
  if (save !== false) store('zoom', zoom)
  drawWires()
}
document.getElementById('zoomIn').onclick = function () { setZoom(zoom + ZOOM_STEP) }
document.getElementById('zoomOut').onclick = function () { setZoom(zoom - ZOOM_STEP) }
document.addEventListener('keydown', function (e) {
  if (!e.ctrlKey && !e.metaKey) return
  if (e.key === '+' || e.key === '=') setZoom(zoom + ZOOM_STEP)
  else if (e.key === '-') setZoom(zoom - ZOOM_STEP)
  else if (e.key === '0') setZoom(1)
  else return
  e.preventDefault()
})
if (!PANEL) {
  try {
    setZoom(Number(localStorage.getItem('zoom')) || 1, false)
  } catch (e) {
    setZoom(1, false) // sin almacenamiento arranca en tamaño normal
  }
}
renderBoard()
restorePanelState().then(loadWall).then(loadJira)
setInterval(function () { if (!document.hidden) loadJira() }, JIRA_POLL_MS)
setInterval(function () { if (!document.hidden) loadWall() }, PANEL ? PANEL_POLL_MS : POLL_MS)
if (PANEL) {
  var eventTimer
  orca.on('agent.status.changed', function () {
    clearTimeout(eventTimer)
    eventTimer = setTimeout(loadWall, EVENT_DEBOUNCE_MS)
  })
  setupNotifyToggle()
  loadNotices()
  setInterval(function () { if (!document.hidden) loadNotices() }, NOTICES_POLL_MS)
}
// El botón de la campana: prende o apaga los avisos de escritorio, que manda el worker aunque el panel esté cerrado.
function setupNotifyToggle() {
  var bell = document.getElementById('notify')
  var on = true
  function paint() {
    bell.hidden = false
    bell.className = 'bell' + (on ? ' on' : '')
    bell.textContent = on ? '🔔 avisos' : '🔕 avisos'
    bell.title = on ? 'Aviso en el escritorio cuando una sesión pide permiso o pregunta, o un bot termina. Clic para apagar. La pestaña Avisos los guarda igual.' : 'Avisos apagados. Clic para prender.'
  }
  orca.storage.get(NOTIFY_KEY).then(function (v) { on = v !== false; paint() }, function () { paint() })
  bell.onclick = function () {
    on = !on
    paint()
    store(NOTIFY_KEY, on)
  }
}
setInterval(paintLive, 1000)
load(true)
setInterval(function () { if (!document.hidden) load(false) }, POLL_MS)
// El servidor decide si ya toca: esto solo avisa que hay alguien mirando.
function autoFetch() {
  if (document.hidden) return
  send('/api/fetch-all', {}).then(function (j) {
    if (!j.skipped) load(true)
  }).catch(function () {}) // sin red no hay nada que avisar: se reintenta en la próxima vuelta
}
autoFetch()
setInterval(autoFetch, 60000)
// Mantiene vivo el servidor mientras la pestaña exista, aunque esté en segundo plano.
setInterval(function () { api('/api/ping').catch(function () {}) }, 60000)
})()
