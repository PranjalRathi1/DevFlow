# DevFlow launcher (`npm run dev`)

One command starts DevFlow and whatever it needs, and stops only what it
started. The source is in `packages/launcher/`; the design decision is in
`docs/DECISIONS.md` ADR-031.

```bash
npm run dev
```

The existing commands still work on their own and are unchanged:
`npm run db:up`, `npm run dev:api`, `npm run dev:web`.

## What starts automatically

The launcher works through these steps in order. Each step is skipped if
the thing is already available.

1. **Docker.** If `docker info` fails, the launcher starts Docker Desktop
   and waits until Docker answers.
   - It looks for Docker Desktop in `%ProgramFiles%`, `%ProgramW6432%`
     and `%LOCALAPPDATA%\Programs`, or at `DEVFLOW_DOCKER_DESKTOP_PATH`.
   - On macOS it runs `open -a Docker`.
2. **MongoDB.** The launcher starts only the `mongo` service of DevFlow's
   own Compose project, then waits until its health check reports healthy.
   - It runs `docker compose … up --detach --no-recreate mongo`, naming
     the project (`devflow`), directory and file explicitly.
   - `--no-recreate` reuses an existing container and its data volume.
3. **Ollama.** If `OLLAMA_BASE_URL` doesn't answer, the launcher runs
   `ollama serve` itself, with `OLLAMA_HOST` set from that URL.
   - It finds `ollama` on `PATH`, at `%LOCALAPPDATA%\Programs\Ollama`, or
     at `DEVFLOW_OLLAMA_PATH`.
   - It then checks that `OLLAMA_MODEL` is installed. It never downloads a
     model; if the model is missing, startup stops and says:
     `ollama pull <model>`.
   - It won't start Ollama for a `OLLAMA_BASE_URL` on another machine.
