# fracto-admin-server

## Database synchronization

Server Awareness can preview and apply a two-way database merge with a configured
trusted peer. See [DATABASE_SYNC.md](DATABASE_SYNC.md) for peer configuration,
conflict handling, exclusions, consistency guarantees, and disposable tests.

## Admin chat bridge

Chat requests optionally select `mode: "app-reference"` for bounded exact cited
passages from the AI service's published app snapshot. Missing mode/`"chat"` keeps
model chat. Authentication, origin checks, machine credentials and streaming
framing apply to both modes. Fixed `CHAT_REFERENCE_UNAVAILABLE` and
`CHAT_REFERENCE_QUESTION` errors are preserved without upstream details. See
`../fracto-ai-server/app_reference/CHAT.md` for retrieval and publication policy.

`POST /chat` (nginx: `/api/admin/chat`) requires the configured UI Origin and a
current, enabled administrator session by default, even when authentication is optional or
the lab read-only bypass is enabled. For a private lab only,
`FRACTO_ADMIN_CHAT_LAB_BYPASS=true` explicitly enables this chat POST without login
when `FRACTO_AUTH_MODE=none` and `FRACTO_AUTH_REQUIRED` is not true. It does not
open other admin routes or the AI machine API. The configured UI Origin remains
mandatory. Both Compose profiles default this separate setting to false.
Authorization runs before JSON parsing or
machine-credential reads. The response uses `Cache-Control: no-store`.

Development Compose supports a separate `FRACTO_AI_LAB_MIN_FREE_MEMORY_MIB`
reserve override, in MiB. It otherwise keeps the ordinary
`FRACTO_AI_MIN_FREE_MEMORY_MIB`/6144 default; production ignores the lab override.
Insufficient memory/disk and missing models return fixed, specific General chat
errors. App reference uses read-only retrieval without generation admission.

The version 1 request is `{ "contract_version": 1, "messages": [
{ "role": "user", "content": "Hello" } ] }`. Only `user` and `assistant`
messages are accepted, with a final user message, at most 16 messages and 8192
UTF-8 bytes of serialized messages. Request bodies are limited to 16 KiB;
unknown fields, query parameters and compressed bodies are rejected. File data
and system prompts are outside this text-only bridge contract. The browser can
extract supported text attachments and include their names and contents in a
normal user-message string. The bridge's combined message limits still apply;
there is no raw upload endpoint or file persistence.

The bridge calls only `http://127.0.0.1:<FRACTO_AI_PORT>/inference/chat`
(default port 3007), without redirects, browser cookies or browser credentials.
Its `X-Fracto-AI-Token` comes from server-only `FRACTO_AI_INFERENCE_TOKEN`, or
`<FRACTO_AI_DATA_DIR>/machine-token`. Without a data-directory override, it reads
the AI service's native `runtime/inference/machine-token`. Existing Compose
deployments share the private AI data directory with the admin process. If the
AI service uses an environment token override, supply the same override to the
admin process; an override configured only in the AI service's own `.env` is not
inherited by the admin process. Credentials are reread for each request and are
never returned, logged or forwarded from browser input.

The expected AI response is `{ "contract_version": 1, "message": {
"role": "assistant", "content": "Hello back" } }`. Only these fields are
returned to the browser. Responses are bounded to 72 KiB with at most 64 KiB of
assistant text. The bridge aborts on browser disconnect or after 180 seconds and
returns fixed error codes without upstream error bodies or configuration details.

The AI service implements `/inference/chat`, and the admin chat UI sends text
history through this bridge. Missing/unavailable AI services return HTTP 503
`CHAT_UNAVAILABLE`; generation deadlines return HTTP 504 `CHAT_TIMEOUT`.
The UI forwards cancellation through both HTTP hops to the local engine.

The UI requests `Accept: application/x-ndjson` to receive incremental text.
The bridge validates and rebuilds version 1 delta records, then sends a `done`
record only after the upstream stream completes successfully. Truncated or
invalid streams produce a fixed terminal error, keeping partial text visible.
Provider metadata and raw errors are never relayed. Downstream backpressure is
awaited and `X-Accel-Buffering: no` prevents nginx response buffering. Non-stream
callers retain the existing JSON response. The existing 180-second bridge timeout
also bounds streaming, including slow readers; Stop/disconnect aborts upstream.

