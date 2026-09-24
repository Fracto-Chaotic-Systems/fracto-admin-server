# fracto-admin-server

Express service for Fracto health checks and administrative status information. It listens on the fixed bootstrap port (3005 in production, 3105 in development) and publishes the runtime service-port map.

## Repository layout

This is an independent Git repository expected at `fracto/servers/fracto-admin-server/`. Runtime port configuration is local to this service and is not committed.

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

### `GET /commits?limit=<count>`

Returns the most recent commits across the root repository and checked-out
service repositories. Results are sorted by author date descending and include
the repository name, hash, author, subject, changed-file count, insertions,
deletions, created files, removed files, and any Git tag names pointing at the
commit. The optional limit defaults to 100 and is capped at 250. Repository
paths are allowlisted by the handler. The response also includes raw
`tag_records` with each tag name, target commit, object type, creation time,
whether the tag is annotated, and the timestamp source (`tagger`, `commit`, or
`commit-fallback` when Git does not expose a creator timestamp); these records will support the unified
milestone timeline. `tag_events` provides the normalized form: one event per
tag name, with its grouped repositories and occurrences, sorted newest first.
When `.git` directories are absent from a production image, the endpoint reads
the recent commit and tag snapshot packaged in `build-info.json` during the launch
build. The snapshot's `tag_records` and `tag_events` fields preserve the same
separate response collections used by live Git collection.

TODO(2026-10-04): remove fallback for missing snapshot.

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
# Runtime service ports

The admin service is the bootstrap authority for internal service ports. `GET
/ports` returns a versioned JSON map for the main, data, asset, tiles, admin,
and UI services. Production keeps admin on port 3005 and development keeps it
on 3105 so the browser and supervisor have a stable discovery address.

An installation may provide an ignored `runtime/ports.json` file (or set
`FRACTO_PORTS_FILE`) with a `{ "ports": { ... } }` object. Environment
variables such as `FRACTO_DATA_PORT` override file values. The map is validated
for integer, unique TCP ports before it is returned.
