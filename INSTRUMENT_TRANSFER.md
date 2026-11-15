# Instrument transfer protocol 1

Status: **step 6 locally verified; deployment prepared**. Inventory, preview,
reservation, streamed transfer, full candidate/live validation and durable
publication work on both ends. Servers-page controls review and start exports,
track progress, cancel and verify receipts.
The lab initialization extension negotiates `replacement_policy: "source"` to
make the destination's registered package identical to the selected source.
Missing and differing files, including catalogs and CRLF-only notices, are staged,
validated and published with backups; no manual newline normalization is needed.
An older sender or receiver retains the original preserve/block behavior.
Capabilities advertise `preview_only: false`, `staging_supported: true` and
`publication_supported: true`; job status reports the negotiated peer capability.
Production playback/listening acceptance is performed by the operator after deployment.
See the root [deployment guide](../../deploy/INSTRUMENT_TRANSFER.md) and
[local verification record](../../deploy/INSTRUMENT_TRANSFER_VERIFICATION.md).

### Current setup and verification

Both servers need the updated admin/asset services and shared root
`utils/instrument_transfer.js` and `utils/instrument_transfer_stream.js`. Reuse the existing trusted-peer configuration and
internal service token. Configure an explicit `FRACTO_INSTRUMENT_DIR` and set
`FRACTO_INSTRUMENT_TRANSFER_PERSISTENT=true` only when that directory is on a
persistent bind mount/volume. The flag is an operator assertion of persistence;
preview also checks directory access and filesystem free space, without creating
probe files. Production Compose/image defaults to the named `fracto-instruments`
volume at `/var/lib/fracto/instruments` with persistence enabled. A custom
`FRACTO_INSTRUMENT_DIR` needs a matching persistent mount; the flag alone does not
create one. Development
Compose declares its existing instruments bind mount persistent. Recreate the
affected service when changing environment settings.

The implemented browser APIs are peer listing (capability status initially
`unchecked`), asynchronous preview creation/status, explicit apply and cancellation. Preview
negotiates capabilities before scanning. Browser authorization requires an
administrator or the explicit isolated-lab sync opt-in with the configured Origin.
Apply now continues from staged bytes through private `finalize`, and reports
`completed` only after checking the receiver's durable live-library receipt.
Older staging-only peers still end at `staged` with publication unsupported.
The public instrument routes cannot read staging, journals, candidates or backups.
The worker runs the existing complete source/index/PCM/percussion validators
before live writes and again against the installed library. Validation has a
30-minute worker deadline and keeps the owner lease alive without blocking HTTP.
All inventory scans remain read-only.
Three source/receiver sessions are retained per owner service, with at most one
scan of each kind active and a 30-minute scan/ready bound. Admin retains its three
newest previews. Cancellation/failure releases source and receiver work; expiry is
also reaped on access. Interrupted pre-commit jobs require a fresh preview after
restart; completed receiver receipts remain queryable for seven days, including
after in-memory eviction. Up to 512 unexpired receiver journals are admitted;
expired journal files are pruned at initialization and journal writes.

First startup into a new persistent root copies only allowlisted catalog-owned
image data, with the catalog last. Missing image audio remains missing for peer
repair. Existing catalogs or transfer journals suppress bootstrap, preventing an
image upgrade/restart from overwriting data or completing an interrupted commit.
Service JS stays in the image. The volume's catalog, originals, indexes, playback,
notices, journals and backups survive container replacement. Native installs retain
their existing default directory unless explicitly configured otherwise.

Receiver previews count verified cached files as matching, so a fresh preview
skips them after cancellation, a lost acknowledgement or a process restart.
`target_catalog_sha256` always describes the live catalog, including null when a
catalog exists only in staging. Partial bodies never count as matching. Ordinary
cancellation removes its uniquely-created `.part`; a hard process crash may leave
an inert `.part`, which is excluded from previews/exports and never resumed.
Verified cache files are retained; a corrupt cache entry can be atomically replaced
only after receiving and checking the complete expected source bytes. Automatic cache pruning is
outside this step. Retained bytes are included in filesystem free-space checks.

