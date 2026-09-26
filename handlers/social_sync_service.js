import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const handler_directory = path.dirname(fileURLToPath(import.meta.url));
const root_directory = path.resolve(handler_directory, "..", "..", "..");
const sync_script = path.join(root_directory, "scripts", "sync_bluesky_media.js");
const social_directory = path.join(root_directory, "social");
const snapshot_files = [
  path.join(social_directory, "Bluesky", "POST_ARCHIVE.md"),
  path.join(social_directory, "Bluesky", "media", "MEDIA_UPLOADS.md"),
];
const default_ttl_ms = 24 * 60 * 60 * 1000;
const refresh_ttl_ms = Number(
  process.env.FRACTO_SOCIAL_SYNC_TTL_MS || default_ttl_ms,
);

if (!Number.isFinite(refresh_ttl_ms) || refresh_ttl_ms <= 0) {
  throw new Error("FRACTO_SOCIAL_SYNC_TTL_MS must be a positive number");
}

let active_refresh = null;

/** Return the age and completeness of the local social snapshots. */
export const get_social_snapshot_status = () => {
  const modified_times = snapshot_files.map((filepath) => {
    try {
      return fs.statSync(filepath).mtimeMs;
    } catch {
      return null;
    }
  });
  const complete = modified_times.every((value) => Number.isFinite(value));
  // The oldest document determines freshness so both ledgers remain aligned.
  const oldest_snapshot = complete ? Math.min(...modified_times) : null;
  const age_ms =
    oldest_snapshot === null ? null : Math.max(0, Date.now() - oldest_snapshot);
  return {
    complete,
    stale: !complete || age_ms > refresh_ttl_ms,
    age_ms,
    updated_at:
      oldest_snapshot === null ? null : new Date(oldest_snapshot).toISOString(),
    refresh_ttl_ms,
  };
};

const run_sync_script = () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sync_script], {
      cwd: root_directory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Bluesky sync exited with code ${code}`));
        return;
      }
      const json_line = stdout
        .trim()
        .split(/\r?\n/)
        .reverse()
        .find((line) => line.trim().startsWith("{"));
      let result = null;
      if (json_line) {
        try {
          result = JSON.parse(json_line);
        } catch {
          result = null;
        }
      }
      resolve({ result, output: stdout.trim() });
    });
  });

/** Refresh the snapshots once, sharing concurrent callers in this process. */
export const refresh_social_snapshot = async ({ force = false } = {}) => {
  const before = get_social_snapshot_status();
  if (!force && !before.stale) {
    return { ...before, refreshed: false, result: null };
  }
  if (active_refresh) return active_refresh;
  active_refresh = run_sync_script()
    .then(({ result, output }) => ({
      ...get_social_snapshot_status(),
      refreshed: true,
      result,
      output,
    }))
    .finally(() => {
      active_refresh = null;
    });
  return active_refresh;
};
