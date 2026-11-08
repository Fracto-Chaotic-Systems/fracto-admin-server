import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import { once } from "node:events";
import {
  DatabaseSyncJobs,
  create_sync_peer_router,
  peer_request,
} from "../handlers/database_sync.js";
import {
  DatabaseSyncSession,
  open_sync_database,
  snapshot_digest,
  assert_compatible,
} from "../handlers/database_sync_store.js";

test(
  "real MySQL merge preserves exact values, resolves conflicts, validates keys, and excludes local-only tables",
  { skip: process.env.FRACTO_TEST_MYSQL_SYNC !== "1" },
  async () => {
    const prefix = `fracto_sync_verify_${randomBytes(5).toString("hex")}`;
    const names = [`${prefix}_a`, `${prefix}_b`];
    const admin = await open_sync_database();
    let a, b, server;
    const open = (name) => async () => {
      const db = await open_sync_database();
      await db.changeUser({ database: name });
      return db;
    };
    try {
      for (const name of names) {
        assert.match(name, /^fracto_sync_verify_[a-f0-9]{10}_[ab]$/);
        await admin.query(`CREATE DATABASE \`${name}\``);
        await admin.changeUser({ database: name });
        await admin.query(
          "CREATE TABLE fracto_schema_migrations (version VARCHAR(255) PRIMARY KEY,checksum CHAR(64),applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB",
        );
        await admin.query(
          "INSERT INTO fracto_schema_migrations VALUES ('001_baseline.sql',REPEAT('a',64),'2026-01-01 00:00:00')",
        );
        await admin.query(
          "CREATE TABLE parents (id BIGINT UNSIGNED PRIMARY KEY, label VARCHAR(50) NOT NULL UNIQUE, value DECIMAL(65,30), binary_data BLOB, settings JSON, updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)) ENGINE=InnoDB",
        );
        await admin.query(
          "CREATE TABLE children (id INT PRIMARY KEY,parent_id BIGINT UNSIGNED,CONSTRAINT fk_parent FOREIGN KEY(parent_id) REFERENCES parents(id)) ENGINE=InnoDB",
        );
        await admin.query(
          "CREATE TABLE tiles (id INT PRIMARY KEY,value TEXT) ENGINE=InnoDB",
        );
        await admin.query(
          "CREATE TABLE automation (id INT PRIMARY KEY,value TEXT) ENGINE=InnoDB",
        );
        await admin.query(
          "INSERT INTO parents VALUES (9007199254740993,'shared',0.123456789012345678901234567890,X'0001ff','{\"n\":9007199254740993}','2026-01-01 00:00:00.123')",
        );
        await admin.query(
          "INSERT INTO parents (id,label) VALUES (2,'conflict')",
        );
        await admin.query("INSERT INTO tiles VALUES (1,?)", [name]);
        await admin.query("INSERT INTO automation VALUES (1,?)", [name]);
      }
      await admin.query(
        "UPDATE parents SET label='remote-conflict' WHERE id=2",
      );
      await admin.query(
        "INSERT INTO parents (id,label) VALUES (4,'remote-only')",
      );
      await admin.query("INSERT INTO children VALUES (4,4)");
      await admin.changeUser({ database: names[0] });
      await admin.query(
        "INSERT INTO parents (id,label) VALUES (3,'local-only')",
      );
      await admin.query("INSERT INTO children VALUES (3,3)");
      a = await DatabaseSyncSession.open(open(names[0]));
      b = await DatabaseSyncSession.open(open(names[1]));
      assert_compatible(a.manifest, b.manifest);
      assert.ok(!a.snapshot.tables.tiles && !a.snapshot.tables.automation);
      const merged = await a.merge(b.snapshot, "remote");
      assert.ok(
        merged.conflicts.some(
          (c) => c.table === "parents" && c.local_key === '["2"]',
        ),
      );
      assert.equal(merged.snapshot.tables.parents.length, 4);
      await a.prepare(merged.snapshot);
      await b.prepare(merged.snapshot);
      const expected = snapshot_digest(merged.snapshot);
      assert.equal(await b.commit(), expected);
      assert.equal(await a.commit(), expected);
      assert.equal(snapshot_digest(await b.read_snapshot()), expected);
      // A separate connection cannot write after COMMIT until table locks are released.
      const blocked = await open(names[0])();
      await blocked.query("SET SESSION lock_wait_timeout=1");
      await assert.rejects(
        blocked.query("INSERT INTO children VALUES (8,3)"),
        (e) => e.code === "ER_LOCK_WAIT_TIMEOUT",
      );
      await blocked.end();
      await a.close();
      a = null;
      await b.close();
      b = null;
      for (const name of names) {
        await admin.changeUser({ database: name });
        const [[row]] = await admin.query(
          "SELECT * FROM parents WHERE id=9007199254740993",
        );
        assert.equal(row.id, "9007199254740993");
        assert.equal(row.binary_data.toString("hex"), "0001ff");
        assert.ok(row.settings.includes("9007199254740993"));
        assert.equal(row.value, "0.123456789012345678901234567890");
        const [[tile]] = await admin.query("SELECT value FROM tiles");
        const [[automation]] = await admin.query(
          "SELECT value FROM automation",
        );
        assert.equal(tile.value, name);
        assert.equal(automation.value, name);
      }
      a = await DatabaseSyncSession.open(open(names[0]));
      const invalid = structuredClone(a.snapshot);
      invalid.tables.children.push([99, "999"]);
      await assert.rejects(a.prepare(invalid), /foreign_key_conflict/);
      await a.close();
      a = null;
      await admin.changeUser({ database: names[1] });
      await admin.query(
        "UPDATE fracto_schema_migrations SET checksum=REPEAT('b',64)",
      );
      a = await DatabaseSyncSession.open(open(names[0]));
      b = await DatabaseSyncSession.open(open(names[1]));
      assert.throws(
        () => assert_compatible(a.manifest, b.manifest),
        /migration_version_mismatch/,
      );
      await a.close();
      a = null;
      await b.close();
      b = null;

      // Exercise the real HTTP peer protocol and asynchronous coordinator.
      const token = "disposable-sync-test-secret-32-characters";
      const app = express();
      app.use(
        "/database-sync/peer",
        create_sync_peer_router({
          open_session: () => DatabaseSyncSession.open(open(names[1])),
          peers: () => new Map([["local", { token }]]),
        }),
      );
      server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      const denied = await fetch(`${endpoint}/database-sync/peer/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "invalid json",
      });
      assert.equal(denied.status, 403, "authorize before parsing peer data");
      const jobs = new DatabaseSyncJobs({
        open_session: () => DatabaseSyncSession.open(open(names[0])),
        peers: () => new Map([["http://remote.example", { endpoint, token }]]),
      });
      let job = jobs.create("http://remote.example/");
      await jobs.jobs.get(job.id).completion;
      assert.equal(jobs.get(job.id).error, "migration_version_mismatch");
      await admin.query(
        "UPDATE fracto_schema_migrations SET checksum=REPEAT('a',64)",
      );
      await admin.query(
        "INSERT INTO parents (id,label) VALUES (5,'http-remote-only')",
      );
      await admin.query("UPDATE parents SET label='choose-remote' WHERE id=2");
      job = jobs.create("http://remote.example");
      await jobs.jobs.get(job.id).completion;
      assert.equal(jobs.get(job.id).status, "ready");
      assert.ok(jobs.get(job.id).conflicts.length);
      assert.ok(!JSON.stringify(jobs.get(job.id)).includes(token));
      assert.equal(jobs.get(job.id).local_snapshot, undefined);
      assert.throws(() => jobs.apply(job.id), /choose_conflict_server/);
      jobs.apply(job.id, "remote");
      await jobs.jobs.get(job.id).completion;
      assert.equal(
        jobs.get(job.id).status,
        "completed",
        JSON.stringify(jobs.get(job.id)),
      );
      a = await DatabaseSyncSession.open(open(names[0]));
      b = await DatabaseSyncSession.open(open(names[1]));
      assert.equal(snapshot_digest(a.snapshot), snapshot_digest(b.snapshot));
      const ids = Array.from({ length: 2050 }, (_, i) => i + 1000);
      for (const [session, prefix] of [
        [a, "left"],
        [b, "right"],
      ]) {
        await session.db.query(
          "INSERT INTO parents (id,label) VALUES " +
            ids.map(() => "(?,?)").join(","),
          ids.flatMap((id) => [id, `${prefix}-${id}`]),
        );
        session.snapshot = await session.read_snapshot();
      }
      const many = await a.merge(b.snapshot);
      assert.equal(many.conflict_count, 2050);
      assert.equal(many.conflicts.length, 200);
      assert.ok(
        a.snapshot.tables.parents.some((r) => r[1] === "http-remote-only"),
      );
      assert.ok(
        a.snapshot.tables.parents.some((r) => r[1] === "choose-remote"),
      );
      await a.close();
      a = null;
      await b.close();
      b = null;

      job = jobs.create("http://remote.example");
      await jobs.jobs.get(job.id).completion;
      await admin.query(
        "INSERT INTO parents (id,label) VALUES (6,'changed-after-preview')",
      );
      jobs.apply(job.id);
      await jobs.jobs.get(job.id).completion;
      assert.equal(jobs.get(job.id).error, "sync_snapshot_changed");
      // A lost COMMIT response reports partial; retry reconciles both sides.
      await admin.changeUser({ database: names[0] });
      await admin.query(
        "INSERT INTO parents (id,label) VALUES (7,'http-local-only')",
      );
      const interrupted = new DatabaseSyncJobs({
        open_session: () => DatabaseSyncSession.open(open(names[0])),
        peers: jobs.peers,
        remote: async (...args) => {
          const result = await peer_request(...args);
          if (args[1].endsWith("/commit"))
            throw Error("injected_lost_commit_response");
          return result;
        },
      });
      job = interrupted.create("http://remote.example");
      await interrupted.jobs.get(job.id).completion;
      interrupted.apply(job.id);
      await interrupted.jobs.get(job.id).completion;
      assert.equal(interrupted.get(job.id).status, "partial");
      a = await DatabaseSyncSession.open(open(names[0]));
      b = await DatabaseSyncSession.open(open(names[1]));
      assert.ok(
        !a.snapshot.tables.parents.some(
          (r) => r[1] === "changed-after-preview",
        ),
      );
      assert.ok(
        b.snapshot.tables.parents.some((r) => r[1] === "http-local-only"),
      );
      await a.close();
      a = null;
      await b.close();
      b = null;
      job = jobs.create("http://remote.example");
      await jobs.jobs.get(job.id).completion;
      jobs.apply(job.id);
      await jobs.jobs.get(job.id).completion;
      assert.equal(jobs.get(job.id).status, "completed");
      a = await DatabaseSyncSession.open(open(names[0]));
      b = await DatabaseSyncSession.open(open(names[1]));
      assert.equal(snapshot_digest(a.snapshot), snapshot_digest(b.snapshot));
    } finally {
      await a?.close();
      await b?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      for (const name of names) {
        assert.match(name, /^fracto_sync_verify_[a-f0-9]{10}_[ab]$/);
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      }
      await admin.end();
    }
  },
);