Apply reserves the source first, rehashes its pinned package asynchronously, then
reserves/rechecks the receiver snapshot. A busy destination releases the source
without waiting on another reservation. At most two file requests run concurrently,
with bounded buffers and HTTP backpressure through both admin hops. Source file
hash/identity are checked before its final chunk; the receiver checks length/hash,
fsyncs the temporary file, and atomically links it into the verified cache without
overwriting a matching existing file; corrupt cache entries are replaced only with
fully verified bytes. Supported directory fsync is also performed.
No success acknowledgement is returned for unverified bytes. An interrupted or
uncertain transfer reports `partial` when verified staged writes may remain.
Retry requires a fresh preview; incomplete files restart at byte zero. Applying
the same accepted plan while active or completed returns the existing job.

Existing catalog bytes are preserved in `.instrument-transfer/backups/<sha>.json`.
An absent previous catalog is recorded as null in the journal. With negotiated
source replacement, differing live files are backed up under
`.instrument-transfer/backups/<session-id>/<relative-path>` and replaced by atomic
rename of verified candidate links. Backups retain old inodes; no live bytes are
edited in place. Dependencies install before the catalog. The previous catalog is
also retained at the checksum-keyed backup path above. Identical files are reused.
Destination-only files and older unreferenced audio remain. During repair,
individual files may become readable before the whole job completes; an interrupted
replacement may temporarily leave a mixed library. Stop external importers/writers,
use a fresh preview to finish, and require the full live verification receipt.
Without negotiated replacement, differing files/catalogs still block.

Before the catalog commit, cancellation stops validation/install work and leaves
verified installed files reusable. During catalog commit/live verification,
cancellation returns the current state and verification settles before the final
result. A journal records accepted identity, publication intent and the completion
receipt. Restart never resumes file installation or promotes a pending catalog.
An interrupted intent is verified against all live bytes and the full validators:
it becomes completed only if the live package already matches, otherwise partial.
Lost finalize acknowledgement is recovered by polling that receipt, not by an
automatic rollback. Receipts prove the recorded verification time.

Reservations use a five-minute progress/status lease, a six-hour apply deadline,
60-second file inactivity deadline and 30-minute absolute file deadline. Cancelling
or expiring a reservation aborts its streams and releases the owner lock only after
I/O settles. These locks coordinate the single asset-service owner; offline
importers and external filesystem writers must remain idle during transfer.

From the root run `npm run test:instrument-transfer`; the full asset regression is
`npm --prefix servers/fracto-asset-server run test:instruments`. Tests use isolated
stores and loopback services in both directions. They do not export application
assets or run the final production test.

## Scope and ownership

The operator selects a trusted remote server in Admin / Servers and exports the
local instrument package to it. The local admin service coordinates the job and
pushes bytes to the remote admin service. Each admin service accesses only its
own asset service; the asset service exclusively owns inventory, staging,
validation and publication under `FRACTO_INSTRUMENT_DIR`. Installing the same
backend on both servers permits either to initiate an export. No reverse network
connection is needed during a particular export.

Protocol 1 is a one-way, whole-package repair/install, not a two-way merge.
Receivers advertise `replacement_policies: ["source"]` when durable replacement
and publication are supported. Updated coordinators request `replacement_policy:
"source"` when both services support publication; omission defaults to `preserve`.
Unknown policy values are rejected. The selected source's entire catalog wins,
including defaults, enablement and program assignments. Different catalogs and
files block only when source replacement was not negotiated. Preview never writes
live files; explicit apply authorizes the replacements reviewed in that plan.
An identical catalog with missing indexes/audio is a supported repair target even
if the receiver's public catalog endpoint currently fails to load.

Scope includes disabled/audited entries and their registered dependencies, not
only currently playable instruments. Preserve original metadata and bytes;
transfer never synthesizes samples, enables instruments, changes program maps,
downloads upstream sources, runs importers or infers a new license.

## Package and identity

