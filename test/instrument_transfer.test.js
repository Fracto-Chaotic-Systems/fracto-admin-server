import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import {
  transfer_fixture,
  publication_fixture,
} from "../../fracto-asset-server/test/instrument_transfer_fixture.js";
import { create_instrument_router } from "../../fracto-asset-server/handlers/instruments.js";
import { InstrumentTransferStore } from "../../fracto-asset-server/instruments/transfer_store.js";
import { staging_path } from "../../fracto-asset-server/instruments/transfer_staging.js";
import {
  download_instrument_file,
  upload_instrument_file,
} from "../handlers/instrument_transfer_binary.js";
import { create_instrument_transfer_router as asset_router } from "../../fracto-asset-server/handlers/instrument_transfer.js";
import {
  create_instrument_peer_router,
  create_instrument_transfer_router,
} from "../handlers/instrument_transfer.js";
import { InstrumentTransferJobs } from "../handlers/instrument_transfer_jobs.js";
import {
  instrument_request,
  peer_instrument_request,
} from "../handlers/instrument_transfer_client.js";
import {
  transfer_hash,
  transfer_error,
  TRANSFER_LIMITS,
} from "../../../utils/instrument_transfer.js";

const secret = "instrument-test-only-pair-token-123456789";
const internal = "instrument-test-only-internal-token";
const version = { protocol_version: 1 };
const owner = transfer_hash("local");
async function listen(t, app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function local_service(t, fixture, { publication_enabled = false } = {}) {
  const app = express();
  const store = new InstrumentTransferStore({
    directory: fixture.root,
    publication_enabled,
    persistent: true,
    storage: async () => ({ ready: true, free_bytes: 32 * 1024 ** 3 }),
  });
  app.use(
    "/internal/instrument-transfer",
    asset_router({
      store,
      authorize: (req, res, next) =>
        req.get("x-fracto-service-token") === internal
          ? next()
          : res.sendStatus(403),
    }),
  );
  app.use(
    "/instruments",
    create_instrument_router({
      directory: fixture.root,
      logger: { error() {} },
    }),
  );
  const base = await listen(t, app);
  const local = (suffix, options = {}, identity = owner) =>
    instrument_request(`${base}/internal/instrument-transfer${suffix}`, {
      ...options,
      headers: {
        "x-fracto-service-token": internal,
        "x-fracto-transfer-owner": identity,
      },
    });
  const headers = {
    "x-fracto-service-token": internal,
    "x-fracto-transfer-owner": owner,
  };
  const download = (suffix, options) =>
    download_instrument_file(`${base}/internal/instrument-transfer${suffix}`, {
      ...options,
      headers,
    });
  const upload = (suffix, options, identity = owner) =>
    upload_instrument_file(`${base}/internal/instrument-transfer${suffix}`, {
      ...options,
      headers: { ...headers, "x-fracto-transfer-owner": identity },
    });
  return { local, store, base, download, upload };
}
async function topology(
  t,
  incomplete = false,
  { make_fixture = transfer_fixture, publication_enabled = false } = {},
) {
  const a = make_fixture(t),
    b = make_fixture(t);
  if (incomplete) fs.unlinkSync(path.join(b.root, b.asset.path));
  const source = await local_service(t, a, { publication_enabled }),
    target = await local_service(t, b, { publication_enabled });
  const peer_app = express();
  peer_app.use(
    "/instrument-transfer/peer",
    create_instrument_peer_router({
      local: target.local,
      upload: target.upload,
      peers: () =>
        new Map([
          [
            "http://source.example",
            { endpoint: "http://source.example/api/admin", token: secret },
          ],
        ]),
    }),
  );
  const peer_base = await listen(t, peer_app);
  const peer = { endpoint: peer_base, token: secret };
  const peers = () => new Map([["http://receiver.example", peer]]);
  const jobs = new InstrumentTransferJobs({
    peers,
    local: source.local,
    download: source.download,
    poll_ms: 1,
  });
  const browser = express();
  browser.use(
    "/instrument-transfer",
    create_instrument_transfer_router({
      peers,
      jobs,
      authorize: (req, res, next) =>
        req.get("x-test-admin") === "yes" ? next() : res.sendStatus(403),
    }),
  );
  const browser_base = await listen(t, browser);
  return { a, b, source, target, peer, peers, jobs, browser_base };
}
async function terminal(jobs, id) {
  const job = jobs.get(id);
  await job.work;
  return jobs.status(job);
}
test("HTTP preview negotiates both services and inventories a missing destination file without transferring it", async (t) => {
  const f = await topology(t, true);
  const response = await fetch(`${f.browser_base}/instrument-transfer/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-admin": "yes" },
    body: JSON.stringify({ ...version, peer: "http://receiver.example" }),
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const started = await response.json();
  const result = await terminal(f.jobs, started.id);
  assert.equal(result.state, "ready");
  assert.equal(result.summary.missing_files, 1);
  assert.equal(result.summary.missing_bytes, 64);
  assert.equal(result.summary.required_free_bytes, 1024 ** 3 + 128);
  assert.match(result.plan_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.progress.bytes_transferred, 0);
  assert.equal(fs.existsSync(path.join(f.b.root, f.b.asset.path)), false);
  assert.equal(JSON.stringify(result).includes(f.a.root), false);
  const apply = await fetch(
    `${f.browser_base}/instrument-transfer/jobs/${started.id}/apply`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-admin": "yes" },
      body: JSON.stringify(version),
    },
  );
  assert.equal(apply.status, 400);
  await f.jobs.cancel(f.jobs.get(started.id));
});
test("identical-package previews work with the sender and receiver roles reversed", async (t) => {
  const f = await topology(t);
  const forward = f.jobs.start("http://receiver.example");
  assert.equal((await terminal(f.jobs, forward.id)).summary.missing_files, 0);
  await f.jobs.cancel(forward);
  fs.unlinkSync(path.join(f.a.root, f.a.asset.path));
  // Use the very same HTTP backend on the opposite side, not a special receiver implementation.
  const peer_app = express();
  peer_app.use(
    "/instrument-transfer/peer",
    create_instrument_peer_router({
      local: f.source.local,
      upload: f.source.upload,
      peers: () =>
        new Map([
          [
            "http://receiver.example",
            { endpoint: "http://receiver.example", token: secret },
          ],
        ]),
    }),
  );
  const base = await listen(t, peer_app);
  const jobs = new InstrumentTransferJobs({
    local: f.target.local,
    download: f.target.download,
    poll_ms: 1,
    peers: () =>
      new Map([["http://source.example", { endpoint: base, token: secret }]]),
  });
  const reverse = jobs.start("http://source.example");
  const result = await terminal(jobs, reverse.id);
  assert.equal(result.state, "ready");
  assert.equal(result.summary.matching_files, 2);
  jobs.apply(reverse, reverse.plan_sha256);
  await reverse.work;
  assert.equal(reverse.state, "staged", JSON.stringify(reverse.error));
  assert.equal(reverse.progress.bytes_transferred, 64);
  await jobs.cancel(reverse);
});
test("peer/internal/browser authorization precedes malformed body parsing and sessions are peer-owned", async (t) => {
  const f = await topology(t);
  for (const [url, headers] of [
    [`${f.peer.endpoint}/instrument-transfer/peer/sessions`, {}],
    [`${f.source.base}/internal/instrument-transfer/exports`, {}],
    [`${f.browser_base}/instrument-transfer/jobs`, {}],
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{",
    });
    assert.equal(response.status, 403);
  }
  const job = f.jobs.start("http://receiver.example");
  await job.work;
  const session = f.target.store.sessions.values().next().value;
  assert.throws(
    () => f.target.store.get(f.target.store.sessions, session.id, owner),
    { status: 404 },
  );
  const malformed = await fetch(
    `${f.peer.endpoint}/instrument-transfer/peer/sessions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fracto-sync-token": secret,
      },
      body: "{",
    },
  );
  assert.equal(malformed.status, 400);
  assert.equal(
    (await malformed.json()).error.code,
    "instrument_transfer_invalid_request",
  );
  await f.jobs.cancel(job);
});
test("legacy peers and bounded or malformed peer responses fail safely", async (t) => {
  const app = express();
  const base = await listen(t, app);
  await assert.rejects(
    peer_instrument_request({ endpoint: base, token: secret }, "/capabilities"),
    { code: "instrument_transfer_upgrade_required" },
  );
  await assert.rejects(
    instrument_request("http://fixture.invalid", {
      max_bytes: 10,
      fetcher: async () =>
        new Response(" ".repeat(11), { headers: { "content-length": "11" } }),
    }),
    { code: "instrument_transfer_limit_exceeded" },
  );
  await assert.rejects(
    instrument_request("http://fixture.invalid", {
      fetcher: async () =>
        new Response(
          JSON.stringify({ error: { code: "private path C:/secrets" } }),
          { status: 503 },
        ),
    }),
    { code: "instrument_transfer_validation_failed" },
  );
});
test("blocked previews retain useful conflict summaries and never apply", async (t) => {
  const f = await topology(t);
  f.b.catalog.library_version++;
  f.b.save();
  const job = f.jobs.start("http://receiver.example");
  const result = await terminal(f.jobs, job.id);
  assert.equal(result.state, "blocked");
  assert.equal(result.error.code, "instrument_transfer_catalog_conflict");
  assert.equal(result.summary.conflict_files, 1);
  assert.equal(result.summary.publication_state, "unchanged");
});
test("configured peers only; unknown fields, versions and untrusted requests cannot start scans", async (t) => {
  const f = await topology(t);
  assert.throws(() => f.jobs.start("http://unconfigured.example"), {
    status: 403,
  });
  for (const body of [
    { ...version, peer: "http://receiver.example", force: true },
    { protocol_version: 2, peer: "http://receiver.example" },
  ]) {
    const response = await fetch(`${f.browser_base}/instrument-transfer/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-admin": "yes" },
      body: JSON.stringify(body),
    });
    assert.ok([400, 409].includes(response.status));
  }
  assert.equal(f.source.store.exports.size, 0);
});
test("preview cancellation settles polling and releases the source export", async () => {
  let released = false;
  const export_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const local = async (suffix) => {
    if (suffix === "/capabilities")
      return { protocol_versions: [1], limits: TRANSFER_LIMITS };
    if (suffix === "/exports") return { export_id };
    if (suffix.endsWith("/release")) {
      released = true;
      return version;
    }
    return { ...version, state: "scanning", files_checked: 1 };
  };
  const jobs = new InstrumentTransferJobs({
    local,
    remote: async () => ({ protocol_versions: [1], limits: TRANSFER_LIMITS }),
    peers: () => new Map([["http://receiver.example", {}]]),
    poll_ms: 1,
  });
  const job = jobs.start("http://receiver.example");
  while (!job.export_id) await new Promise((resolve) => setImmediate(resolve));
  await jobs.cancel(job);
  assert.equal(job.state, "cancelled");
  assert.equal(released, true);
});

test("apply streams through both admin hops, verifies staging, and leaves the live library unchanged", async (t) => {
  const f = await topology(t, true);
  const job = f.jobs.start("http://receiver.example");
  await job.work;
  const response = await fetch(
    `${f.browser_base}/instrument-transfer/jobs/${job.id}/apply`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-admin": "yes" },
      body: JSON.stringify({ ...version, plan_sha256: job.plan_sha256 }),
    },
  );
  assert.equal(response.status, 202);
  assert.equal(f.jobs.apply(job, job.plan_sha256), job);
  await job.work;
  assert.equal(job.state, "staged", JSON.stringify(job.error));
  const file = job.manifest.files.find((file) => file.kind === "playback");
  assert.deepEqual(
    fs.readFileSync(
      path.join(f.b.root, staging_path(job.manifest_sha256, file)),
    ),
    fs.readFileSync(path.join(f.a.root, f.a.asset.path)),
  );
  assert.equal(fs.existsSync(path.join(f.b.root, f.b.asset.path)), false);
  assert.equal(job.progress.bytes_transferred, 64);
  assert.equal(f.source.store.reservation, null);
  assert.equal(f.target.store.reservation, null);
  // Verified cache files, not session memory, make retries incremental.
  const retry = f.jobs.start("http://receiver.example");
  await retry.work;
  assert.equal(retry.summary.missing_files, 0);
  f.jobs.apply(retry, retry.plan_sha256);
  await retry.work;
  assert.equal(retry.state, "staged", JSON.stringify(retry.error));
  assert.equal(retry.progress.bytes_transferred, 0);
});

test("a lost upload acknowledgement reports partial and a new preview reuses the verified bytes", async (t) => {
  const f = await topology(t, true);
  const upload = f.jobs.upload;
  f.jobs.upload = async (...args) => {
    await upload(...args);
    throw transfer_error("peer_unavailable", 503);
  };
  const first = f.jobs.start("http://receiver.example");
  await first.work;
  f.jobs.apply(first, first.plan_sha256);
  await first.work;
  assert.equal(first.state, "partial");
  assert.equal(first.progress.bytes_transferred, 0);
  assert.equal(f.target.store.reservation, null);
  f.jobs.upload = upload;
  const retry = f.jobs.start("http://receiver.example");
  await retry.work;
  assert.equal(retry.summary.missing_files, 0);
  f.jobs.apply(retry, retry.plan_sha256);
  await retry.work;
  assert.equal(retry.state, "staged", JSON.stringify(retry.error));
  assert.equal(retry.progress.bytes_transferred, 0);
});

test("cancelling after a verified write preserves the cache and releases both owner locks", async (t) => {
  const f = await topology(t, true),
    upload = f.jobs.upload;
  let notify;
  const written = new Promise((resolve) => {
    notify = resolve;
  });
  f.jobs.upload = async (...args) => {
    await upload(...args);
    const signal = args[2].signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(transfer_error("cancelled", 503)),
        { once: true },
      );
      notify();
    });
  };
  const job = f.jobs.start("http://receiver.example");
  await job.work;
  f.jobs.apply(job, job.plan_sha256);
  await written;
  await f.jobs.cancel(job);
  assert.equal(job.state, "partial");
  assert.equal(f.source.store.reservation, null);
  assert.equal(f.target.store.reservation, null);
  const next = f.jobs.start("http://receiver.example");
  await next.work;
  assert.equal(next.summary.missing_files, 0);
  await f.jobs.cancel(next);
});

test("multi-megabyte files stream concurrently with verified acknowledgements", async (t) => {
  const f = await topology(t);
  for (const fixture of [f.a, f.b]) {
    const instrument = fixture.catalog.instruments[0];
    const original = Buffer.alloc(2 * 1024 * 1024 + 197, 7),
      audio = Buffer.alloc(3 * 1024 * 1024 + 13, 11);
    Object.assign(instrument.recordings[0], {
      bytes: original.length,
      sha256: transfer_hash(original),
    });
    const asset = instrument.playback_assets[0];
    Object.assign(asset, {
      bytes: audio.length,
      sha256: transfer_hash(audio),
      path: `playback/${asset.recording_id}/${transfer_hash(audio)}.wav`,
    });
    fixture.write(instrument.recordings[0].path, original);
    fixture.write(asset.path, audio);
    fixture.save();
  }
  fs.unlinkSync(path.join(f.b.root, f.b.recording.path));
  fs.unlinkSync(path.join(f.b.root, f.b.asset.path));
  const job = f.jobs.start("http://receiver.example");
  await job.work;
  assert.equal(job.summary.missing_files, 2);
  f.jobs.apply(job, job.plan_sha256);
  await job.work;
  assert.equal(job.state, "staged", JSON.stringify(job.error));
  assert.equal(job.progress.bytes_transferred, 5 * 1024 * 1024 + 210);
  for (const file of job.manifest.files.filter((file) =>
    ["original", "playback"].includes(file.kind),
  ))
    assert.equal(
      transfer_hash(
        fs.readFileSync(
          path.join(f.b.root, staging_path(job.manifest_sha256, file)),
        ),
      ),
      file.sha256,
    );
});

test("a network disconnect during upload cancels the downstream write and removes the partial", async (t) => {
  const f = await topology(t, true);
  const job = f.jobs.start("http://receiver.example");
  await job.work;
  await f.jobs.remote(f.peer, `/sessions/${job.session_id}/prepare`, {
    method: "POST",
    body: {
      ...version,
      manifest_sha256: job.manifest_sha256,
      target_snapshot_sha256: job.target_snapshot_sha256,
      plan_sha256: job.plan_sha256,
    },
  });
  const remote = (suffix, options) => f.jobs.remote(f.peer, suffix, options);
  const prepared = await f.jobs.poll(
    job,
    remote,
    `/sessions/${job.session_id}`,
  );
  assert.equal(prepared.state, "transferring");
  const file = job.manifest.files.find((file) => file.kind === "playback");
  const request = http.request(
    `${f.peer.endpoint}/instrument-transfer/peer/sessions/${job.session_id}/files/${file.file_id}`,
    {
      method: "PUT",
      headers: {
        "x-fracto-sync-token": secret,
        "content-type": "application/octet-stream",
        "content-length": String(file.bytes),
      },
    },
  );
  request.on("error", () => {});
  request.write(Buffer.alloc(5));
  const parts = () =>
    fs
      .readdirSync(f.b.root, { recursive: true })
      .filter((name) => String(name).endsWith(".part"));
  const wait = async (condition) => {
    for (let i = 0; i < 1000; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("upload did not settle");
  };
  await wait(() => parts().length > 0);
  request.destroy();
  await wait(() => !parts().length);
  assert.equal(
    fs.existsSync(path.join(f.b.root, staging_path(job.manifest_sha256, file))),
    false,
  );
  await f.jobs.cancel(job);
  assert.equal(f.target.store.reservation, null);
});

test("full apply publishes a live instrument library and checks its durable completion receipt", async (t) => {
  const f = await topology(t, true, {
    make_fixture: publication_fixture,
    publication_enabled: true,
  });
  const before = await fetch(`${f.target.base}/instruments`).then((response) =>
    response.json(),
  );
  assert.equal(before.instruments[0].available, false);
  const job = f.jobs.start("http://receiver.example");
  await job.work;
  f.jobs.apply(job, job.plan_sha256);
  await job.work;
  assert.equal(
    job.state,
    "completed",
    JSON.stringify({
      job: job.error,
      target: [...f.target.store.sessions.values()].map((e) => ({
        state: e.state,
        error: e.error,
        phase: e.journal_phase,
      })),
    }),
  );
  assert.equal(job.receipt.catalog_sha256, job.manifest.catalog_sha256);
  assert.equal(job.receipt.files_verified, job.manifest.files.length);
  assert.equal(job.summary.publication_state, "published");
  assert.equal(f.jobs.apply(job, job.plan_sha256), job);
  const after = await fetch(`${f.target.base}/instruments`).then((response) =>
    response.json(),
  );
  assert.equal(after.instruments[0].available, true);
  const audio = await fetch(
    `${f.target.base}${after.instruments[0].playback_assets[0].url}`,
  );
  assert.equal(audio.status, 200);
  assert.equal(
    transfer_hash(Buffer.from(await audio.arrayBuffer())),
    f.b.asset.sha256,
  );
});

test("HTTP source-authoritative export repairs differing destination bytes and catalogs, then becomes a no-op", async (t) => {
  const f = await topology(t, false, {
    make_fixture: publication_fixture,
    publication_enabled: true,
  });
  const previous = new Map();
  f.b.catalog.library_version++;
  f.b.save();
  f.b.write(f.b.asset.path, Buffer.alloc(300, 7));
  f.b.write(f.b.recording.path, "corrupted original");
  for (const relative of ["catalog.json", f.b.asset.path, f.b.recording.path])
    previous.set(relative, fs.readFileSync(path.join(f.b.root, relative)));
  const job = f.jobs.start("http://receiver.example");
  await job.work;
  assert.equal(job.state, "ready", JSON.stringify(job.error));
  assert.equal(f.jobs.status(job).replacement_policy, "source");
  assert.equal(job.summary.conflict_files, 3);
  assert.equal(job.summary.missing_files, 0);
  assert.ok(job.progress.bytes_to_transfer > 0);
  for (const [relative, bytes] of previous)
    assert.deepEqual(fs.readFileSync(path.join(f.b.root, relative)), bytes);
  f.jobs.apply(job, job.plan_sha256);
  await job.work;
  assert.equal(job.state, "completed", JSON.stringify(job.error));
  for (const file of job.manifest.files)
    assert.equal(
      transfer_hash(fs.readFileSync(path.join(f.b.root, file.relative_path))),
      file.sha256,
    );
  assert.equal(job.receipt.catalog_sha256, job.manifest.catalog_sha256);
  const retry = f.jobs.start("http://receiver.example");
  await retry.work;
  assert.equal(retry.summary.missing_files + retry.summary.conflict_files, 0);
  f.jobs.apply(retry, retry.plan_sha256);
  await retry.work;
  assert.equal(retry.state, "completed", JSON.stringify(retry.error));
  assert.equal(retry.progress.bytes_transferred, 0);
});

test("an unnegotiated peer retains the legacy no-overwrite policy", async (t) => {
  const f = await topology(t, false, {
    make_fixture: publication_fixture,
    publication_enabled: true,
  });
  f.b.catalog.library_version++;
  f.b.save();
  const previous = fs.readFileSync(path.join(f.b.root, "catalog.json"));
  const remote = f.jobs.remote;
  f.jobs.remote = async (...args) => {
    const result = await remote(...args);
    if (args[1] === "/capabilities") delete result.replacement_policies;
    return result;
  };
  const job = f.jobs.start("http://receiver.example");
  await job.work;
  assert.equal(job.replacement_policy, "preserve");
  assert.equal(job.state, "blocked");
  assert.equal(job.error.code, "instrument_transfer_catalog_conflict");
  assert.throws(() => f.jobs.apply(job, job.plan_sha256), {
    code: "instrument_transfer_invalid_state",
  });
  assert.deepEqual(
    fs.readFileSync(path.join(f.b.root, "catalog.json")),
    previous,
  );
});

test("reverse publication and a byte-identical no-op finish with restart-safe receipts", async (t) => {
  const f = await topology(t, false, {
    make_fixture: publication_fixture,
    publication_enabled: true,
  });
  fs.unlinkSync(path.join(f.a.root, f.a.asset.path));
  const app = express();
  app.use(
    "/instrument-transfer/peer",
    create_instrument_peer_router({
      local: f.source.local,
      upload: f.source.upload,
      peers: () =>
        new Map([
          [
            "http://receiver.example",
            { endpoint: "http://receiver.example", token: secret },
          ],
        ]),
    }),
  );
  const endpoint = await listen(t, app);
  const jobs = new InstrumentTransferJobs({
    local: f.target.local,
    download: f.target.download,
    poll_ms: 1,
    peers: () =>
      new Map([["http://source.example", { endpoint, token: secret }]]),
  });
  const reverse = jobs.start("http://source.example");
  await reverse.work;
  assert.equal(reverse.state, "ready", JSON.stringify(reverse.error));
  assert.equal(reverse.summary.missing_files, 1);
  jobs.apply(reverse, reverse.plan_sha256);
  await reverse.work;
  assert.equal(reverse.state, "completed", JSON.stringify(reverse.error));
  assert.equal(reverse.receipt.bytes_verified, reverse.summary.package_bytes);
  const inventory = await fetch(`${f.source.base}/instruments`).then(
    (response) => response.json(),
  );
  assert.equal(inventory.instruments[0].available, true);
  const restarted = new InstrumentTransferStore({
    directory: f.a.root,
    persistent: true,
  });
  await restarted.initialize();
  const recovered = await restarted.lookup(
    restarted.sessions,
    reverse.session_id,
    transfer_hash(secret),
  );
  assert.equal(recovered.state, "completed");
  assert.deepEqual(restarted.status(recovered).receipt, reverse.receipt);
  const noop = jobs.start("http://source.example");
  await noop.work;
  assert.equal(noop.summary.missing_files, 0);
  jobs.apply(noop, noop.plan_sha256);
  await noop.work;
  assert.equal(noop.state, "completed", JSON.stringify(noop.error));
  assert.equal(noop.progress.bytes_transferred, 0);
  assert.equal(noop.receipt.files_verified, noop.summary.package_files);
});

test("lost finalize acknowledgement is recovered by polling the receiver receipt", async (t) => {
  const f = await topology(t, true, {
    make_fixture: publication_fixture,
    publication_enabled: true,
  });
  const remote = f.jobs.remote;
  f.jobs.remote = async (...args) => {
    const result = await remote(...args);
    if (args[1].endsWith("/finalize"))
      throw transfer_error("peer_unavailable", 503);
    return result;
  };
  const job = f.jobs.start("http://receiver.example");
  await job.work;
  f.jobs.apply(job, job.plan_sha256);
  await job.work;
  assert.equal(job.state, "completed", JSON.stringify(job.error));
  assert.ok(job.receipt);
});
