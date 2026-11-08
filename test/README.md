# Admin service tests

Run focused suites with `node --test test/<file>.test.js`.
Database sync tests cover authorization, migration and schema compatibility,
snapshot limits, and numeric precision. Set `FRACTO_TEST_MYSQL_SYNC=1` for the
integration suite, which creates and removes uniquely named disposable schemas
and exercises real peer HTTP synchronization. Application rows are not changed.