The source asset service builds a private manifest from validated on-disk catalog
metadata, not the public `/instruments` projection (which omits required paths and
indexes). No arbitrary directory export or caller-supplied download URL is accepted.
The manifest contains exactly:

| Kind | Membership |
| --- | --- |
| `catalog` | One `catalog.json`, exact source bytes |
| `index` | Every melodic index referenced by recording timing/pitch maps and every prepared drum render manifest |
| `original` | Every registered melodic original recording |
| `playback` | Every registered melodic playback chunk and prepared drum-kit WAV |
| `support` | Code-allowlisted source locks, attribution and upstream notices below |

For the currently supported libraries, the support allowlist is
`fluidr3-gm/{source-lock.json,NOTICE.md,upstream/LICENSE.txt,upstream/README.md}`
and `fluidr3-percussion/{README.md,source-lock.json,kit-inventory.json,renderer-lock.json,upstream/COPYING,upstream/README,upstream/README.md,upstream/FLUIDSYNTH-LICENSE}`.
Include the applicable library's complete list; unknown libraries require a code
update defining their dependencies. `legacy` has no separate support list;
its provenance and unknown usage terms remain in the catalog. Source-lock audit fields are preserved as
historical evidence, not interpreted as current playback enablement. Upstream
URLs in those documents are inert metadata. Caches, SF2 binaries, renderers,
executables, credentials, databases, MIDI uploads and unreferenced files are excluded.

Each unique relative destination path occurs once, even when multiple catalog
records share a file. Identical bytes at different required paths remain separate
entries. Reject duplicate, case-fold-colliding or inconsistent path registrations.
An entry is `{ "file_id": "<64 lowercase hex>", "kind": "playback",
"relative_path": "playback/<recording-id>/<sha256>.wav", "bytes": 1234,
"sha256": "<64 lowercase hex>" }`. `file_id` is SHA-256 of the UTF-8 relative
path. The receiver independently derives valid catalog dependency paths and checks
support paths against its own allowlist; manifest paths alone grant no write access.

All hashes are lowercase hexadecimal SHA-256. Catalog/index/audio hashes cover
exact file bytes, with no JSON or newline normalization. Package manifest bytes
are UTF-8 `JSON.stringify` output with no whitespace/BOM/newline, fields in this
order: `protocol_version`, `catalog_sha256`, `files`. Entries have fields in the
order above and are sorted by ascending ASCII `relative_path`. Paths are ASCII,
root-relative, slash-separated and case-preserving. `manifest_sha256` hashes these
exact serialized manifest bytes; both ends regenerate and compare them.

`protocol_version` is integer `1`. `catalog_sha256` identifies the sole catalog
entry. UUIDs identify jobs/sessions; they are opaque, never filesystem paths.
Byte/file counters are nonnegative JSON safe integers. All JSON request schemas
reject unknown fields. Hashes identify integrity, not authorship or authorization.

## Compatibility, authentication and limits

Both admin and asset services advertise protocol versions and catalog/index/audio
method versions they implement. Negotiate exact version 1 and require the receiver
to understand every package format before transfer. Existing catalog schema 1
validation and its 32 MiB / 16 libraries / 2,048 combined instrument-and-kit bounds
remain in force. Older/missing endpoints produce `instrument_transfer_upgrade_required`;
never fall back to database sync, mesh sync or public audio URLs.

Capabilities are `{ protocol_versions: [1], catalog_schema_versions: [1],
index_methods: ["<supported method_version>"], audio_methods:
["<supported method_version>"], support_libraries: ["legacy", "fluidr3-gm",
"fluidr3-percussion"], receive_ready: true, error: null, limits: { ... } }`.
`limits` uses integer byte/count/second fields named `control_bytes`,
`manifest_bytes`, `manifest_files`, `file_bytes`, `package_bytes`,
`concurrent_files`, `preview_seconds`, `session_idle_seconds`,
`file_idle_seconds`, `file_seconds`, `apply_seconds` with the bounds above/below.
`preview_request_bytes` additionally bounds the catalog-plus-manifest envelope.
An unready receiver sets `receive_ready: false` and the defined error object.
Use the minimum advertised limits on both ends; never exceed protocol maxima.