Run the bridge integration tests from the root checkout with
`node --test test/admin_chat.test.js`.

The runtime port map includes `ai` (`FRACTO_AI_PORT`, default 3007). AI is also
included in the repository allowlist for Reference and Commits. Older local port
files use the default when `ai` is absent; development Compose sets 3107.

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

The server advertises `GET`, `POST`, `PUT`, `DELETE`, and `OPTIONS`. Administrative routes require a valid enabled administrator session verified by the main server. `GET /` and `GET /ports` are available without an administrator session. By default, credentialed browser requests are allowed from the configured UI origin. Setting `FRACTO_ALLOW_CORS_ALL=true` reflects any requesting origin and allows credentials, so use it only when that broad access is intended.

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

Live Git reads pass an exact `safe.directory` override for each allowlisted
repository, which supports container checkouts whose owner differs from the
service process. If Git is unavailable for a repository and `build-info.json`
is missing or invalid, the endpoint returns an empty collection for that
repository instead of failing the entire commits request.

TODO(2026-10-04): remove fallback for missing snapshot.

### `GET /reference/tree`

Returns `{ "repositories": [{ "name": "fracto", "files": ["README.md"], "folders": ["images"] }] }` for the fixed root and service repository allowlist. `files` contains Git-tracked Markdown paths relative to each repository root, excluding files inside dot-prefixed directories. `folders` contains visible parent directories of all Git-tracked files, including directories with no Markdown documents; dot-prefixed directories are omitted. The endpoint returns paths only and does not read document contents. Repositories without a `.git` entry return empty file and folder lists.

### `GET /reference/document?repository=<name>&path=<relative-path>`

Returns `{ "repository": "fracto", "path": "README.md", "content": "..." }` for one tracked Markdown file. Both parameters are required. The repository must be in the fixed allowlist, the path must be a safe relative Markdown path, and the resolved regular file must remain inside that repository. Unknown, untracked, missing, or unsafe documents return `404`; Git or filesystem failures return a generic `503` response. Both Reference endpoints disable caching.

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

Run the service tests from this directory:

```powershell
npm test
```

The tests cover the repository allowlist, tracked Markdown path parsing, and
Reference document success and rejection cases.

For a manual health check:

```powershell
node scripts/launch_service.js fracto-admin-server
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3005/
```

Stop the launcher with Ctrl+C afterward.

From the UI directory, the Reference tree helper is covered by `npm run test:reference`.

## Logs and troubleshooting

When supervised by the root process, output is appended to `logs/fracto-admin-server-log-YYYY-MM-DD.txt` in the root repository.

Common failures:

- **Port 3005 already in use:** stop the existing supervisor or isolated admin service.
- **Shared import cannot be resolved:** restore this repository to `fracto/servers/fracto-admin-server/`.
- **Repository status fails:** verify Git is installed, the requested server exists, and the root `logs/` directory is writable.
- **A `/logs` request never completes:** the route is still a stub and does not send a response.
- **Startup update is blocked:** commit, stash, or revert tracked changes in this repository.

The service should remain behind the deployment's trusted network boundary. Administrative routes use the shared administrator-session check; the health and port-discovery routes are intentionally public. CORS policy is not a substitute for network controls.
# Runtime service ports

The admin service is the bootstrap authority for internal service ports. `GET
/ports` returns a versioned JSON map for the main, data, asset, tiles, admin,
and UI services. Production keeps admin on port 3005 and development keeps it
on 3105 so the browser and supervisor have a stable discovery address.

An installation may provide an ignored `runtime/ports.json` file (or set
`FRACTO_PORTS_FILE`) with a `{ "ports": { ... } }` object. Environment
variables such as `FRACTO_DATA_PORT` override file values. The map is validated
for integer, unique TCP ports before it is returned.
