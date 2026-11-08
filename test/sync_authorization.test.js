import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import {
  create_sync_authorizer,
  is_lab_sync_request,
} from "../handlers/sync_authorization.js";

const env = {
  FRACTO_ADMIN_SYNC_LAB_BYPASS: "true",
  FRACTO_AUTH_MODE: "none",
  FRACTO_AUTH_REQUIRED: "false",
  FRACTO_UI_ORIGIN: "http://localhost:3106",
};
const id = "00000000-0000-4000-8000-000000000001";
test("lab sync is opt-in, unavailable in authenticated mode, and restricted to sync routes", () => {
  const req = { method: "POST", path: "/database-sync/jobs" };
  assert.equal(is_lab_sync_request(req, env), true);
  assert.equal(
    is_lab_sync_request(req, { ...env, FRACTO_ADMIN_SYNC_LAB_BYPASS: "false" }),
    false,
  );
  assert.equal(
    is_lab_sync_request(req, { ...env, FRACTO_AUTH_MODE: "oidc" }),
    false,
  );
  assert.equal(
    is_lab_sync_request(req, { ...env, FRACTO_AUTH_REQUIRED: "true" }),
    false,
  );
  for (const path of [
    "/users",
    "/database-sync/peer/sessions",
    "/mesh-sync/peer/sessions",
    "/query",
    `/database-sync/jobs/${id}/cancel`,
  ])
    assert.equal(is_lab_sync_request({ ...req, path }, env), false);
  assert.equal(
    is_lab_sync_request(
      { method: "POST", baseUrl: "/mesh-sync", path: `/jobs/${id}/apply` },
      env,
    ),
    true,
  );
  assert.equal(
    is_lab_sync_request(
      { method: "DELETE", path: `/mesh-sync/jobs/${id}` },
      env,
    ),
    false,
  );
});

test("lab preview and apply require the exact browser origin, including same-origin GET referrers", async () => {
  const app = express();
  let fallback = 0;
  const authorize = create_sync_authorizer({
    env,
    administrator: (_req, res) => {
      fallback++;
      res.status(401).json({ error: "admin required" });
    },
  });
  for (const prefix of ["/database-sync", "/mesh-sync"]) {
    const router = express.Router();
    router.get("/peers", (_req, res) => res.json({ ok: true }));
    router.post("/jobs", (_req, res) => res.json({ ok: true }));
    router.post("/jobs/:id/apply", (_req, res) => res.json({ ok: true }));
    router.post("/peer/sessions", (_req, res) => res.json({ ok: true }));
    app.use(prefix, authorize, router);
  }
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const prefix of ["/database-sync", "/mesh-sync"]) {
      assert.equal(
        (
          await fetch(base + prefix + "/peers", {
            headers: { origin: env.FRACTO_UI_ORIGIN },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(base + prefix + "/peers", {
            headers: { referer: env.FRACTO_UI_ORIGIN + "/admin" },
          })
        ).status,
        200,
      );
      assert.equal((await fetch(base + prefix + "/peers")).status, 403);
      assert.equal(
        (
          await fetch(base + prefix + "/jobs", {
            method: "POST",
            headers: { origin: env.FRACTO_UI_ORIGIN },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(base + prefix + `/jobs/${id}/apply`, {
            method: "POST",
            headers: { origin: "http://untrusted.example" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(base + prefix + "/peer/sessions", {
            method: "POST",
            headers: { origin: env.FRACTO_UI_ORIGIN },
          })
        ).status,
        401,
      );
    }
    assert.equal(fallback, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
