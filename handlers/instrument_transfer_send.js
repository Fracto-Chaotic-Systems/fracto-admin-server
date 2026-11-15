import {
  is_hash,
  public_transfer_error,
  TRANSFER_LIMITS,
  transfer_error,
} from "../../../utils/instrument_transfer.js";
import { confirm_publication } from "./instrument_transfer_publish.js";

const version = { protocol_version: 1 };
export function pending_files(manifest, bitmap) {
  if (typeof bitmap !== "string") throw transfer_error("invalid_manifest", 400);
  const bytes = Buffer.from(bitmap, "base64");
  if (
    bytes.toString("base64") !== bitmap ||
    bytes.length !== Math.ceil(manifest.files.length / 8)
  )
    throw transfer_error("invalid_manifest", 400);
  for (let index = manifest.files.length; index < bytes.length * 8; index++)
    if (bytes[index >> 3] & (1 << (index & 7)))
      throw transfer_error("invalid_manifest", 400);
  return manifest.files.filter(
    (_file, index) => bytes[index >> 3] & (1 << (index & 7)),
  );
}
export function apply_instrument_transfer(jobs, job, plan_sha256) {
  if (!is_hash(plan_sha256) || plan_sha256 !== job.plan_sha256)
    throw transfer_error("snapshot_changed");
  if (
    [
      "transferring",
      "validating",
      "staged",
      "publishing",
      "verifying",
      "completed",
    ].includes(job.state)
  )
    return job;
  if (job.state === "expired" || jobs.now() >= job.deadline)
    throw transfer_error("expired", 410);
  if (job.state !== "ready") throw transfer_error("invalid_state");
  if (job.replacement_policy !== "source" && job.summary?.conflict_files)
    throw transfer_error("upgrade_required");
  if (!job.staging_supported) throw transfer_error("upgrade_required");
  if (
    [...jobs.jobs.values()].some(
      (other) =>
        other !== job &&
        ["transferring", "validating", "publishing", "verifying"].includes(
          other.state,
        ),
    )
  )
    throw transfer_error("busy");
  job.state = "transferring";
  job.phase = "source_reservation";
  job.deadline = jobs.now() + TRANSFER_LIMITS.apply_seconds * 1000;
  job.signal = AbortSignal.any([
    job.controller.signal,
    AbortSignal.timeout(TRANSFER_LIMITS.apply_seconds * 1000),
  ]);
  job.work = send(jobs, job)
    .catch(async (error) => {
      if (job.publication_started) {
        try {
          await confirm_publication(jobs, job, { recovering: true });
          return;
        } catch {
          job.summary.publication_state = "unknown";
        }
      }
      job.controller.abort(error);
      job.state =
        job.transfer_started || job.publication_started
          ? "partial"
          : job.state === "cancelled"
            ? "cancelled"
            : "failed";
      job.error = public_transfer_error(error);
    })
    .finally(() => jobs.release(job));
  return job;
}
async function send(jobs, job) {
  const signal = job.signal;
  const remote = (suffix, options) => jobs.remote(job.peer, suffix, options);
  await jobs.local(`/exports/${job.export_id}/reserve`, {
    method: "POST",
    signal,
    body: { ...version, manifest_sha256: job.manifest_sha256 },
  });
  const source = await jobs.poll(job, jobs.local, `/exports/${job.export_id}`);
  if (source.state !== "reserved") throw status_error(source);
  job.phase = "destination_reservation";
  await remote(`/sessions/${job.session_id}/prepare`, {
    method: "POST",
    signal,
    body: {
      ...version,
      manifest_sha256: job.manifest_sha256,
      target_snapshot_sha256: job.target_snapshot_sha256,
      plan_sha256: job.plan_sha256,
    },
  });
  const destination = await jobs.poll(
    job,
    remote,
    `/sessions/${job.session_id}`,
  );
  if (
    destination.state !== "transferring" ||
    destination.target_snapshot_sha256 !== job.target_snapshot_sha256
  )
    throw status_error(destination);
  const files = pending_files(job.manifest, destination.pending_bitmap);
  if (
    files.length !==
      job.summary.missing_files +
        (job.replacement_policy === "source"
          ? job.summary.conflict_files
          : 0) ||
    files.reduce((n, f) => n + f.bytes, 0) !==
      job.summary.missing_bytes + (job.summary.replacement_bytes ?? 0)
  )
    throw transfer_error("snapshot_changed");
  let next = 0;
  job.phase = "sending_files";
  const batch = new AbortController();
  const file_signal = AbortSignal.any([signal, batch.signal]);
  const worker = async () => {
    while (next < files.length) {
      file_signal.throwIfAborted();
      const file = files[next++];
      job.progress.current_file_id = file.file_id;
      const stream = await jobs.download(
        `/exports/${job.export_id}/files/${file.file_id}`,
        { file, signal: file_signal },
      );
      try {
        job.transfer_started = true;
        const ack = await jobs.upload(
          job.peer,
          `/sessions/${job.session_id}/files/${file.file_id}`,
          { body: stream.body, file, signal: file_signal, touch: stream.touch },
        );
        if (
          ack.protocol_version !== 1 ||
          ack.file_id !== file.file_id ||
          ack.sha256 !== file.sha256 ||
          ack.bytes !== file.bytes ||
          !["staged", "already_present"].includes(ack.disposition)
        )
          throw transfer_error("verification_failed", 503);
        job.progress.bytes_transferred += file.bytes;
        job.progress.files_verified++;
      } finally {
        await stream.close();
      }
    }
  };
  const results = await Promise.allSettled(
    Array.from(
      { length: Math.min(job.limits.concurrent_files, files.length) },
      () =>
        worker().catch((error) => {
          batch.abort(error);
          throw error;
        }),
    ),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  signal.throwIfAborted();
  job.state = "validating";
  job.phase = "verifying_staged_files";
  job.progress.current_file_id = null;
  await remote(`/sessions/${job.session_id}/stage`, {
    method: "POST",
    signal,
    body: {
      ...version,
      manifest_sha256: job.manifest_sha256,
      plan_sha256: job.plan_sha256,
    },
  });
  const staged = await jobs.poll(job, remote, `/sessions/${job.session_id}`);
  if (
    staged.state !== "staged" ||
    staged.manifest_sha256 !== job.manifest_sha256 ||
    staged.progress?.files_verified !== job.manifest.files.length ||
    staged.summary?.publication_state !== "unchanged"
  )
    throw transfer_error("verification_failed", 503);
  signal.throwIfAborted();
  job.state = "staged";
  job.phase = "awaiting_publication";
  if (job.publication_supported) {
    job.publication_started = true;
    job.state = "publishing";
    job.phase = "publishing_library";
    await remote(`/sessions/${job.session_id}/finalize`, {
      method: "POST",
      signal,
      body: {
        protocol_version: 1,
        manifest_sha256: job.manifest_sha256,
        plan_sha256: job.plan_sha256,
      },
    });
    await confirm_publication(jobs, job);
  }
}
function status_error(value) {
  return Object.assign(new Error(), {
    ...public_transfer_error(value.error),
    status: 409,
  });
}
