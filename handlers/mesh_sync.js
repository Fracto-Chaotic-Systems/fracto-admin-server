import express from "express";
import { randomUUID, createHash } from "node:crypto";
import {
  configured_peers,
  normalize_peer,
  require_sync_peer,
} from "./database_sync.js";
import { internal_service_headers } from "../../../utils/service_authorization.js";

const LIMIT = 24 * 1024 * 1024;
const CATALOG_LIMIT = 64 * 1024 * 1024;
const fail = (code, status = 409) =>
  Object.assign(new Error(code), { code, status });
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error_code = (e) => (e.status ? e.code : "mesh_sync_failed");
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 503).json({ error: error_code(e) });
  }
};

async function request(url, body, headers) {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > LIMIT)
    throw fail("mesh_transfer_limit", 413);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
    redirect: "error",
    signal: AbortSignal.timeout(240000),
  });
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > CATALOG_LIMIT) throw fail("mesh_transfer_limit", 413);
    chunks.push(Buffer.from(chunk));
  }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok)
    throw fail(result.error || "mesh_sync_failed", response.status);
  return result;
}
export const local_mesh_request = (path, body = {}) => {
  if (!process.env.FRACTO_INTERNAL_SERVICE_TOKEN)
    throw fail("mesh_internal_token_missing", 503);
  return request(
    `http://127.0.0.1:${Number(process.env.FRACTO_TILES_PORT || 3004)}/internal/mesh-sync${path}`,
    body,
    internal_service_headers(),
  );
};
export const peer_mesh_request = (peer, path, body = {}) =>
  request(`${peer.endpoint}/mesh-sync/peer${path}`, body, {
    "x-fracto-sync-token": peer.token,
  });

export function create_mesh_peer_router({
  local = local_mesh_request,
  peers = () => configured_peers(),
} = {}) {
  const router = express.Router(),
    sessions = new Map();
  router.use(require_sync_peer(peers), express.json({ limit: LIMIT }));
  router.post(
    "/sessions",
    safe(async (req, res) => {
      const opened = await local("/sessions");
      // The tiles service owns lease expiry. Only a successful new reservation
      // proves any previous mapping is obsolete; a busy attempt must preserve it.
      sessions.clear();
      const id = randomUUID();
      sessions.set(id, {
        local_id: opened.id,
        owner: req.sync_owner,
      });
      res.json({ id, catalog: opened.catalog });
    }),
  );
  router.post(
    "/sessions/:id/:action{/:code}",
    safe(async (req, res) => {
      const { id, action, code } = req.params;
      const entry = sessions.get(id);
      if (!entry || entry.owner !== req.sync_owner)
        throw fail("mesh_session_expired", 404);
      if (
        !["close", "catalog", "read", "write"].includes(action) ||
        (["read", "write"].includes(action)
          ? !/^[0-3]{2,34}$/.test(code || "")
          : code !== undefined)
      )
        throw fail("invalid_mesh_request", 400);
      try {
        res.json(
          await local(
            `/sessions/${entry.local_id}/${action}${code ? `/${code}` : ""}`,
            req.body,
          ),
        );
      } finally {
        if (action === "close") sessions.delete(id);
      }
    }),
  );
  return router;
}

function validate_catalog(catalog) {
  if (
    catalog?.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(catalog.namespace || "") ||
    !Array.isArray(catalog.records) ||
    catalog.records.length > 500000
  )
    throw fail("mesh_catalog_incompatible");
  const seen = new Set();
  for (const record of catalog.records) {
    if (
      !/^[0-3]{2,34}$/.test(record.short_code || "") ||
      seen.has(record.short_code) ||
      !["ready", "invalid", "stale"].includes(record.status) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0 ||
      (record.sha256 !== null && !/^[a-f0-9]{64}$/.test(record.sha256)) ||
      (record.status === "ready" && (!record.sha256 || !record.bytes))
    )
      throw fail("mesh_catalog_incompatible");
    seen.add(record.short_code);
  }
}
const ready = (catalog) =>
  catalog.records
    .filter((r) => r.status === "ready")
    .sort((a, b) => a.short_code.localeCompare(b.short_code));
