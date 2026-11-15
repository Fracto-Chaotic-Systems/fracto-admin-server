# Admin handlers

Route implementations mounted by the Admin service's root `index.js`.

- `ports.js`: versioned runtime port discovery, including the AI service;
  environment settings override installation-local runtime files and defaults.
- `commits.js`: repository history and packaged build snapshot reporting.
- `reference.js`: allowlisted tracked Markdown discovery and reading.
- `logs.js`: legacy service log handler.
- `social.js` and `social_sync_service.js`: social catalog endpoints and synchronization.
- `status.js`: basic service welcome/health response.
- `tile.js`: inactive tile placeholder.
- `users.js`: administrative account operations.
- `versions.js`: legacy repository version/status reporting.
- `database_sync.js` and `database_sync_store.js`: trusted peer sessions, merge
  planning, transactional preparation, and exact equality verification.
- `database_sync_values.js`: lossless JSON numeric-path scanning and checked
  binary-double/decimal expressions for JSON numbers that MySQL rounds on parse.
- `mesh_sync_session.js`: asynchronous inventory acquisition and progress polling,
  failed-acquisition cleanup, and compatibility with legacy peer endpoints.
- `instrument_transfer.js`, `instrument_transfer_jobs.js` and
  `instrument_transfer_client.js`: authorized peer/browser inventory/transfer routes,
  asynchronous planning, bounded JSON requests and cancellation cleanup.
- `instrument_transfer_binary.js` streams file bodies between authenticated hops;
  `instrument_transfer_send.js` reserves both ends and runs the bounded worker pool.
  `instrument_transfer_publish.js` validates the durable receiver receipt, including
  after a lost finalize acknowledgement. Apply completes only after live-library
  publication when both backends support it; staging-only older peers retain their
  explicit staged result. See `../INSTRUMENT_TRANSFER.md`.

Instrument jobs negotiate source-authoritative replacement with the receiver,
bind that policy into the preview plan, and include differing files in transfer
totals. Older/unnegotiated peers retain the preserve/block behavior.

Shared repository paths are owned by `../repositories.js`. Keep request and
response validation within each handler and follow the root personal-information
policy for every API, including errors and logs.
