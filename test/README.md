# Admin service tests

Run focused suites with `node --test test/<file>.test.js`.
Database sync tests cover authorization, migration and schema compatibility,
snapshot limits, numeric precision, and exclusion of local tile-seed tables and
checkpoint state. Set `FRACTO_TEST_MYSQL_SYNC=1` for the
integration suite, which creates and removes uniquely named disposable schemas
and exercises real peer HTTP synchronization. Application rows are not changed.

`instrument_transfer.test.js` uses temporary instrument stores and loopback HTTP
admin/asset services on both ends. It checks preview in both directions, missing
assets, authorization before parsing, conflicts, old peers, bounded responses,
cancellation, staged transfer in both directions, concurrent multi-megabyte bodies,
lost acknowledgements, network disconnects and incremental retry. No production
assets are changed. Full publication tests additionally check live catalog/audio
availability, completion receipts and a lost finalize acknowledgement.

## Instrument release verification

`instrument_transfer.test.js` also verifies full publication with sender and
receiver roles reversed, durable receipt lookup after restart and a zero-byte
identical-library apply. The root full-data probe and deployment evidence are
documented in `../../../deploy/INSTRUMENT_TRANSFER_VERIFICATION.md`.
