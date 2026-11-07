# Mesh file synchronization

Select a remote server in Server Awareness and use **Preview mesh sync**, then
**Sync mesh files**. This is a separate two-way file merge; it never starts
database synchronization and does not require matching SQL migrations.

Both servers need this code, including the tiles-service sync endpoints. The
existing `FRACTO_DATABASE_SYNC_PEERS` trusted-peer configuration and pair-specific
secret are reused; see [DATABASE_SYNC.md](DATABASE_SYNC.md). The admin service
contacts only its own tiles service with `FRACTO_INTERNAL_SERVICE_TOKEN`. Configure
that private token on the supervisor when authentication is disabled; authenticated
launches already generate one when none is supplied. It is never sent to another
server or browser. No additional volume is required: files remain in `meshes/`
beneath the configured tile volume/source directory.

## What is shared

- Validated `FTMESH01` gzip geometry assets, addressed by short code.
- Missing files are copied in both directions. Matching SHA-256 checksums are
  skipped. Conflicting bytes at the same short code require an explicit server
  preference before apply.
  The preview reports the full conflict count with up to 200 examples to keep
  the browser responsive; the chosen preference applies to every conflict.
- Invalid/stale files are reported and excluded as sources. A compatible valid
  copy on the other server can replace an invalid target at the same short code.
- Numerical tiles, SQL data, store markers, local inventory snapshots/journals,
  temporary files, and job/region manifests are not copied. The receiver registers
  each published asset in its own inventory, making it available to heat maps and
  runtime retrieval without a restart or copying another server's inventory.

Both mesh namespaces (tile index fingerprint, source mode/generation, build
profile) and mesh format/profile versions must match. A different source identity
is rejected rather than installing meshes that the runtime would mark stale.
Storage layouts may differ: short codes map to each receiver's own `level` or
`shortcode` directory layout. The sync never asks the receiver to read/download
numerical tiles or calculate new meshes.

## Consistency and recovery

Preview acquires a short-lived reservation on each mesh store, reconciles file
observations with the local inventory, and displays per-level counts, conflicts,
and transfer totals. Reservations are released before the operator reviews it.
Apply reacquires both stores and rejects changed preview catalogs. Mesh job
queues cannot start generation while a store is reserved; sync cannot acquire
a store with queued/running mesh jobs or pending mesh writes. Other terrain reads
remain available. External file writers must stay idle during synchronization.

Files transfer individually with bounded memory. Both source and receiver check
SHA-256, compressed length, short code, namespace, and the SDK's mesh decoder.
The receiver checks the current target checksum, writes a durable temporary file,
atomically replaces the asset, and updates the inventory through its single
service owner. Paths are derived only from validated short codes, and symbolic
links/nonregular files in the destination path are rejected.

Completed status requires both stores' compatible ready-file catalogs to have
the same checksums as the planned union. Changes or transfer failures never
report success. Published files are retained on partial failure; preview again
and retry, and already matching files are skipped. This is incremental retry,
not a distributed rollback or a byte-offset resume of an incomplete file.
Abandoned reservations expire after five idle minutes; restarting the tiles
service also releases its in-memory reservation. Incomplete temporary files are
not exported. Successful publication is durable independently of the admin job.

Transfers support up to 500,000 catalog records (64 MiB encoded catalog) per
resulting store and 16 MiB compressed per mesh,
with the SDK's existing 16 MiB decompression limit. Larger inputs fail explicitly;
there is no aggregate mesh-store byte limit and no numerical tile traversal.
Destination disk capacity uses the existing tile/mesh free-space check.

The browser uses the same preview/conflict/progress UI as database sync, with
independent session-storage job IDs and file/byte counters. Newest previews are
retained in admin-service memory (three, expiring for apply after 30 minutes).
Administrator and trusted-Origin checks protect browser mutations. Peer requests
use the dedicated pair secret, and internal mesh-store requests require the
private service token before parsing transfer bodies.

## Verification

From the root: `npm run test:mesh-sync`.

The integration tests use two temporary mesh stores and authenticated HTTP
services, exercise both file layouts, choose conflict preference, repair corrupt
meshes, check live inventory availability, preserve tile sentinels, recover from
lost transfer acknowledgement, block active mesh generation, reject changed
previews, mismatched source identities, checksum failures and symlink escapes,
and release abandoned reservations. No application meshes or tiles are copied
by these tests.
