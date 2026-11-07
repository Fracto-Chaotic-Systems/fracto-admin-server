import express from "express";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import {
  DatabaseSyncSession,
  EXCLUDED_TABLES,
  MAX_BYTES,
  sync_error,
  snapshot_digest,
  assert_compatible,
} from "./database_sync_store.js";

export const normalize_peer = (value) => {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw sync_error("invalid_sync_peer", 400);
  return url.href.replace(/\/+$/, "");
};
export function configured_peers(env = process.env) {
  const peers = new Map();
  for (const [url, entry] of Object.entries(
    JSON.parse(env.FRACTO_DATABASE_SYNC_PEERS || "{}"),
  )) {
    if (typeof entry.token !== "string" || entry.token.length < 32)
      throw sync_error("invalid_sync_peer_configuration", 503);
    peers.set(normalize_peer(url), {
      endpoint: normalize_peer(entry.endpoint),
      token: entry.token,
    });
  }
  return peers;
}
const token_digest = (value) => createHash("sha256").update(value).digest();
const public_error = (error) =>
  error.status ? error.code : "database_sync_failed";
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    res.status(error.status || 500).json({ error: public_error(error) });
  }
};

/** Dedicated peer secrets, never browser cookies or the app's internal token. */
export function create_sync_peer_router({
  open_session = () => DatabaseSyncSession.open(),
  peers = () => configured_peers(),
  ttl_ms = 300000,
} = {}) {
  const router = express.Router(),
    sessions = new Map();
  router.use((req, res, next) => {
    try {
      const supplied = req.get("x-fracto-sync-token") || "";
      const owner = [...peers().values()].find((p) =>
        timingSafeEqual(token_digest(p.token), token_digest(supplied)),
      );
      if (!owner)
        return res.status(403).json({ error: "sync_peer_unauthorized" });
      req.sync_owner = token_digest(owner.token).toString("hex");
      next();
    } catch {
      res.status(503).json({ error: "invalid_sync_peer_configuration" });
    }
  });
  router.use(express.json({ limit: MAX_BYTES }));
  const drop = async (id) => {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    clearTimeout(entry.timer);
    await entry.session.close();
  };
  const touch = (id, entry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.busy) return touch(id, entry);
      drop(id).catch(() => {});
    }, ttl_ms);
    entry.timer.unref?.();
  };
  router.post(
    "/sessions",
    safe(async (req, res) => {
      if (sessions.size) throw sync_error("database_sync_busy");
      const id = randomUUID(),
        entry = { owner: req.sync_owner, busy: true };
      sessions.set(id, entry);
      try {
        entry.session = await open_session();
        entry.busy = false;
        touch(id, entry);
        res.json({ id, snapshot: entry.session.snapshot });
      } catch (error) {
        sessions.delete(id);
        throw error;
      }
    }),
  );
  router.post(
    "/sessions/:id/:action",
    safe(async (req, res) => {
      const { id, action } = req.params,
        entry = sessions.get(id);
      if (!entry || entry.owner !== req.sync_owner)
        throw sync_error("sync_session_not_found", 404);
      if (entry.busy) throw sync_error("sync_session_busy");
      entry.busy = true;
      try {
        if (action === "close") {
          await drop(id);
          return res.json({ closed: true });
        }
        if (action === "prepare") {
          if (entry.session.prepared) throw sync_error("sync_already_prepared");
          if (snapshot_digest(entry.session.snapshot) !== req.body.expected)
            throw sync_error("sync_snapshot_changed");
          await entry.session.prepare(req.body.snapshot);
          res.json({ prepared: true });
        } else if (action === "commit")
          res.json({ digest: await entry.session.commit() });
        else if (action === "verify")
          res.json({
            digest: snapshot_digest(await entry.session.read_snapshot()),
          });
        else throw sync_error("invalid_sync_action", 400);
      } finally {
        entry.busy = false;
        if (sessions.has(id)) touch(id, entry);
      }
    }),
  );
  return router;
}

