# Database synchronization

Server Awareness offers **Preview sync** for a selected remote server. A preview
compares migration history, checksums, installed table names and definitions,
then shows row counts and conflicting primary/unique keys. **Sync both servers**
performs a two-way union. If conflicts exist, choose which server supplies all
conflicting rows. Nonconflicting rows from both sides remain. No tables are
installed, migrated, or backfilled by this feature.

`tiles` and `automation` are excluded from metadata comparison, row reads and
writes. All other installed tables, including authentication and orbital tables,
participate. Actual column, index and foreign-key definitions must also match.
Auto-increment counters are omitted from schema comparison. Migration timestamps
are ordinary data; checksum/version records must match before synchronization.

Migration comparisons recognize proven LF/CRLF variants of the same SQL file.
The migration runner uses the same canonical LF fingerprint and accepts legacy
line-ending hashes, so future checks also work after migration-history rows have
been synchronized. Existing checksum records are not rewritten just to preview.
Actual SQL changes and table-definition differences remain blocking errors.
Install migration 011 on legacy databases missing the lore tables or using the
older video-column order; this is a separate migration, not a sync-side schema
repair or a replay of existing migrations.

## Configure peers

Set `FRACTO_DATABASE_SYNC_PEERS` on **both** servers. It is a JSON object keyed by
the public server URL saved in Server Awareness. Each entry provides the remote
admin endpoint and a pair-specific shared secret of at least 32 characters.
Secrets stay server-side; do not put them in Vite settings or URLs.

This setting is **not a boolean enable flag**. `FRACTO_DATABASE_SYNC_PEERS=true`
does not supply a remote endpoint or credentials and is invalid. A peer URL must
match the selected address-book URL, including its scheme and port.

Example on server A (replace the token before use):

```json
{
  "https://server-b.example": {
    "endpoint": "https://server-b.example/api/admin",
    "token": "<a-random-shared-secret-at-least-32-characters>"
  }
}
```

Server B configures server A's URL/admin endpoint with the same pair-specific
secret. For a private lab without nginx, an endpoint can be
`http://server-b:3105`. Use HTTPS outside the trusted private network. Both Compose
configurations forward this setting. Recreate the app container after changing
its environment. An address-book entry grants no database access. Endpoints come
only from server configuration; redirects are rejected. The application service
token and browser cookies are never forwarded to the peer.

In a Compose `.env` file, use single quotes around the one-line JSON value:

```dotenv
FRACTO_DATABASE_SYNC_PEERS='{"https://server-b.example":{"endpoint":"https://server-b.example/api/admin","token":"<the-same-random-pair-secret-on-both-sides>"}}'
```

On B, the map key and endpoint point back to A. The secret is identical for
the pair; it is not a URL or a boolean. Recreate the appropriate Compose service
to apply environment changes. `docker compose restart` alone keeps the old
container environment. Then reload Server Awareness or reselect the peer.

The configured application database account needs SELECT, INSERT, DELETE,
LOCK TABLES, and CREATE TEMPORARY TABLES privileges on the included tables.

## Operation and consistency

Preview/apply use asynchronous administrator-only `/database-sync/jobs` routes.
Peer exchange at `/database-sync/peer` requires its separate secret before body
parsing. The read-only lab bypass does not authorize sync. Browser mutations
retain normal administrator and Origin checks.

For an isolated lab that deliberately uses `FRACTO_AUTH_MODE=none`, opt in with
`FRACTO_ADMIN_SYNC_LAB_BYPASS=true` and set `FRACTO_UI_ORIGIN` to the exact browser
origin (scheme, host, port). This separate setting permits only database/mesh
sync peer lists, job status, preview and apply routes. It requires a matching
Origin header, or for same-origin GET requests a matching Referer. It never
grants access to user management or other admin mutations, never replaces peer
secrets, and is ignored when authentication mode is not `none` or authentication
is required. Its default is false. The read-only bypass remains read-only.

Preview is read-only for application tables. It briefly takes exclusive table
locks to produce stable snapshots. Apply reacquires locks and rejects changed
snapshots: new data requires another preview. Pause job runs on both servers
before preview/apply. Other database connections may wait while these locks are
held. Locks remain through prepare, commit, and final hash verification. New
work after release may naturally cause the databases to diverge again.

Merging uses native temporary MySQL tables/indexes with the real unique-key
collations. Prepared unions are checked for complete foreign-key references
before application data changes. Foreign-key insertion-order checks are disabled
only for the dedicated transactional copy connection, then restored. Decimal
strings, big integers, timestamp precision, JSON text and binary checkpoints are
preserved. Included data is replaced transactionally by the verified union;
table definitions are unchanged and TRUNCATE is never used.

Choosing one side of a unique-key conflict with different primary IDs can remove
an ID referenced by other merged rows. Unresolved references block the operation;
fix those conflicting keys before retrying. Sync does not infer ID remappings or
rewrite opaque JSON/blob references.

Both databases prepare before either commits. This is **not a distributed atomic
transaction**: failure between commits can leave one side committed. Such jobs
report `partial`, never `completed`. Run a fresh preview and retry to reconcile;
the merge is repeatable. Uncommitted work rolls back. Peer sessions expire after
five idle minutes, releasing abandoned locks; process/connection failure also
releases locks. Completed status requires matching hashes of every included row
on both sides while locks remain held.

Previews live in server memory, expire after 30 minutes, and only the three newest
are retained. The browser remembers a job ID per peer in session storage and
reattaches when revisiting that server. Service restart requires a fresh preview;
it never silently starts or completes a sync.

Bounded transfers support up to 250,000 included rows and 480 MiB of
encoded snapshot data **per server and resulting union**, and 8 MiB per row.
The full conflict count is reported with up to 200 examples; the selected server
preference applies to every conflict. Protocol 4 uses newline-aware migration
fingerprints, exact binary floating-point reads/inserts, incremental row hashing,
and a 512 MiB
wire limit, supporting existing large `free_bailiwicks.ray_paths` payloads
without constructing another escaped database-sized string for verification.
Both servers need this protocol version; incompatible code is rejected before
data changes. No SQL migration is required for this protocol update.
MySQL's text-to-double and JSON parsers can change the last bits of a number.
JSON transfers first check the native parser, then repair only numeric paths
that changed using binary doubles or exact decimal casts. Large integer literals
are retained as text. Each repaired document must serialize identically before
insertion, and the complete prepared snapshot must still match before commit.
Unrepresentable JSON precision stops explicitly; verification is never relaxed.
Exceeding a bound stops explicitly rather than omitting data. Tables require
primary keys and InnoDB. Views, triggers, functional unique indexes and foreign
keys crossing the excluded-table boundary are rejected.

## Verification

From the root in the development container:

```sh
node --test servers/fracto-admin-server/test/database_sync.test.js
FRACTO_TEST_MYSQL_SYNC=1 node --test servers/fracto-admin-server/test/database_sync.integration.test.js
```

The opt-in integration test creates two uniquely named disposable schemas and
uses real peer HTTP requests. It tests conflict preference, identical merged
data, unchanged exclusions, foreign keys, exact values, migration mismatches,
changed previews, and a lost commit response followed by successful recovery.
It drops only its own schemas; application data is not synchronized by the test.