Reuse `FRACTO_DATABASE_SYNC_PEERS` and `x-fracto-sync-token` for peer requests,
with the selected address-book URL resolved only through server configuration.
An address-book entry alone is insufficient. Authenticate before reading JSON or
binary bodies. Bind every remote session to the authenticated peer credential;
another peer cannot read or mutate it. Browser job routes require the existing
administrator and trusted-Origin checks. The read-only bypass grants no access.
The isolated-lab sync opt-in covers the exact browser peer/job/status/apply/cancel
routes; it grants no access to peer or internal service routes.

Admin-to-local-asset calls require `FRACTO_INTERNAL_SERVICE_TOKEN`. Neither that
token nor browser cookies go to peers. Peer secrets stay out of browser payloads,
URLs and logs. Reject redirects; transfer routes use `Cache-Control: no-store`.
Production uses its existing HTTPS/trusted-private-network peer policy.

| Bound | Protocol 1 limit |
| --- | --- |
| Small control request/response | 64 KiB encoded JSON |
| Manifest | 32 MiB encoded JSON; 10,000 unique files |
| Receiver preview request | 96 MiB JSON envelope (manifest plus exact catalog text, including JSON escaping); catalog itself remains bounded to 32 MiB |
| Single file | 512 MiB; existing tighter format-specific bounds still apply |
| Package | 32 GiB, summed over unique paths |
| In-flight file requests | At most 2 per receiving store; stream with backpressure |
| Jobs | One applying transfer per source and destination store |
| Preview validity | 30 minutes after ready |
| Session inactivity | 5 minutes without control or byte progress |
| File inactivity | 60 seconds without byte progress; 30 minutes absolute/file |
| Apply duration | 6 hours; explicit terminal failure on expiry |
| Receiver journal history | 512 unexpired records; terminal receipts retained 7 days |

Long scans/validation run asynchronously with progress and cancellation; a single
HTTP request must not hold the whole operation open. Bound streaming buffers and
never buffer/base64 an entire audio file. Report limits before starting apply.

## Admin/browser contract

Routes are relative to admin, e.g. `/api/admin/instrument-transfer` behind nginx.

| Method and path | Request / behavior |
| --- | --- |
| `GET /instrument-transfer/peers` | Configured peer URLs and negotiated capability status; no endpoints/secrets |
| `POST /instrument-transfer/jobs` | `{ "protocol_version": 1, "peer": "<saved public URL>" }`; create asynchronous export preview, HTTP 202 |
| `GET /instrument-transfer/jobs/:id` | Bounded job status, progress and preview summary |
| `POST /instrument-transfer/jobs/:id/apply` | `{ "protocol_version": 1, "plan_sha256": "<preview digest>" }`; explicitly start the ready plan through verified publication, HTTP 202 |
| `POST /instrument-transfer/jobs/:id/cancel` | `{ "protocol_version": 1 }`; request cancellation, HTTP 202 |

Job status always includes `protocol_version`, `id`, `state`, `phase`,
`manifest_sha256` (null until known), `plan_sha256` (null until ready),
`expires_at` (UTC RFC3339 or null), `progress`, `summary` (null until available),
and `error` (null or the error object below). Initiation returns the same shape.
`progress` contains `files_checked`, `files_verified`, `files_total`,
`bytes_transferred`, `bytes_to_transfer` and `current_file_id` (or null).
Transferred bytes count acknowledged verified payloads, not retransmitted traffic.
The summary contains source/target catalog hashes (target may be null),
`package_files`, `package_bytes`, `matching_files`, `missing_files`, `missing_bytes`,
`conflict_files`, up to 100 conflict file IDs, `replacement_bytes`,
`replacement_files`, `free_bytes`, `required_free_bytes`,
and `publication_state` (`unchanged`, `published`, `unknown`). Browser results
contain no local filesystem paths, configuration secrets or raw exception messages.
`replacement_bytes` counts source payload bytes needed for differing files;
`missing_bytes` remains missing-only. `replacement_files` counts differing live
files even when verified staged bytes already satisfy them. Job status includes
`replacement_policy`; both transfer byte totals and the pending bitmap include
missing plus differing files. Older summaries default replacement bytes to zero.

