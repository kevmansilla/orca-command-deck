# Command Deck

Plugin para [Orca](https://github.com/stablyai/orca): tus agentes, bots y repos en un solo panel. Muestra quién te espera y quién trabaja, y trae un Source Control al estilo VS Code con todos tus proyectos, agrupados igual que en Orca: cambios, commits, ramas e historial, sin entrar repo por repo.

Arriba tiene además un tablero al estilo de [Pit Wall](https://github.com/Juanpe/orca-pit-wall): quién te espera, quién trabaja y tus bots.

| Pestaña | Qué muestra |
| --- | --- |
| **Resumen** | Contadores de sesiones, bots y repos; el organigrama vos → proyectos → sesiones coloreado por estado; **Qué hacer ahora** y tus bots |
| **Sesiones** | Las que te esperan, las que trabajan, los bots y, plegadas, las terminadas que ya abriste |
| **Git** | El Source Control |

Cuando una sesión pide permiso o hace una pregunta, o cuando un bot termina, avisa con una notificación de escritorio, aunque el panel esté cerrado. Los chats y bots sin terminal se revisan cada 15 s. La pestaña «Avisos» guarda los últimos 30, con contador de no leídos y clic para ir a la sesión. La campana «avisos» del panel apaga las notificaciones de escritorio; la pestaña los guarda igual. El panel se refresca solo con cada cambio de estado de un agente.

Clic en una sesión lleva a su terminal (o a su workspace, si es un chat sin terminal); en un bot, abre ese bot en Orca. Los contadores de repos llevan a Git con ese filtro. Los datos salen de `worktree.ps` y `agent.list` por el socket de Orca.

Se abre desde su ícono en la barra lateral de Orca. Es un solo panel para toda la ventana: no se repite por proyecto. El panel no puede conectarse a nada: le pide todo al worker del plugin, que se lo pasa a un único servidor local. El servidor escucha solo en `127.0.0.1` y usa un token que cambia en cada arranque.

## Instalación

Necesitás Orca 1.4.259 o más nuevo.

```bash
orca plugin install kevmansilla/orca-command-deck
```

Orca muestra lo que pide el plugin y la línea para volver a correrlo con `--approve <fingerprint>`. Pide correr su propio proceso (ejecuta git con tus permisos), mostrar notificaciones, guardar en su carpeta las sesiones que ya viste, leer tus workspaces y sus agentes (para el tablero y los avisos) y abrir workspaces o enfocar terminales (cuando hacés clic).

Después tocá su ícono (unas capas) en la barra lateral, o abrilo con:

```bash
orca plugin open kevmansilla.command-deck --panel command-deck
```

Se actualiza con `orca plugin update kevmansilla.command-deck`: Orca instala la última etiqueta `vX.Y.Z`. Se desinstala con `orca plugin uninstall kevmansilla.command-deck`.

### Desde una carpeta, para desarrollarlo

1. Cloná el repo y, en Orca, abrí Settings → Plugins y tocá **Turn on plugins** si están apagados.
2. En **Development folders…**, agregá esa carpeta, o corré `orca plugin dev load <carpeta>`. Si después movés el repo, sacá la carpeta vieja y agregá la nueva: Orca no lo sigue.
3. Aprobalo con `orca plugin dev reload <carpeta> --approve <fingerprint>` (el fingerprint lo imprime el mismo comando sin `--approve`).

## Publicar una versión

1. Subí `version` en `orca-plugin.json`, commiteá y pusheá a `main`.
2. Etiquetá y pusheá la etiqueta: `git tag v0.3.0 && git push origin v0.3.0`.
3. Opcional: `orca plugin release-entry .` imprime la entrada para listarlo en un catálogo de Orca.

## Servidor siempre encendido (opcional, Linux)

Sin esto, el servidor arranca cuando abrís el panel y se apaga tras 10 minutos sin uso. Con el servicio de usuario de `systemd` queda siempre encendido (unos 80 MB) y el panel responde al instante. Necesita Node 22.5 o más nuevo.

```bash
bash scripts/install-service.sh          # instala y arranca
bash scripts/install-service.sh remove   # lo desinstala
```

Usa un puerto y un token fijos, guardados con permisos `0600` en `~/.config/orca-multi-repo-git/service.env`. Al actualizar el plugin se reinicia solo.

## Protección

Sin configurar nada, no se puede commitear ni pushear en `main`, `master` ni en la rama por defecto del remoto. El cambio sale de una rama nueva, creada desde esa base.

Para ajustarlo, copiá `policy.example.json` a `~/.config/orca-multi-repo-git/policy.json`. Gana la primera regla que coincida:

| Regla | Efecto |
| --- | --- |
| `"free": true` | Sin ramas protegidas |
| `"protected"` y `"base"` | Protege esas ramas y crea las nuevas desde `base` |
| `"bases"` | Lee la base de cada repo de un JSON: `{ "default": "main", "repos": { "web": "master" } }` |
| `"bases"` y `"protected"` | Lo mismo, y protege también esas ramas. Para cuando lo desplegado no es la base, como `dev` → `main` |
| `"bases"` y `"freeFrom"` | Deja sin ramas protegidas a los repos de una lista externa: `{ "file": "~/config.json", "key": "env.REPOS" }`. La clave puede tener un array o nombres separados por comas. Si no se puede leer, siguen protegidos |

Cada regla se aplica con `path` (ese repo) o `under` (todo lo que esté adentro). `exclude` oculta las carpetas con ese nombre. `standingBranches` lista ramas que viven siempre (la de un agente que se resetea a la base): no se marcan "mergeadas" ni ofrecen los comandos `when: "feature"`.

La protección es de esta app: no frena un `git push` hecho desde la terminal.

## Comandos propios

Podés agregar botones que abren una terminal de Orca en el repo y corren tus comandos. Se configuran en `policy.json`; sin eso no aparece ninguno.

| Campo | Efecto |
| --- | --- |
| `label`, `run` | Texto del botón, que acepta `{base}`, y comando a correr |
| `hint` | Explicación que aparece al pasar el mouse |
| `under` | Solo para los repos dentro de esa carpeta |
| `when: "merging"` | Solo con un merge o cherry-pick frenado |
| `when: "feature"` | Solo parado en una rama no protegida |
| `warn: true` | Pide confirmación en repos con regla `bases` |

Con `"terminal": "floating"`, cada comando abre una pestaña nueva en la terminal flotante de Orca, sin tocar las que ya están abiertas.

Con `"pullRequests": false` se oculta el botón Abrir PR.

`worktrees` define `create` y `remove`, con `{repo}`, `{path}` y `{branch}` como variables. Los comandos corren con tus permisos, y la protección de ramas de la app no los alcanza.

## Tickets

`"tickets": [{ "under": "~/trabajo", "dir": "~/trabajo/tickets" }]` une cada rama con la carpeta de su ticket. De `ABC-123-algo` busca `ABC-123-*` en `dir` y en `dir/_archivo`, y muestra el estado de `US.md` (`- **Estado:** en curso`). También avisa si `test.md` no tiene nada propio o si `deploy.md` tiene pasos sin ejecutar. Lo que coincide con `_template/` no cuenta.

## Secretos

Antes de agregar archivos como `.env`, `*.pem` o `credentials`, la app pide confirmación. Agregar todo ofrece dejarlos afuera. Antes de cada push muestra el remoto y los commits, y avisa si tocan archivos así, si el push despliega o si la rama sigue a otra.

Se detectan por nombre, no por contenido: un secreto en un archivo común no se ve, salvo que configures `scan`.

`"scan": { "under": "~/trabajo", "run": "~/bin/mi-scanner" }` revisa antes del push las líneas agregadas. El programa recibe rutas de archivos y sale con 0 si no hay nada, o con 1 si encontró algo. Para ver qué encontró, tiene que imprimir `ruta:línea  [tipo]`; la app muestra el archivo y el tipo, nunca el valor. Si el programa falla, la app lo avisa y no deja de pedir confirmación.

## Pruebas

```bash
node test.mjs
```

Corren contra repos temporales y no tocan los tuyos. El aviso `ExperimentalWarning` de SQLite es normal.

## Licencia

MIT
