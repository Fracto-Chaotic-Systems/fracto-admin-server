import express from "express";
import { configured_peers, require_sync_peer } from "./database_sync.js";
import { create_sync_authorizer } from "./sync_authorization.js";
import { local_instrument_request } from "./instrument_transfer_client.js";
import { InstrumentTransferJobs } from "./instrument_transfer_jobs.js";
import { local_instrument_upload } from "./instrument_transfer_binary.js";
import { binary_length } from "../../../utils/instrument_transfer_stream.js";
import {
  exact_fields,
  version_body,
  public_transfer_error,
  transfer_error,
  TRANSFER_LIMITS,
} from "../../../utils/instrument_transfer.js";

const safe = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
const errors = (error, _req, res, _next) => {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const normalized =
    error.type === "entity.too.large"
      ? transfer_error("limit_exceeded", 413)
      : error.type?.startsWith("entity.") || error.status === 415
        ? transfer_error("invalid_request", 400)
        : error;
  res
    .status(normalized.status || 503)
    .json({ error: public_transfer_error(normalized) });
};
const no_cache = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};
export function create_instrument_peer_router({
  peers = () => configured_peers(),
  local = local_instrument_request,
  upload = local_instrument_upload,
} = {}) {
  const router = express.Router();
  router.use(no_cache, require_sync_peer(peers));
  router.use("/sessions/:id", (req, _res, next) => {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(req.params.id))
      return next(transfer_error("invalid_request", 400));
    next();
  });
  router.get(
    "/capabilities",
    safe(async (req, res) =>
      res.json(await local("/capabilities", {}, req.sync_owner)),
    ),
  );
  for (const action of ["prepare", "stage", "finalize"])
    router.post(
      `/sessions/:id/${action}`,
      express.json({ limit: TRANSFER_LIMITS.control_bytes, inflate: false }),
      safe(async (req, res) => {
        res
          .status(202)
          .json(
            await local(
              `/sessions/${req.params.id}/${action}`,
              { method: "POST", body: req.body },
              req.sync_owner,
            ),
          );
      }),
    );
  router.put(
    "/sessions/:id/files/:file_id",
    safe(async (req, res) => {
      if (!/^[a-f0-9]{64}$/.test(req.params.file_id))
        throw transfer_error("invalid_request", 400);
      const controller = new AbortController();
      const abort = () => {
        if (!res.writableFinished)
          controller.abort(transfer_error("cancelled", 503));
      };
      req.once("aborted", abort);
      res.once("close", abort);
      try {
        res.json(
          await upload(
            `/sessions/${req.params.id}/files/${req.params.file_id}`,
            {
              body: req,
              file: { bytes: binary_length(req.headers) },
              signal: controller.signal,
            },
            req.sync_owner,
          ),
        );
      } finally {
        req.off("aborted", abort);
        res.off("close", abort);
      }
    }),
  );
  router.post(
    "/sessions",
    express.json({
      limit: TRANSFER_LIMITS.preview_request_bytes,
      inflate: false,
    }),
    safe(async (req, res) => {
      exact_fields(req.body, [
        "protocol_version",
        "manifest",
        "catalog_text",
        ...(Object.hasOwn(req.body ?? {}, "replacement_policy")
          ? ["replacement_policy"]
          : []),
      ]);
      if (
        req.body.replacement_policy !== undefined &&
        req.body.replacement_policy !== "source"
      )
        throw transfer_error("invalid_request", 400);
      res
        .status(202)
        .json(
          await local(
            "/sessions",
            { method: "POST", body: req.body },
            req.sync_owner,
          ),
        );
    }),
  );
  router.get(
    "/sessions/:id",
    safe(async (req, res) =>
      res.json(await local(`/sessions/${req.params.id}`, {}, req.sync_owner)),
    ),
  );
  router.post(
    "/sessions/:id/cancel",
    express.json({ limit: TRANSFER_LIMITS.control_bytes, inflate: false }),
    safe(async (req, res) => {
      version_body(req.body);
      res
        .status(202)
        .json(
          await local(
            `/sessions/${req.params.id}/cancel`,
            { method: "POST", body: req.body },
            req.sync_owner,
          ),
        );
    }),
  );
  router.use(errors);
  return router;
}
export function create_instrument_transfer_router({
  peers = () => configured_peers(),
  jobs = new InstrumentTransferJobs({ peers }),
  authorize = create_sync_authorizer(),
} = {}) {
  const router = express.Router();
  router.use(no_cache, authorize);
  router.get(
    "/peers",
    safe(async (_req, res) =>
      res.json({
        protocol_version: 1,
        peers: [...peers().keys()].map((peer) => ({
          peer,
          capability_status: "unchecked",
        })),
      }),
    ),
  );
  router.post(
    "/jobs",
    express.json({ limit: TRANSFER_LIMITS.control_bytes, inflate: false }),
    safe(async (req, res) => {
      exact_fields(req.body, ["protocol_version", "peer"]);
      if (req.body.protocol_version !== 1)
        throw transfer_error("upgrade_required");
      res.status(202).json(jobs.status(jobs.start(req.body.peer)));
    }),
  );
  router.get(
    "/jobs/:id",
    safe(async (req, res) => res.json(jobs.status(jobs.get(req.params.id)))),
  );
  router.post(
    "/jobs/:id/apply",
    express.json({ limit: TRANSFER_LIMITS.control_bytes, inflate: false }),
    safe(async (req, res) => {
      exact_fields(req.body, ["protocol_version", "plan_sha256"]);
      if (req.body.protocol_version !== 1)
        throw transfer_error("upgrade_required");
      res
        .status(202)
        .json(
          jobs.status(
            jobs.apply(jobs.get(req.params.id), req.body.plan_sha256),
          ),
        );
    }),
  );
  router.post(
    "/jobs/:id/cancel",
    express.json({ limit: TRANSFER_LIMITS.control_bytes, inflate: false }),
    safe(async (req, res) => {
      version_body(req.body);
      const job = jobs.get(req.params.id);
      await jobs.cancel(job);
      res.status(202).json(jobs.status(job));
    }),
  );
  router.use(errors);
  return router;
}
