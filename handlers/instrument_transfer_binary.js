import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  instrument_request,
  local_instrument_connection,
} from "./instrument_transfer_client.js";
import {
  binary_length,
  transfer_deadline,
} from "../../../utils/instrument_transfer_stream.js";
import { transfer_error } from "../../../utils/instrument_transfer.js";

export async function download_instrument_file(
  url,
  { file, headers = {}, signal } = {},
) {
  const deadline = transfer_deadline(signal);
  let response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "error",
      signal: deadline.signal,
    });
    if (!response.ok)
      throw transfer_error(
        response.status === 403 ? "unauthorized" : "peer_unavailable",
        response.status,
      );
    if (
      binary_length(response.headers) !== file.bytes ||
      response.headers.get("etag") !== `"${file.sha256}"`
    )
      throw transfer_error("snapshot_changed");
    const body = Readable.fromWeb(response.body);
    body.on("error", () => {}); // Consumers still observe rejection through async iteration.
    const abort = () => body.destroy(deadline.signal.reason);
    deadline.signal.addEventListener("abort", abort, { once: true });
    return {
      body,
      close: async () => {
        deadline.signal.removeEventListener("abort", abort);
        deadline.close();
        body.destroy();
      },
      touch: deadline.touch,
    };
  } catch (error) {
    deadline.close();
    await response?.body?.cancel().catch(() => {});
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error.code?.startsWith("instrument_transfer_")
      ? error
      : transfer_error("peer_unavailable", 503);
  }
}
export async function upload_instrument_file(
  url,
  { body, file, headers = {}, signal, touch = () => {} } = {},
) {
  const observe_error = () => {};
  body.on?.("error", observe_error);
  body.once?.("close", () => body.off("error", observe_error));
  const deadline = transfer_deadline(signal);
  const abort = () => body.destroy?.(deadline.signal.reason);
  deadline.signal.addEventListener("abort", abort, { once: true });
  async function* chunks() {
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of body) {
      deadline.signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > file.bytes) throw transfer_error("checksum_mismatch", 422);
      hash.update(chunk);
      deadline.touch();
      touch();
      yield chunk;
    }
    if (
      bytes !== file.bytes ||
      (file.sha256 && hash.digest("hex") !== file.sha256)
    )
      throw transfer_error("checksum_mismatch", 422);
  }
  try {
    return await instrument_request(url, {
      method: "PUT",
      stream_body: Readable.from(chunks(), {
        objectMode: false,
        highWaterMark: 64 * 1024,
      }),
      stream_headers: {
        "content-type": "application/octet-stream",
        "content-length": String(file.bytes),
      },
      headers,
      signal: deadline.signal,
    });
  } finally {
    deadline.signal.removeEventListener("abort", abort);
    deadline.close();
    body.destroy?.();
  }
}
export function local_instrument_download(suffix, options, owner) {
  const connection = local_instrument_connection(owner);
  return download_instrument_file(`${connection.url}${suffix}`, {
    ...options,
    headers: connection.headers,
  });
}
export function local_instrument_upload(suffix, options, owner) {
  const connection = local_instrument_connection(owner);
  return upload_instrument_file(`${connection.url}${suffix}`, {
    ...options,
    headers: connection.headers,
  });
}
export function peer_instrument_upload(peer, suffix, options) {
  return upload_instrument_file(
    `${peer.endpoint}/instrument-transfer/peer${suffix}`,
    { ...options, headers: { "x-fracto-sync-token": peer.token } },
  );
}