State transitions:

```text
previewing -> ready -> transferring -> validating -> staged
staged -> validating -> publishing -> verifying -> completed
previewing -> blocked | failed | cancelling -> cancelled
ready -> expired | cancelling -> cancelled
transferring | validating -> cancelling -> cancelled | partial
transferring | validating | publishing | verifying -> failed | partial
```

`blocked` means an actionable preview incompatibility/conflict; it cannot apply.
`partial` means durable destination changes occurred or publication acknowledgement
is uncertain. `failed` means no durable destination change occurred. Cancellation
after installed files is `partial`, with `error.code: instrument_transfer_cancelled`.
Publishing is a short non-cancellable critical section: finish/reconcile it before
honoring cancellation. Completed/cancelled/partial/failed/blocked/expired are terminal;
retry creates a fresh preview. Repeating apply on the same accepted plan returns
its existing job; it never starts a second transfer. Cancel is idempotent.

## Sender/receiver exchange

The source retains a manifest snapshot for the preview without locking stores for
operator review. The receiver's inventory hashes actual file bytes; matching size
alone does not count as present. Differing bytes at any required path, including
corrupt audio and support-document line endings, are replacement candidates when
source replacement is negotiated; otherwise they block. Exact source hashes remain
mandatory. No newline-equivalence exception or checksum bypass is used.
The source must hash and validate every required dependency before preview can
be ready; any missing/invalid source file produces `source_incomplete` and cannot
be omitted from the package. No-op plans still require explicit apply and final
verification before reporting completion.

Peer routes live at `/instrument-transfer/peer`; local asset-owner routes at
`/internal/instrument-transfer` implement the same receiver session operations.
The local owner additionally exposes `GET /capabilities`,
`POST /exports` (`{ protocol_version }`), `GET /exports/:id`,
`GET /exports/:id/manifest`, `POST /exports/:id/reserve`,
`GET /exports/:id/files/:file_id` and `POST /exports/:id/release`.
Export status returns `state` (`scanning`, `ready`, `reserving`, `reserved`, `failed`,
`cancelled`), `files_checked`,
`manifest_sha256` (or null), and `error`; reserve accepts `manifest_sha256` and
revalidates the export, returning 409 if changed. Release takes only protocol version.
Other export control bodies contain only protocol version. The manifest endpoint
returns the canonical manifest; file GET streams exact identity-encoded bytes with
Content-Length and `ETag: "<sha256>"`, only while reserved.
Creating an export returns `{ protocol_version, export_id }`. An additional local
`GET /exports/:id/catalog` returns the exact UTF-8 source catalog bytes (32 MiB
maximum). The coordinator sends these as `catalog_text` beside the canonical
manifest to allow an empty/broken receiver to independently derive dependency
paths before any library writes. Catalog text does not change manifest identity;
its hash/length must equal the manifest's sole catalog entry.

| Peer method and suffix | Responsibility |
| --- | --- |
| `GET /capabilities` | Versions, supported formats, limits and receive readiness; no absolute paths |
| `POST /sessions` | `{ protocol_version, manifest, catalog_text, replacement_policy? }`; optional policy is `source`, omission preserves legacy behavior; return 202 with session ID |
| `GET /sessions/:id` | Inventory/apply progress, bounded summary, target snapshot digest and final receipt |
| `POST /sessions/:id/prepare` | `{ protocol_version, manifest_sha256, target_snapshot_sha256, plan_sha256 }`; reserve/revalidate target; reject stale preview |
| `PUT /sessions/:id/files/:file_id` | Raw `application/octet-stream`, exact declared Content-Length, no content encoding; expected bytes/hash come only from pinned manifest |
| `POST /sessions/:id/finalize` | `{ protocol_version, manifest_sha256, plan_sha256 }`; start asynchronous validation/publication; return 202 |
| `POST /sessions/:id/stage` | Same identity body as finalize; asynchronous byte validation ending at `staged`, followed by finalize for publication |
| `POST /sessions/:id/cancel` | `{ protocol_version }`; release after active I/O/critical publication settles |

