import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { normalize_peer } from "./database_sync.js";
import {
  local_instrument_download,
  peer_instrument_upload,
} from "./instrument_transfer_binary.js";
import { apply_instrument_transfer } from "./instrument_transfer_send.js";
import {
  local_instrument_request,
  peer_instrument_request,
} from "./instrument_transfer_client.js";
import {
  canonical_manifest,
  is_hash,
  json_hash,
  transfer_error,
  public_transfer_error,
  TRANSFER_LIMITS,
} from "../../../utils/instrument_transfer.js";

const version = { protocol_version: 1 };
const numeric_summary = [
  "package_files",
  "package_bytes",
  "matching_files",
  "missing_files",
  "missing_bytes",
  "conflict_files",
  "free_bytes",
  "required_free_bytes",
];
export function preview_summary(value) {
  if (
    !value ||
    numeric_summary.some(
      (key) => !Number.isSafeInteger(value[key]) || value[key] < 0,
    ) ||
    !is_hash(value.source_catalog_sha256) ||
    (value.target_catalog_sha256 !== null &&
      !is_hash(value.target_catalog_sha256)) ||
    !Array.isArray(value.conflict_file_ids) ||
    value.conflict_file_ids.length > 100 ||
    value.conflict_file_ids.some((id) => !is_hash(id)) ||
    value.publication_state !== "unchanged" ||
    ["replacement_bytes", "replacement_files"].some(
      (key) =>
        value[key] !== undefined &&
        (!Number.isSafeInteger(value[key]) || value[key] < 0),
    )
  )
    throw transfer_error("invalid_manifest", 400);
  return {
    source_catalog_sha256: value.source_catalog_sha256,
    target_catalog_sha256: value.target_catalog_sha256,
    ...Object.fromEntries(numeric_summary.map((key) => [key, value[key]])),
    conflict_file_ids: value.conflict_file_ids,
    replacement_bytes: value.replacement_bytes ?? 0,
    replacement_files: value.replacement_files ?? value.conflict_files,
    publication_state: "unchanged",
  };
}
export class InstrumentTransferJobs {
  constructor({
    peers,
    local = local_instrument_request,
    remote = peer_instrument_request,
    download = local_instrument_download,
    upload = peer_instrument_upload,
    now = Date.now,
    poll_ms = 250,
  } = {}) {
    Object.assign(this, {
      peers,
      local,
      remote,
      download,
      upload,
      now,
      poll_ms,
    });
    this.jobs = new Map();
  }
  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw transfer_error("job_not_found", 404);
    if (
      this.now() >= job.deadline &&
      !["cancelled", "expired"].includes(job.state)
    ) {
      job.state = "expired";
      job.controller.abort();
      void this.release(job);
    }
    return job;
  }
  start(peer_url) {
    if (typeof peer_url !== "string")
      throw transfer_error("invalid_request", 400);
    let url;
    try {
      url = normalize_peer(peer_url);
    } catch {
      throw transfer_error("invalid_request", 400);
    }
    const peer = this.peers().get(url);
    if (!peer) throw transfer_error("unauthorized", 403);
    for (const job of this.jobs.values()) this.get(job.id);
    if (
      [...this.jobs.values()].some((j) =>
        [
          "previewing",
          "transferring",
          "validating",
          "publishing",
          "verifying",
        ].includes(j.state),
      )
    )
      throw transfer_error("busy");
    if (this.jobs.size >= 3) {
      const oldest = this.jobs.values().next().value;
      void this.release(oldest);
      this.jobs.delete(oldest.id);
    }
    const job = {
      id: randomUUID(),
      peer,
      peer_url: url,
      controller: new AbortController(),
      state: "previewing",
      phase: "capabilities",
      deadline: this.now() + TRANSFER_LIMITS.preview_seconds * 1000,
      manifest_sha256: null,
      plan_sha256: null,
      summary: null,
      error: null,
      progress: {
        files_checked: 0,
        files_verified: 0,
        files_total: 0,
        bytes_transferred: 0,
        bytes_to_transfer: 0,
        current_file_id: null,
      },
    };
    this.jobs.set(job.id, job);
    job.work = this.preview(job)
      .catch((error) => {
        if (!["cancelled", "expired"].includes(job.state)) {
          job.state = "failed";
          job.error = public_transfer_error(error);
        }
      })
      .finally(async () => {
        if (job.state !== "ready") await this.release(job);
      });
    return job;
  }
  async poll(job, request, suffix) {
    const signal = AbortSignal.any([
      job.signal ?? job.controller.signal,
      AbortSignal.timeout(TRANSFER_LIMITS.preview_seconds * 1000),
    ]);
    while (true) {
      signal.throwIfAborted();
      const value = await request(suffix, { signal });
      if (value.protocol_version !== 1)
        throw transfer_error("upgrade_required");
      const checked = value.files_checked ?? value.progress?.files_checked;
      if (Number.isSafeInteger(checked) && checked >= 0)
        job.progress.files_checked = checked;
      if (
        ![
          "scanning",
          "reserving",
          "preparing",
          "validating",
          "publishing",
          "verifying",
        ].includes(value.state)
      )
        return value;
      await delay(this.poll_ms, undefined, { signal });
    }
  }
  async preview(job) {
    const signal = job.controller.signal;
    const remote = (suffix, options) => this.remote(job.peer, suffix, options);
    const results = await Promise.allSettled([
      this.local("/capabilities", { signal }),
      remote("/capabilities", { signal }),
    ]);
    const limits = { ...TRANSFER_LIMITS };
    job.staging_supported = results.every(
      (r) => r.status === "fulfilled" && r.value.staging_supported === true,
    );
    job.publication_supported = results.every(
      (r) => r.status === "fulfilled" && r.value.publication_supported === true,
    );
    job.replacement_policy =
      results[1].status === "fulfilled" &&
      results[1].value.replacement_policies?.includes("source") &&
      job.publication_supported
        ? "source"
        : "preserve";
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      const caps = result.value;
      if (!caps.protocol_versions?.includes(1))
        throw transfer_error("upgrade_required");
      for (const key of Object.keys(TRANSFER_LIMITS)) {
        if (!Number.isSafeInteger(caps.limits?.[key]) || caps.limits[key] < 1)
          throw transfer_error("upgrade_required");
        limits[key] = Math.min(limits[key], caps.limits[key]);
      }
    }
    job.phase = "source_inventory";
    const opened = await this.local("/exports", {
      method: "POST",
      body: version,
      signal,
    });
    job.export_id = opened.export_id;
    if (!uuid(job.export_id)) throw transfer_error("invalid_request", 400);
    const source = await this.poll(
      job,
      this.local,
      `/exports/${job.export_id}`,
    );
    if (source.state !== "ready") throw from_status(source);
    const package_results = await Promise.allSettled([
      this.local(`/exports/${job.export_id}/manifest`, {
        max_bytes: TRANSFER_LIMITS.manifest_bytes,
        signal,
      }),
      this.local(`/exports/${job.export_id}/catalog`, {
        max_bytes: 32 * 1024 * 1024,
        raw: true,
        signal,
      }),
    ]);
    for (const result of package_results)
      if (result.status === "rejected") throw result.reason;
    const manifest = canonical_manifest(package_results[0].value);
    if (json_hash(manifest) !== source.manifest_sha256)
      throw transfer_error("snapshot_changed");
    job.manifest_sha256 = source.manifest_sha256;
    job.manifest = manifest;
    job.limits = limits;
    const body = {
      protocol_version: 1,
      manifest,
      catalog_text: package_results[1].value,
      ...(job.replacement_policy === "source"
        ? { replacement_policy: "source" }
        : {}),
    };
    if (
      manifest.files.length > limits.manifest_files ||
      manifest.files.some((file) => file.bytes > limits.file_bytes) ||
      manifest.files.reduce((n, file) => n + file.bytes, 0) >
        limits.package_bytes ||
      Buffer.byteLength(JSON.stringify(manifest)) > limits.manifest_bytes ||
      Buffer.byteLength(JSON.stringify(body)) > limits.preview_request_bytes
    )
      throw transfer_error("limit_exceeded", 413);
    job.progress.files_total = manifest.files.length;
    job.phase = "destination_inventory";
    const session = await remote("/sessions", { method: "POST", signal, body });
    job.session_id = session.session_id;
    if (!uuid(job.session_id)) throw transfer_error("invalid_request", 400);
    const target = await this.poll(job, remote, `/sessions/${job.session_id}`);
    if (!["ready", "blocked"].includes(target.state)) throw from_status(target);
    if (
      target.manifest_sha256 !== job.manifest_sha256 ||
      !is_hash(target.target_snapshot_sha256)
    )
      throw transfer_error("snapshot_changed");
    const summary = preview_summary(target.summary);
    if (
      summary.source_catalog_sha256 !== manifest.catalog_sha256 ||
      summary.package_files !== manifest.files.length ||
      summary.package_bytes !==
        manifest.files.reduce((n, file) => n + file.bytes, 0) ||
      summary.package_files !==
        summary.matching_files + summary.missing_files + summary.conflict_files
    )
      throw transfer_error("invalid_manifest", 400);
    signal.throwIfAborted();
    job.summary = summary;
    job.target_snapshot_sha256 = target.target_snapshot_sha256;
    job.progress = {
      ...job.progress,
      files_checked: summary.package_files,
      files_verified: summary.matching_files,
      bytes_to_transfer: summary.missing_bytes + summary.replacement_bytes,
    };
    job.plan_sha256 = json_hash({
      protocol_version: 1,
      peer: job.peer_url,
      manifest_sha256: job.manifest_sha256,
      target_snapshot_sha256: target.target_snapshot_sha256,
      replacement_policy: job.replacement_policy,
    });
    job.deadline = this.now() + TRANSFER_LIMITS.preview_seconds * 1000;
    job.state = target.state;
    job.phase = "preview_complete";
    job.error = target.error ? public_transfer_error(target.error) : null;
  }
  async release(job) {
    const requests = [];
    if (job.export_id)
      requests.push(
        Promise.resolve().then(() =>
          this.local(`/exports/${job.export_id}/release`, {
            method: "POST",
            body: version,
          }),
        ),
      );
    if (job.session_id)
      requests.push(
        Promise.resolve().then(() =>
          this.remote(job.peer, `/sessions/${job.session_id}/cancel`, {
            method: "POST",
            body: version,
          }),
        ),
      );
    await Promise.allSettled(requests);
  }
  apply(job, plan_sha256) {
    return apply_instrument_transfer(this, job, plan_sha256);
  }
  async cancel(job) {
    if (job.state === "completed") return;
    if (job.publication_started) {
      const remote = await this.remote(
        job.peer,
        `/sessions/${job.session_id}/cancel`,
        { method: "POST", body: version },
      );
      if (["publishing", "verifying", "completed"].includes(remote.state))
        return;
    }
    job.state = "cancelled";
    job.controller.abort();
    await job.work;
    await this.release(job);
  }
  status(job) {
    return {
      protocol_version: 1,
      id: job.id,
      state: job.state,
      phase: job.phase,
      manifest_sha256: job.manifest_sha256,
      plan_sha256: job.plan_sha256,
      expires_at: new Date(job.deadline).toISOString(),
      progress: job.progress,
      summary: job.summary,
      error: job.error,
      preview_only: !job.staging_supported,
      publication_supported: Boolean(job.publication_supported),
      replacement_policy: job.replacement_policy ?? "preserve",
      receipt: job.receipt ?? null,
    };
  }
}
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function from_status(status) {
  const error = public_transfer_error(status.error);
  return Object.assign(new Error(error.code), {
    code: error.code,
    status: 422,
  });
}
