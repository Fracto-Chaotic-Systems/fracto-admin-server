import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import {
  configured_peers,
  normalize_peer,
  DatabaseSyncJobs,
  create_sync_peer_router,
  create_database_sync_router,
} from "../handlers/database_sync.js";
import { require_administrator, is_lab_readonly_admin_bypass } from "../../../utils/admin_authorization.js";
import {
  assert_compatible,
  snapshot_digest,
} from "../handlers/database_sync_store.js";

test("trusted peers are explicit, normalized, secret-separated and reject URL credentials", () => {
  assert.equal(configured_peers({}).size, 0);
  assert.equal(normalize_peer("https://peer.example/"), "https://peer.example");
  for (const url of [
    "file:///etc/passwd",
    "https://user:password@peer.example",
    "https://peer.example/?token=secret",
  ])
    assert.throws(() => normalize_peer(url));
  assert.throws(() =>
    configured_peers({
      FRACTO_DATABASE_SYNC_PEERS: JSON.stringify({
        "http://peer": { endpoint: "http://admin", token: "short" },
      }),
    }),
  );
  const jobs = new DatabaseSyncJobs({ peers: () => new Map() });
  assert.throws(
    () => jobs.create("http://unconfigured"),
    /sync_peer_not_configured/,
  );
});

test("browser sync requires an enabled administrator and the trusted Origin; read-only bypass cannot authorize it", async () => {
  const original_fetch = globalThis.fetch;
  const origin = process.env.FRACTO_UI_ORIGIN || `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`;
  let mutations = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/auth/session")) {
      const cookie = options.headers.cookie;
      return { ok: true, json: async () => ({ authenticated: !!cookie, auth_state: "authenticated", user: { enabled: true, role: cookie === "admin" ? "admin" : "user" } }) };
    }
    return original_fetch(url, options);
  };
  const app = express();
  app.use(require_administrator, express.json());
  app.use("/database-sync", create_database_sync_router({ jobs: { create: () => { mutations++; return { id: "plan", status: "checking" }; } } }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/database-sync/jobs`;
  const send = (cookie, trusted = true) => original_fetch(url, { method: "POST", headers: { cookie, origin: trusted ? origin : "https://untrusted.example", "content-type": "application/json" }, body: JSON.stringify({ server_url: "http://peer" }) });
  try {
    assert.equal((await send("")).status, 401);
    assert.equal((await send("enabled-user")).status, 403);
    assert.equal((await send("admin", false)).status, 403);
    assert.equal(mutations, 0);
    assert.equal((await send("admin")).status, 202);
    assert.equal(mutations, 1);
    assert.equal(is_lab_readonly_admin_bypass({ method: "GET", path: "/database-sync/peers" }, { FRACTO_ADMIN_READONLY_BYPASS: "true", FRACTO_AUTH_MODE: "none" }), false);
  } finally { globalThis.fetch = original_fetch; await new Promise((resolve) => server.close(resolve)); }
});

test("schema and migration guards distinguish incompatible installations; data hashing is order independent", () => {
  const manifest = {
    migrations: [{ version: "001", checksum: "a" }],
    tables: [{ name: "a", ddl: "original" }],
  };
  assert.throws(
    () => assert_compatible(manifest, { ...manifest, migrations: [] }),
    /migration_version_mismatch/,
  );
  assert.throws(
    () => assert_compatible(manifest, { ...manifest, tables: [] }),
    /table_definitions_mismatch/,
  );
  assert.equal(
    snapshot_digest({
      manifest,
      tables: {
        a: [
          [1, "x"],
          [2, "y"],
        ],
      },
    }),
    snapshot_digest({
      manifest,
      tables: {
        a: [
          [2, "y"],
          [1, "x"],
        ],
      },
    }),
  );
});

test("abandoned peer sessions expire and release their dedicated database connection", async () => {
  let closed = 0,
    opened = 0;
  const token = "dedicated-pair-secret-32-characters";
  const app = express();
  app.use(
    create_sync_peer_router({
      peers: () => new Map([["local", { token }]]),
      ttl_ms: 25,
      open_session: async () => {
        opened++;
        return {
          snapshot: {},
          close: async () => {
            closed++;
          },
        };
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (path, secret = token) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        "x-fracto-sync-token": secret,
        "content-type": "application/json",
      },
      body: "{}",
    });
  try {
    assert.equal((await send("/sessions", "app-internal-token")).status, 403);
    assert.equal(opened, 0);
    const first = await (await send("/sessions")).json();
    assert.equal((await send("/sessions")).status, 409);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(closed, 1);
    assert.equal((await send(`/sessions/${first.id}/verify`)).status, 404);
    const second = await (await send("/sessions")).json();
    assert.equal((await send(`/sessions/${second.id}/close`)).status, 200);
    assert.equal(closed, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
