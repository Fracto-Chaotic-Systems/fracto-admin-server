import express from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { require_administrator } from "../../../utils/admin_authorization.js";
import { trusted_mutation_origin } from "../../../utils/auth_request_origin.js";
import { read_chat_stream } from "../../../sdk/FractoChatStream.js";
import { write_chat_record } from "../../../utils/chat_stream.js";

const MAX_MESSAGES_BYTES = 8192;
const MAX_RESPONSE_BYTES = 72 * 1024;
const REQUEST_TIMEOUT_MS = 180000;

const exact_fields = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));

const valid_request = (body) =>
  exact_fields(body, ["contract_version", "messages"]) &&
  body.contract_version === 1 &&
  Array.isArray(body.messages) &&
  body.messages.length > 0 &&
  body.messages.length <= 16 &&
  body.messages.every(
    (message) =>
      exact_fields(message, ["role", "content"]) &&
      ["user", "assistant"].includes(message.role) &&
      typeof message.content === "string" &&
      message.content.trim().length > 0,
  ) &&
  body.messages.at(-1).role === "user" &&
  Buffer.byteLength(JSON.stringify(body.messages)) <= MAX_MESSAGES_BYTES;

// The credential is read only after authorization, and never sent to the browser.
const machine_token = async (environment) => {
  const token =
    environment.FRACTO_AI_INFERENCE_TOKEN ??
    (await readFile(
      path.join(
        environment.FRACTO_AI_DATA_DIR ||
          path.resolve(
            import.meta.dirname,
            "../../fracto-ai-server/runtime/inference",
          ),
        "machine-token",
      ),
      "utf8",
    ));
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error("Invalid machine credential");
  return token;
};

const read_response = async (response) => {
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Response too large");
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

/** Browser-facing bridge; AI endpoint implementation is owned by the AI service. */
export const create_chat_router = ({
  authorize = require_administrator,
  environment = process.env,
  fetch_ai = fetch,
  get_token = () => machine_token(environment),
  timeout_ms = REQUEST_TIMEOUT_MS,
} = {}) => {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use((req, res, next) => {
    const lab_chat =
      environment.FRACTO_ADMIN_CHAT_LAB_BYPASS === "true" &&
      environment.FRACTO_AUTH_MODE === "none" &&
      environment.FRACTO_AUTH_REQUIRED !== "true" &&
      req.method === "POST" &&
      req.path === "/";
    if (lab_chat) {
      if (trusted_mutation_origin(req, res)) next();
      return;
    }
    return authorize(req, res, next);
  });
  router.post(
    "/",
    express.json({ limit: 16 * 1024, strict: true, inflate: false }),
    async (req, res) => {
      if (Object.keys(req.query).length || !valid_request(req.body))
        return res.status(400).json({ error: "INVALID_CHAT_REQUEST" });

      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.on("aborted", disconnect);
      res.on("close", disconnect);
      const timeout = setTimeout(() => controller.abort(), timeout_ms);
      const streaming = req.get("accept") === "application/x-ndjson";
      try {
        const port = String(environment.FRACTO_AI_PORT || 3007);
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
          throw new Error("Invalid AI port");
        const token = await get_token();
        if (!/^[a-f0-9]{64}$/.test(token))
          throw new Error("Invalid machine credential");
        const response = await fetch_ai(
          `http://127.0.0.1:${port}/inference/chat`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              "X-Fracto-AI-Token": token,
              ...(streaming ? { Accept: "application/x-ndjson" } : {}),
            },
            body: JSON.stringify(req.body),
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          let upstream_error;
          try {
            upstream_error = (await read_response(response)).error;
          } catch {}
          const errors = {
            400: [400, "INVALID_CHAT_REQUEST"],
            413: [413, "CHAT_REQUEST_TOO_LARGE"],
            429: [429, "CHAT_BUSY"],
            504: [504, "CHAT_TIMEOUT"],
          };
          const admission_errors = {
            MEMORY_PRESSURE: "CHAT_MEMORY_PRESSURE",
            DISK_PRESSURE: "CHAT_DISK_PRESSURE",
            MODEL_MISSING: "CHAT_MODEL_MISSING",
          };
          const [status, error] =
            response.status === 503 && admission_errors[upstream_error]
              ? [503, admission_errors[upstream_error]]
              : errors[response.status] || [503, "CHAT_UNAVAILABLE"];
          if (!res.destroyed) res.status(status).json({ error });
          return;
        }
        if (streaming) {
          if (
            !response.headers
              .get("content-type")
              ?.includes("application/x-ndjson")
          ) {
            await response.body?.cancel();
            throw new Error("Invalid stream");
          }
          // Hold the terminal marker until EOF verifies that no trailing data exists.
          for await (const record of read_chat_stream(response.body, {
            signal: controller.signal,
          })) {
            if (record.type === "delta")
              await write_chat_record(res, record, controller.signal);
          }
          await write_chat_record(
            res,
            { contract_version: 1, type: "done" },
            controller.signal,
          );
          res.end();
          return;
        }
        const result = await read_response(response);
        if (
          result.contract_version !== 1 ||
          result.message?.role !== "assistant" ||
          typeof result.message.content !== "string" ||
          !result.message.content.trim() ||
          Buffer.byteLength(result.message.content) > 64 * 1024
        )
          throw new Error("Invalid AI response");
        if (!res.destroyed)
          res.json({
            contract_version: 1,
            message: { role: "assistant", content: result.message.content },
          });
      } catch {
        if (res.headersSent) {
          if (!res.destroyed) {
            res.end(
              `${JSON.stringify({
                contract_version: 1,
                type: "error",
                error: controller.signal.aborted
                  ? "CHAT_TIMEOUT"
                  : "CHAT_UNAVAILABLE",
              })}\n`,
            );
          }
          controller.abort();
          return;
        }
        if (!res.destroyed)
          res.status(controller.signal.aborted ? 504 : 503).json({
            error: controller.signal.aborted
              ? "CHAT_TIMEOUT"
              : "CHAT_UNAVAILABLE",
          });
      } finally {
        clearTimeout(timeout);
        req.off("aborted", disconnect);
        res.off("close", disconnect);
      }
    },
  );
  router.use((error, _req, res, _next) => {
    const status =
      error.type === "entity.too.large"
        ? 413
        : error.status === 400 || error.status === 415
          ? error.status
          : 503;
    res.status(status).json({
      error:
        status === 413
          ? "CHAT_REQUEST_TOO_LARGE"
          : status === 503
            ? "CHAT_UNAVAILABLE"
            : "INVALID_CHAT_REQUEST",
    });
  });
  return router;
};