const catalog_hash = (catalog) =>
  hash({
    ...catalog,
    records: [...catalog.records].sort((a, b) =>
      a.short_code.localeCompare(b.short_code),
    ),
  });

export function plan_mesh_sync(local, remote, preferred = "local") {
  validate_catalog(local);
  validate_catalog(remote);
  if (
    local.namespace !== remote.namespace ||
    hash(local.profile) !== hash(remote.profile)
  )
    throw fail("mesh_source_mismatch");
  const maps = [local, remote].map(
    (c) => new Map(c.records.map((r) => [r.short_code, r])),
  );
  const codes = [
    ...new Set([...ready(local), ...ready(remote)].map((r) => r.short_code)),
  ].sort();
  // The resulting store must also fit the bound, including unusable local
  // files retained outside the shared ready-file union.
  if (
    codes.length > 500000 ||
    maps.some(
      (map) =>
        map.size + codes.filter((code) => !map.has(code)).length > 500000,
    )
  )
    throw fail("mesh_catalog_limit", 413);
  const transfers = [],
    conflicts = [],
    records = [],
    levels = new Map();
  let conflict_count = 0;
  for (const code of codes) {
    const [a, b] = maps.map((m) => m.get(code));
    const av = a?.status === "ready",
      bv = b?.status === "ready";
    const conflict = av && bv && a.sha256 !== b.sha256;
    if (conflict) {
      conflict_count++;
      if (conflicts.length < 200)
        conflicts.push({
          table: code,
          local_key: a.sha256,
          remote_key: b.sha256,
          columns: ["gzip checksum"],
        });
    }
    const winner = av && (!bv || !conflict || preferred === "local") ? a : b;
    records.push(winner);
    const target = winner === a ? "remote" : "local",
      current = target === "local" ? a : b;
    if (current?.status !== "ready" || current.sha256 !== winner.sha256)
      transfers.push({
        code,
        target,
        record: winner,
        expected: current?.sha256 || null,
      });
    const level = code.length,
      summary = levels.get(level) || {
        name: `L${level}`,
        local_rows: 0,
        remote_rows: 0,
        merged_rows: 0,
      };
    summary.local_rows += Number(av);
    summary.remote_rows += Number(bv);
    summary.merged_rows++;
    levels.set(level, summary);
  }
  return {
    transfers,
    conflicts,
    conflict_count,
    records,
    tables: [...levels.values()].sort(
      (a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)),
    ),
    skipped:
      local.records.length +
      remote.records.length -
      ready(local).length -
      ready(remote).length,
  };
}