Session-create returns `{ protocol_version, session_id }`; subsequent JSON session
status contains `protocol_version`, `session_id`, `state`, `progress`, `summary`,
`target_snapshot_sha256` (null until ready), `receipt` (null until completed), and
`error`. Step-3 status additionally contains `manifest_sha256` and `pending_bitmap`:
canonical base64 of ceil(file-count / 8) bytes, bit (index & 7) in byte (index >> 3)
set for each pending missing or replacement file at its canonical manifest index. Unused high bits must
be zero. This keeps the 10,000-file plan within the 64 KiB control-response limit.
An unknown or matching file cannot be uploaded; retries of a planned pending file
are allowed. Session states follow the job states above, substituting `scanning`
for `previewing`, adding `preparing` and omitting `expired` until a ready session
expires. Prepare returns that status initially in `preparing`; poll until
`transferring` before PUT. Repeat prepare with the same accepted plan is
idempotent. File PUT returns `{ protocol_version, file_id, sha256, bytes,
disposition }`, where disposition is `staged` or `already_present`; unexpected
files, lengths, active duplicate PUTs and writes before prepare are rejected.
Small status/cancel/release requests carry no file data. Manifest and exact catalog
retrieval use their respective larger metadata bounds. Both admin hops stream file
bodies without JSON parsing and propagate disconnects/cancellation to local owners.

`target_snapshot_sha256` hashes canonical `JSON.stringify` bytes of
`{ catalog_sha256, files, live_files }`, where files are ASCII-path-sorted objects
`{ file_id, state, sha256, bytes }`; state is `missing`, `matching` or `conflict`,
and missing hashes/lengths are null. `live_files` records actual live
`{ file_id, sha256, bytes }` independently of the reusable staged cache, so a cache
hit cannot hide a live-file change after preview. `plan_sha256` hashes canonical bytes of
`{ protocol_version, peer, manifest_sha256, target_snapshot_sha256, replacement_policy }` in that order;
`peer` is the normalized selected public URL. The receiver checks manifest/target
digests and binds the opaque plan digest to the session; the source coordinator
derives and verifies the full plan. Space figures are advisory and excluded from
these identities; capacity is rechecked at prepare and during writes.

Apply reserves source first, then destination. A nonblocking busy response releases
the source and requires retry, avoiding opposite-direction deadlocks. Revalidate
the source manifest and destination observations before accepting the plan. Only
cooperating package writers/importers may operate under the same owner lock;
external writers must remain idle. Snapshot files are checked before/after reads
and again before finalization. Do not silently update the plan while applying.
Keep reservations alive with authenticated status polling and byte progress.

## Durable publication and recovery

This section is implemented in step 4. The intermediate `staged` state remains a
byte-verification result; `completed` additionally requires live publication and
a durable receipt. CPU-intensive validation runs in a bounded worker. Temporary
candidate mirrors use hard links and are removed after the transaction settles;
verified cache files and previous catalogs are retained.

1. Receiver verifies persistent storage is configured, writable and usable by the
   running asset service. Container-local disposable storage reports not ready.
   Require free bytes >= missing bytes + replacement bytes + largest pending file + 1 GiB reserve;
   recalculate as files install. Validate staging and final paths on the same volume.
2. Receive into a private `.instrument-transfer/` staging area under that root.
   Reject links/reparse points, nonregular files, traversal, absolute/drive/UNC
   paths and escaping ancestors on both read/write paths. Use exclusive staging
   creation and race-resistant publication; never overwrite an unexpected target.
3. Verify exact length/hash before atomic installation. Replacements require the
   approved previous bytes to remain unchanged and a durable backup. Metadata
   files also undergo existing format/index/source checks. Staged candidate checks
   read the union of existing matching and verified staged files. Never copy code,
   permissions, ownership or host-specific paths from the sender.
