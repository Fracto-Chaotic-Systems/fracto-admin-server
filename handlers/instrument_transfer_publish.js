import { transfer_error } from "../../../utils/instrument_transfer.js";

export async function confirm_publication(
  jobs,
  job,
  { recovering = false } = {},
) {
  const remote = (suffix, options) => jobs.remote(job.peer, suffix, options);
  const polling = recovering
    ? { ...job, controller: new AbortController(), signal: undefined }
    : job;
  const result = await jobs.poll(
    polling,
    remote,
    `/sessions/${job.session_id}`,
  );
  const receipt = result.receipt;
  if (
    result.state !== "completed" ||
    result.summary?.publication_state !== "published" ||
    receipt?.protocol_version !== 1 ||
    receipt.manifest_sha256 !== job.manifest_sha256 ||
    receipt.catalog_sha256 !== job.manifest.catalog_sha256 ||
    receipt.files_verified !== job.manifest.files.length ||
    receipt.bytes_verified !==
      job.manifest.files.reduce((n, file) => n + file.bytes, 0) ||
    typeof receipt.completed_at !== "string" ||
    !Number.isFinite(Date.parse(receipt.completed_at))
  )
    throw transfer_error("verification_failed", 503);
  job.receipt = {
    protocol_version: 1,
    manifest_sha256: receipt.manifest_sha256,
    catalog_sha256: receipt.catalog_sha256,
    files_verified: receipt.files_verified,
    bytes_verified: receipt.bytes_verified,
    completed_at: receipt.completed_at,
  };
  job.state = "completed";
  job.phase = "completed";
  job.error = null;
  job.summary.publication_state = "published";
  job.progress.files_verified = job.manifest.files.length;
}
