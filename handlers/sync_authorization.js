import { require_administrator } from "../../../utils/admin_authorization.js";

/** Separate, explicit write access for isolated labs. The read-only bypass is
 * deliberately unchanged, and peer exchange still requires its own secret. */
export function is_lab_sync_request(req, env = process.env) {
  if (
    env.FRACTO_ADMIN_SYNC_LAB_BYPASS !== "true" ||
    env.FRACTO_AUTH_MODE !== "none" ||
    env.FRACTO_AUTH_REQUIRED === "true"
  )
    return false;
  const path = `${req.baseUrl || ""}${req.path}`;
  const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
  if (req.method === "GET")
    return new RegExp(
      `^/(database-sync|mesh-sync)/(peers|jobs/${uuid})$`,
      "i",
    ).test(path);
  if (req.method === "POST")
    return new RegExp(
      `^/(database-sync|mesh-sync)/jobs(?:/${uuid}/apply)?$`,
      "i",
    ).test(path);
  return false;
}

export function create_sync_authorizer({
  env = process.env,
  administrator = require_administrator,
} = {}) {
  return (req, res, next) => {
    if (!is_lab_sync_request(req, env)) return administrator(req, res, next);
    const expected =
      env.FRACTO_UI_ORIGIN || `http://localhost:${env.FRACTO_UI_PORT || 3006}`;
    let origin = req.headers.origin;
    // Same-origin GET fetches may omit Origin, but retain a browser Referer.
    if (!origin && req.method === "GET" && req.headers.referer) {
      try {
        origin = new URL(req.headers.referer).origin;
      } catch {
        /* Deny malformed referrers. */
      }
    }
    if (origin !== expected)
      return res.status(403).json({ error: "Untrusted request origin" });
    next();
  };
}