4. Install verified dependencies first. Validate the complete candidate with the
   receiver's catalog/index/audio validators. Preserve the old catalog durably;
   publish `catalog.json` atomically only if the expected previous hash/absence
   still matches. For identical catalogs, validate dependencies and explicitly
   invalidate/reload the live library even though catalog mtime did not change.
5. Read back all required files, validate the live library, and issue a durable
   receipt `{ protocol_version, manifest_sha256, catalog_sha256, files_verified,
   bytes_verified, completed_at }`. Only matching manifest/catalog hashes and
   expected verified counts/totals permit `completed`. Confirm the public inventory
   reports playback available for every entry with registered playback assets;
   audited kits without prepared audio remain unavailable by design.

Do not delete destination-only files or old versioned audio. Existing readers may
keep using installed audio; this protocol is not a distributed transaction.
Retain verified installed dependencies after interruption; a new preview skips
them. Incomplete staging files never become public or exportable. Retrying a PUT
after a lost acknowledgement returns `already_present` only after checksum proof.
Do not implement byte-offset resume in v1. If publication succeeds but the reply
is lost, query the durable receipt through session status; never blindly roll back.
Persist session ownership, accepted identity, publication intent and receipt so
receiver restart can reconcile publication. Interrupted work does not auto-resume;
release expired reservations, reconcile to `partial`/`failed`, and start a new preview.
Source admin job restart likewise requires a fresh preview; it must not manufacture
success from transferred byte counts. Retain terminal session receipts for 7 days.

## Errors and implementation acceptance

The Servers-page controls export from the current server to the selected trusted
connection. They review preview counts and space, disable incompatible/unnegotiated conflicting
or expired plans, send the reviewed plan hash, and poll through publication and
receipt verification. Job IDs are remembered per browser session and connection;
returning to the page resumes status checks without restarting work. Lost write
acknowledgements trigger status checks, never an automatic apply retry. Partial
or missing jobs require a new preview. Cancel waits for the server's final state.
To reverse direction, open Servers on the other server. The existing opt-in
`FRACTO_ADMIN_SYNC_LAB_BYPASS` covers only instrument browser peers/jobs/status/
apply/cancel routes with the exact UI origin; peer/internal routes retain secrets.

Errors use `{ "error": { "code": "instrument_transfer_<reason>",
"retryable": false } }` on HTTP failures, with the same error object in status.
No raw remote errors or disk paths are returned. Retryable means a fresh preview
may succeed after transient recovery, not permission to repeat apply automatically.

| HTTP | Reasons (prefix omitted) |
| --- | --- |
| 400 | `invalid_request`, `invalid_manifest`, `invalid_path` |
| 401/403 | `unauthorized` (administrator/peer/internal checks as appropriate) |
| 404 | `job_not_found`, `session_not_found`, `file_not_found` |
| 409 | `upgrade_required`, `catalog_conflict`, `file_conflict`, `snapshot_changed`, `busy`, `invalid_state` |
| 410 | `expired` |
| 413 | `limit_exceeded` |
| 422 | `source_incomplete`, `checksum_mismatch`, `validation_failed` |
| 503 | `storage_not_ready`, `peer_unavailable`, `timeout`, `cancelled`, `interrupted`, `verification_failed` |
| 507 | `insufficient_space` |

Only `busy`, `peer_unavailable`, `timeout`, and `interrupted` are transient/retryable;
other errors require correcting state/configuration or deliberate operator action.
Map a legacy peer's 404/nonprotocol response to `upgrade_required`, while preserving
a real authenticated protocol-1 resource 404 as not-found.

Steps 2–5 must cover both directions with isolated stores, byte-identical no-op,
empty receiver, same-catalog missing dependencies, disabled/audited dependencies,
catalog/file conflicts, missing source data, corrupt transfer, changed previews,
lost acknowledgements, cancellation, owner/process restart around publication,
disk limits, link/path escapes and unauthorized peers. Step 6 verifies persistent
container storage and the Bach guitar assignment locally; the operator performs
the final production export and listening test after both backends are deployed.