export class MeshSyncJobs {
  constructor({
    local = local_mesh_request,
    remote = peer_mesh_request,
    peers = () => configured_peers(),
  } = {}) {
    Object.assign(this, { local, remote, peers });
    this.jobs = new Map();
  }
  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw fail("sync_job_not_found", 404);
    const { peer, local_catalog, remote_catalog, completion, ...view } = job;
    return view;
  }
  create(url) {
    const server_url = normalize_peer(url),
      peer = this.peers().get(server_url);
    if (!peer) throw fail("sync_peer_not_configured", 400);
    if (
      [...this.jobs.values()].some((j) =>
        ["checking", "applying"].includes(j.status),
      )
    )
      throw fail("mesh_sync_busy");
    while (this.jobs.size >= 3) this.jobs.delete(this.jobs.keys().next().value);
    const job = {
      id: randomUUID(),
      server_url,
      peer,
      status: "checking",
      phase: "Reading mesh inventories",
      created_at: Date.now(),
    };
    this.jobs.set(job.id, job);
    job.completion = this.preview(job).catch((e) => {
      job.status = "failed";
      job.error = error_code(e);
    });
    return this.get(job.id);
  }
  async close(job, local, remote) {
    await Promise.allSettled([
      local && this.local(`/sessions/${local.id}/close`),
      remote && this.remote(job.peer, `/sessions/${remote.id}/close`),
    ]);
  }
  async preview(job) {
    let a, b;
    try {
      a = await this.local("/sessions");
      b = await this.remote(job.peer, "/sessions");
      const plan = plan_mesh_sync(a.catalog, b.catalog);
      Object.assign(job, {
        local_catalog: a.catalog,
        remote_catalog: b.catalog,
        conflicts: plan.conflicts,
        conflict_count: plan.conflict_count,
        tables: plan.tables,
        skipped: plan.skipped,
        progress: {
          files_total: plan.transfers.length,
          files_processed: 0,
          bytes_total: plan.transfers.reduce((n, t) => n + t.record.bytes, 0),
          bytes_transferred: 0,
        },
      });
    } finally {
      await this.close(job, a, b);
    }
    job.status = "ready";
    job.phase = "Ready to share mesh files";
  }
  apply(id, preferred) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "ready") throw fail("sync_plan_not_ready");
    if (Date.now() - job.created_at > 1800000) throw fail("sync_plan_expired");
    if (job.conflicts.length && !["local", "remote"].includes(preferred))
      throw fail("choose_conflict_server", 400);
    if (preferred != null && !["local", "remote"].includes(preferred))
      throw fail("invalid_conflict_server", 400);
    if (
      [...this.jobs.values()].some((j) =>
        ["checking", "applying"].includes(j.status),
      )
    )
      throw fail("mesh_sync_busy");
    job.status = "applying";
    job.phase = "Rechecking mesh inventories";
    job.completion = this.synchronize(job, preferred || "local").catch((e) => {
      job.status = job.transfer_started ? "partial" : "failed";
      job.error = error_code(e);
    });
    return this.get(id);
  }
  async synchronize(job, preferred) {
    let a, b;
    try {
      a = await this.local("/sessions");
      b = await this.remote(job.peer, "/sessions");
      if (
        catalog_hash(a.catalog) !== catalog_hash(job.local_catalog) ||
        catalog_hash(b.catalog) !== catalog_hash(job.remote_catalog)
      )
        throw fail("mesh_snapshot_changed");
      const plan = plan_mesh_sync(a.catalog, b.catalog, preferred);
      const call = (target, action, code, body) =>
        target === "local"
          ? this.local(`/sessions/${a.id}/${action}/${code}`, body)
          : this.remote(job.peer, `/sessions/${b.id}/${action}/${code}`, body);
      for (const transfer of plan.transfers) {
        job.phase = `Sharing mesh ${transfer.code}`;
        const source = transfer.target === "local" ? "remote" : "local";
        const data = await call(source, "read", transfer.code, {
          record: transfer.record,
        });
        job.transfer_started = true;
        await call(transfer.target, "write", transfer.code, {
          ...data,
          record: transfer.record,
          expected: transfer.expected,
        });
        job.progress.files_processed++;
        job.progress.bytes_transferred += transfer.record.bytes;
      }
      job.phase = "Verifying matching mesh checksums";
      const [left, right] = await Promise.all([
        this.local(`/sessions/${a.id}/catalog`),
        this.remote(job.peer, `/sessions/${b.id}/catalog`),
      ]);
      const expected = hash(plan.records);
      if (hash(ready(left)) !== expected || hash(ready(right)) !== expected)
        throw fail("mesh_verification_failed");
      job.status = "completed";
      job.phase = "Both servers have matching mesh files";
      job.finished_at = Date.now();
      delete job.local_catalog;
      delete job.remote_catalog;
    } finally {
      await this.close(job, a, b);
    }
  }
}

export function create_mesh_sync_router({ jobs = new MeshSyncJobs() } = {}) {
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
        throw fail("invalid_mesh_request", 400);
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
        throw fail("invalid_mesh_request", 400);
      res.status(202).json(jobs.apply(req.params.id, req.body.preferred));
    }),
  );
  return router;
}
