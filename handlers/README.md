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

Shared repository paths are owned by `../repositories.js`. Keep request and
response validation within each handler and follow the root personal-information
policy for every API, including errors and logs.