4. **The API** (`npm run dev:api`), then **the web app**
   (`npm run dev:web`). Their output appears with an `[api]` or `[web]`
   prefix. Before starting each one, the launcher checks its port:
   - **DevFlow already running there** (the API's `/api/health` returns
     DevFlow's `{status, uptimeSeconds, timestamp}` JSON, or the page on
     `DEVFLOW_WEB_PORT` has the `<title>DevFlow AI</title>` from
     `apps/web/index.html`): it is used as-is, logged as "already running",
     and **never stopped** by this launcher.
   - **Something else there** (any other HTTP answer, or a program that
     accepts connections but doesn't speak HTTP): startup stops with "Port …
     is in use by another program that is not DevFlow's …". The launcher
     neither adopts nor stops that program, and doesn't start a second
     server that would collide with it. Anything DevFlow already started is
     cleaned up.
   - **Nothing there:** the launcher starts it.

The launcher starts both app processes itself, using the existing workspace
scripts; it does not hand off to a separate orchestration script.

## How ownership works

- The launcher remembers, **in memory for this run only**, which resources
  it started. A resource counts as "owned" only after the launcher itself
  started it successfully.
- Anything that was already running is **external** and is never stopped.
- No ownership file is written. A stale file can't make DevFlow stop
  something it didn't start in this run.
- For Ollama, ownership means holding the handle to the exact
  `ollama serve` process the launcher spawned. Stopping acts on that process ID and
  its own subprocesses only, never on processes found by name.
- If the launcher's own `ollama serve` exits during startup while another
  Ollama (e.g. the desktop app) answers on the port, that other server is
  treated as external.

## What happens when DevFlow closes

Ctrl+C, `SIGTERM`, a startup failure part-way through, or the API or web
process crashing all run the same cleanup, **once**. The launcher exits
only after it finishes. If a signal arrives in the middle of a startup
step (e.g. while MongoDB is being started), cleanup first waits for that
step to finish, so anything it started is stopped too. The order is:

1. **API and web processes** started by the launcher: asked to stop, then
   force-stopped after `DEVFLOW_STOP_GRACE_MS` (default 10 s) if still
   running.
2. **MongoDB:** `docker compose … stop mongo`, only if the launcher started
   it (and `DEVFLOW_STOP_OWNED_MONGO` isn't `false`). The container and its
   `devflow-mongo-data` volume are kept, so your data survives. The
   launcher never runs `down`, `down -v`, `rm`, or any `prune` command.
3. **Ollama:** the `ollama serve` process the launcher started is stopped
   (unless `DEVFLOW_STOP_OWNED_OLLAMA=false`). An Ollama that was already
   running is left alone.
4. **Docker Desktop:** left running (see below).

A second Ctrl+C during cleanup doesn't start a second cleanup; the
launcher prints "Shutdown already in progress".

**Exit codes:**

- **0** for a stop you asked for, including a Ctrl+C during startup.
- **1** after a startup failure, a crashed API or web process, an
  unexpected launcher error, or a cleanup step that failed.

**What is not guaranteed:**

- **Closing the terminal window.** On Windows this sends the launcher a
  close event, but Windows ends the process a few seconds later whether or
  not cleanup has finished. Use Ctrl+C for a complete cleanup.
- **A forced kill** (Task Manager "End task", `taskkill /F`, `SIGKILL`).
  No cleanup code runs at all.
- **The exit handler is only a best-effort last resort.** If the launcher
  exits without finishing cleanup (e.g. after an unexpected error), a
  synchronous handler force-stops the processes it spawned, and stops the
  DevFlow `mongo` service if it started it. It cannot wait for anything,
  and it doesn't run on a forced kill.

### Why Docker Desktop stays running

Docker Desktop is shared by every container and tool on the machine.
Closing it could break containers and projects unrelated to DevFlow. So
even when the launcher started Docker Desktop, it only prints that it is
leaving it running. Close it yourself from the tray icon if you want.

## Configuration (`.env`)

The launcher reads the same root `.env` as the API. It uses the existing
settings `OLLAMA_BASE_URL`, `OLLAMA_MODEL` and `PORT`; no model name or
host is built in. Everything below is optional:

| Variable                         | Default                                                      | Meaning                                                                    |
| -------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `DEVFLOW_AUTOSTART_DEPENDENCIES` | `true`                                                       | `false`: don't touch Docker, MongoDB or Ollama; only start the API and web |
| `DEVFLOW_COMPOSE_FILE`           | `docker-compose.yml`                                         | Compose file, relative to the repository root                              |
| `DEVFLOW_COMPOSE_PROJECT`        | the repo folder name, the way Compose derives it (`devflow`) | Compose project name                                                       |
| `DEVFLOW_MONGO_SERVICE`          | `mongo`                                                      | Compose service to start and stop                                          |
| `DEVFLOW_STOP_OWNED_MONGO`       | `true`                                                       | stop MongoDB on exit, if the launcher started it                           |
| `DEVFLOW_STOP_OWNED_OLLAMA`      | `true`                                                       | stop Ollama on exit, if the launcher started it                            |
| `DEVFLOW_DOCKER_DESKTOP_PATH`    | _(discovered)_                                               | full path to `Docker Desktop.exe`                                          |
| `DEVFLOW_OLLAMA_PATH`            | _(discovered)_                                               | full path to the `ollama` executable                                       |
| `DEVFLOW_WEB_PORT`               | `5173`                                                       | must match `apps/web/vite.config.ts`                                       |
| `DEVFLOW_STARTUP_TIMEOUT_MS`     | `180000`                                                     | how long to wait for each dependency                                       |
| `DEVFLOW_POLL_INTERVAL_MS`       | `2000`                                                       | readiness polling interval                                                 |
| `DEVFLOW_STOP_GRACE_MS`          | `10000`                                                      | graceful stop time before forcing                                          |

Variables set in the shell override `.env`, as they do for the API. The
launcher reads the whole `.env`, but never uses or prints
`MONGO_ROOT_PASSWORD`, `MONGODB_URI` or `JWT_SECRET`.

**Turn off automatic startup:** set `DEVFLOW_AUTOSTART_DEPENDENCIES=false`,
or start the pieces yourself with `npm run db:up`, `npm run dev:api` and
`npm run dev:web`.

## Stopping services yourself

- **MongoDB:** `npm run db:down` stops and removes the container (it is
  `docker compose down`). Data persists in the named volume. `npm run db:reset` **deletes the data**, so don't use it unless
  that is what you want.
- **Ollama:** quit it from the tray icon, or stop the `ollama serve`
  terminal. Don't kill every `ollama.exe`, because the desktop app may own
  some of them.
- **Docker Desktop:** quit it from the tray icon.

## Troubleshooting

- **"Docker did not become ready within … s".** The first start after a
  reboot can be slow. Open Docker Desktop, wait for "Engine running", then
  start DevFlow again, or raise `DEVFLOW_STARTUP_TIMEOUT_MS`.
- **"Docker Desktop was not found".** Set `DEVFLOW_DOCKER_DESKTOP_PATH`, or
  start Docker yourself.
- **"Could not start MongoDB".** Check that `.env` has
  `MONGO_ROOT_USERNAME` and `MONGO_ROOT_PASSWORD`, and that nothing else
  uses port 27017. See the logs with `npm run db:logs`.
- **"The configured model … is not installed".** Run `ollama pull <model>`,
  or set `OLLAMA_MODEL` to a model listed by `ollama list`.
- **"The Ollama server DevFlow started exited before it became ready".**
  Run `ollama serve` in a terminal to see why. Usually the port is taken
  or the install is broken.
- **"DevFlow's API is already running on port 4000".** Another DevFlow is
  running (perhaps another launcher or a manual `npm run dev:api`). The
  launcher uses it rather than starting a duplicate, and won't stop it.
- **"Port … is in use by another program that is not DevFlow's …".** Find
  and close that program: `netstat -ano | findstr :4000` (or `:5173`)
  shows its PID, and Task Manager shows which program that is. The
  launcher deliberately doesn't stop it for you.
- **"Starting MongoDB was interrupted".** You pressed Ctrl+C while MongoDB
  was starting. It may or may not be running now, and DevFlow doesn't
  treat it as its own. Run `npm run db:down` if you don't need it.

## Known limitations

- **Windows process termination.** Windows has no SIGTERM, so the launcher
  asks with `taskkill /PID <pid> /T` first. Console programs such as `npm`,
  `tsx` or `vite` usually ignore that, so after the grace period the
  launcher force-stops them with `taskkill /PID <pid> /T /F`. Either way,
  only the launcher's own process ID and its subprocesses are targeted.
  - On Ctrl+C, Windows also delivers the Ctrl+C directly to the API and web
    processes, because they share the console. They normally exit by
    themselves before the grace period ends.
  - `ollama serve` runs in its own hidden console, so it isn't hit by that
    Ctrl+C; the launcher stops it explicitly.
- **Hard kills and closing the window.** If the launcher is killed from
  Task Manager ("End task") or with `taskkill /F`, no cleanup code runs.
  Closing its terminal window gives cleanup only a few seconds. Either way,
  owned processes and MongoDB may be left running. Stop them as described
  above. The next launch finds them "already running", and treats them as
  external: it uses them and doesn't stop them.
- **Closing a browser tab does not stop DevFlow.** The browser is only a
  client. Stop DevFlow with Ctrl+C in the launcher's terminal.
- **MongoDB's restart policy** (`restart: unless-stopped` in
  `docker-compose.yml`). Docker restarts such a container when the Docker
  engine starts, _unless it was explicitly stopped_.
  - The launcher stops an owned MongoDB with `docker compose stop`, which
    is an explicit stop. It stays stopped, even across a Docker Desktop
    restart, until the next `npm run dev` starts it again.
  - A MongoDB the launcher leaves running (it was already running, or
    `DEVFLOW_STOP_OWNED_MONGO=false`) keeps running, and comes back when
    Docker Desktop restarts. The next launch treats it as external.
  - The launcher never changes the restart policy.
- **Docker Desktop discovery** checks the standard install locations only.
  Other locations need `DEVFLOW_DOCKER_DESKTOP_PATH`. On Linux the Docker
  daemon is not started; start it yourself.

## Manual smoke-test checklist

None of these touch your data or other Docker projects. Keep a second
terminal open for the checks.

1. **Docker Desktop closed.** Quit Docker Desktop, then run `npm run dev`.
   Expect "starting Docker Desktop", then "Docker is ready", and DevFlow
   running. On Ctrl+C the log says Docker Desktop is left running.
2. **Docker Desktop already open.** Expect "Docker is already running", and
   no second Docker Desktop window.
3. **Ollama already running** (the desktop app or `ollama serve`). Expect
   "Ollama is already running … will leave it running". After Ctrl+C,
   `curl http://localhost:11434/api/tags` still answers.
4. **Ollama not running.** Quit it, then run `npm run dev`. Expect
   "starting … serve" and "Ollama is ready". After Ctrl+C,
   `curl http://localhost:11434/api/tags` fails again.
5. **No duplicate Ollama.** While DevFlow runs, `tasklist /FI "IMAGENAME eq
ollama.exe"` shows one server. Its runner subprocesses may appear once
   a model is loaded.
6. **MongoDB stopped.** Run `npm run db:down`, then `npm run dev`. Expect
   "Starting MongoDB", then "MongoDB is ready". On Ctrl+C the log says
   "MongoDB (devflow/mongo) stopped; its data is kept", and
   `docker compose ps -a` shows `devflow-mongo` as exited, not removed.
7. **Other containers untouched.** Start an unrelated container, e.g.
   `docker run -d --name smoke-nginx nginx`, then start and stop DevFlow.
   `docker ps` still shows `smoke-nginx` running. Remove it afterwards with
   `docker rm -f smoke-nginx`.
8. **Only owned resources stop.** Combine 3 and 6: MongoDB stops and
   Ollama keeps running.
9. **External Ollama survives.** This is covered by check 3.
10. **Data survives a restart.** Create a project in the web app, stop
    DevFlow (MongoDB stops, per 6), run `npm run dev` again, and check the
    project is still there.
11. **Partial cleanup after a failed start.** With Ollama not running and
    MongoDB stopped, set `OLLAMA_MODEL=not-a-real-model:1` in your shell
    for one run (`set OLLAMA_MODEL=not-a-real-model:1 && npm run dev` in
    cmd). Expect the `ollama pull` guidance and exit code 1, with MongoDB
    and the Ollama server the launcher started both stopped again. Your
    `.env` is not changed.
12. **Restart policy.** After step 6's clean exit (MongoDB stopped by the
    launcher), quit and reopen Docker Desktop. `docker compose ps -a`
    should still show `devflow-mongo` as exited, not restarted. Then
    `npm run dev` starts it again, with your data.
13. **Unrelated program on a DevFlow port.** With DevFlow stopped, run
    `npx http-server -p 4000` (or any throwaway server) in another
    terminal, then `npm run dev`. Expect "Port 4000 is in use by another
    program that is not DevFlow's API", exit code 1, and the throwaway
    server still running. Stop it yourself afterwards.
14. **Ctrl+C.** Press Ctrl+C once. The log lists each cleanup action and
    ends with "Shutdown complete". Pressing Ctrl+C again during cleanup
    prints "Shutdown already in progress" and nothing runs twice.
