# fracto-admin-server

Express service for Fracto health checks and administrative status information. It listens on port 3005 and relies on shared constants and process utilities from the parent Fracto repository.

## Repository layout

This is an independent Git repository expected at `fracto/servers/fracto-admin-server/`. It imports `../../constants.js` and `../../utils.js`, so moving it outside that layout breaks shared imports.

Commit service-specific files from this repository. Commit shared configuration, utilities, startup scripts, and supervisor changes from the root repository.

## Requirements

- Node 22, the validated runtime.
- Git available on `PATH` for repository-status requests.
- The other Fracto services checked out beneath the root `servers/` directory when querying their status.
- A writable root `logs/` directory for the current `/version` implementation.

The service uses native ES modules.

## Installation

From the root repository:

```powershell
npm ci --prefix servers/fracto-admin-server
```

Or from this directory:

```powershell
npm ci
```

## Starting the service

Preferred full-system startup from the root repository:

```powershell
npm run start:check
npm start
```

Start only this service through the root launcher:

```powershell
node scripts/launch_service.js fracto-admin-server
```

For isolated development from this directory:

```powershell
npm start
```

The local command uses `nodemon`; the root supervisor runs `index.js` directly with a 16 GB heap limit. Do not start a second copy while port 3005 is already in use.

## HTTP endpoints

All registered endpoints currently use `GET`. The server permits cross-origin requests from any origin and advertises `GET`, `POST`, `PUT`, `DELETE`, and `OPTIONS`, although only the routes below are implemented.

### `GET /`

Basic health endpoint used by the root supervisor. It returns a plain-text welcome message.

### `GET /version?service_name=<name>`

Intended to return `git status` output for a repository beneath the root `servers/` directory. The response is a JSON object keyed by the supplied service name.

This endpoint is not currently reliable or safe for untrusted callers:

- `service_name` is interpolated into filesystem paths without an allowlist.
- Git output is redirected through a shell command into `logs/<service_name>-git.txt`.
- Error handling references an undefined variable and calls a nonstandard response method.
- The endpoint reports working-tree status rather than a package or Git revision number.

Keep this endpoint behind a trusted boundary until service names are validated against the root service registry, process output is captured directly, and errors use standard HTTP responses.

### `GET /logs`

The handler has no active response implementation and should not be used yet. Requests may remain open without receiving a response.

## Inactive code

`handlers/tile.js` contains a placeholder tile handler, but `index.js` does not register it as a route. It currently returns the same welcome text as the health endpoint and does not retrieve tile data.

## Shared root dependencies

The service relies on root-owned resources:

- `constants.js`: the admin port and service registry.
- `utils.js`: the synchronous child-process wrapper used by `/version`.
- `scripts/launch_service.js`: isolated supervised startup.
- `logs/`: supervisor logs and `/version` status output.

Changes to these resources belong in the root repository.

## Validation

From the root repository:

```powershell
npm run check
npm run start:check
```

For a manual health check:

```powershell
node scripts/launch_service.js fracto-admin-server
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3005/
```

Stop the launcher with Ctrl+C afterward.

The service's own `npm test` command is currently a placeholder and intentionally fails. Automated route and security tests remain future work.

## Logs and troubleshooting

When supervised by the root process, output is appended to `logs/fracto-admin-server-log-YYYY-MM-DD.txt` in the root repository.

Common failures:

- **Port 3005 already in use:** stop the existing supervisor or isolated admin service.
- **Shared import cannot be resolved:** restore this repository to `fracto/servers/fracto-admin-server/`.
- **Repository status fails:** verify Git is installed, the requested server exists, and the root `logs/` directory is writable.
- **A `/logs` request never completes:** the route is still a stub and does not send a response.
- **Startup update is blocked:** commit, stash, or revert tracked changes in this repository.

This service currently has permissive CORS and no authentication or authorization middleware. Its administrative routes should not be exposed directly to an untrusted network.