export async function peer_request(peer, path, body = {}, fetcher = fetch) {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > MAX_BYTES)
    throw sync_error("sync_snapshot_limit", 413);
  const response = await fetcher(`${peer.endpoint}/database-sync/peer${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fracto-sync-token": peer.token,
    },
    body: payload,
    redirect: "error",
    signal: AbortSignal.timeout(240000),
  });
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      await response.body.cancel?.().catch(() => {});
      throw sync_error("sync_snapshot_limit", 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok)
    throw sync_error(data.error || "sync_peer_failed", response.status);
  return data;
}

export class DatabaseSyncJobs {
  constructor({
    open_session = () => DatabaseSyncSession.open(),
    peers = () => configured_peers(),
    remote = peer_request,
  } = {}) {
    Object.assign(this, { open_session, peers, remote });
    this.jobs = new Map();
  }
  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw sync_error("sync_job_not_found", 404);
    const { peer, local_snapshot, remote_snapshot, completion, ...view } = job;
    return view;
  }
  create(url) {
    const normalized = normalize_peer(url),
      peer = this.peers().get(normalized);
    if (!peer) throw sync_error("sync_peer_not_configured", 400);
    for (const [id, job] of this.jobs)
      if (
        Date.now() - job.created_at > 1800000 &&
        !["checking", "applying"].includes(job.status)
      )
        this.jobs.delete(id);
    if (
      [...this.jobs.values()].some((j) =>
        ["checking", "applying"].includes(j.status),
      )
    )
      throw sync_error("database_sync_busy");
    // Bound retained snapshots; an evicted preview must be requested again.
    while (this.jobs.size >= 3) this.jobs.delete(this.jobs.keys().next().value);
    const job = {
      id: randomUUID(),
      server_url: normalized,
      peer,
      status: "checking",
      phase: "Comparing migrations and tables",
      created_at: Date.now(),
      excluded: EXCLUDED_TABLES,
    };
    this.jobs.set(job.id, job);
    job.completion = this.preview(job).catch((error) => {
      job.status = "failed";
      job.error = public_error(error);
    });
    return this.get(job.id);
  }
  async preview(job) {
    let local, remote;
    try {
      local = await this.open_session();
      remote = await this.remote(job.peer, "/sessions");
      assert_compatible(local.manifest, remote.snapshot.manifest);
      job.phase = "Comparing rows and unique keys";
      const merged = await local.merge(remote.snapshot);
      job.local_snapshot = local.snapshot;
      job.remote_snapshot = remote.snapshot;
      job.conflicts = merged.conflicts;
      job.tables = local.manifest.tables.map((t) => ({
        name: t.name,
        local_rows: local.snapshot.tables[t.name].length,
        remote_rows: remote.snapshot.tables[t.name].length,
        merged_rows: merged.snapshot.tables[t.name].length,
      }));
    } finally {
      await local?.close();
      if (remote)
        await this.remote(job.peer, `/sessions/${remote.id}/close`).catch(
          () => {},
        );
    }
    job.status = "ready";
    job.phase = "Ready to synchronize";
  }
  apply(id, preferred) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "ready") throw sync_error("sync_plan_not_ready");
    if (Date.now() - job.created_at > 1800000)
      throw sync_error("sync_plan_expired");
    if (!["local", "remote"].includes(preferred) && job.conflicts.length)
      throw sync_error("choose_conflict_server", 400);
    if (preferred != null && !["local", "remote"].includes(preferred))
      throw sync_error("invalid_conflict_server", 400);
    if (
      [...this.jobs.values()].some((j) =>
        ["checking", "applying"].includes(j.status),
      )
    )
      throw sync_error("database_sync_busy");
    job.status = "applying";
    job.phase = "Locking tables and rechecking the preview";
    job.completion = this.synchronize(job, preferred || "local").catch(
      (error) => {
        job.status = job.remote_committed ? "partial" : "failed";
        job.error = public_error(error);
        if (job.remote_committed)
          job.phase = "One server committed; inspect and retry synchronization";
      },
    );
    return this.get(id);
  }
  async synchronize(job, preferred) {
    let local, remote;
    try {
      local = await this.open_session();
      remote = await this.remote(job.peer, "/sessions");
      assert_compatible(local.manifest, remote.snapshot.manifest);
      if (
        snapshot_digest(local.snapshot) !==
          snapshot_digest(job.local_snapshot) ||
        snapshot_digest(remote.snapshot) !==
          snapshot_digest(job.remote_snapshot)
      )
        throw sync_error("sync_snapshot_changed");
      job.phase = "Merging rows and validating unique keys and references";
      const merged = await local.merge(remote.snapshot, preferred);
      await local.prepare(merged.snapshot);
      await this.remote(job.peer, `/sessions/${remote.id}/prepare`, {
        expected: snapshot_digest(remote.snapshot),
        snapshot: merged.snapshot,
      });
      job.phase = "Committing both servers";
      // A failed response may mean the remote COMMIT succeeded: report partial conservatively.
      job.remote_committed = true;
      const committed = await this.remote(
        job.peer,
        `/sessions/${remote.id}/commit`,
      );
      const local_digest = await local.commit();
      job.phase = "Verifying matching data while table locks remain held";
      const verified = await this.remote(
        job.peer,
        `/sessions/${remote.id}/verify`,
      );
      const expected = snapshot_digest(merged.snapshot);
      if (
        local_digest !== expected ||
        committed.digest !== expected ||
        verified.digest !== expected
      )
        throw sync_error("sync_verification_failed");
      job.digest = expected;
      job.status = "completed";
      job.phase = "Both servers have matching data";
      job.finished_at = Date.now();
      delete job.local_snapshot;
      delete job.remote_snapshot;
    } finally {
      await local?.close();
      if (remote)
        await this.remote(job.peer, `/sessions/${remote.id}/close`).catch(
          () => {},
        );
    }
  }
}

export function create_database_sync_router({
  jobs = new DatabaseSyncJobs(),
} = {}) {
  const router = express.Router();
  router.get(
    "/peers",
    safe(async (_req, res) => res.json({ peers: [...jobs.peers().keys()] })),
  );
  router.post(
    "/jobs",
    safe(async (req, res) => {
      if (
        !req.body ||
        Object.keys(req.body).join() !== "server_url" ||
        typeof req.body.server_url !== "string"
      )
        throw sync_error("invalid_sync_request", 400);
      res.status(202).json(jobs.create(req.body.server_url));
    }),
  );
  router.get(
    "/jobs/:id",
    safe(async (req, res) => res.json(jobs.get(req.params.id))),
  );
  router.post(
    "/jobs/:id/apply",
    safe(async (req, res) => {
      if (!req.body || Object.keys(req.body).some((k) => k !== "preferred"))
        throw sync_error("invalid_sync_request", 400);
      res.status(202).json(jobs.apply(req.params.id, req.body.preferred));
    }),
  );
  return router;
}
