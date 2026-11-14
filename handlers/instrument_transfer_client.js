import { internal_service_headers } from "../../../utils/service_authorization.js";
import {
  transfer_hash,
  transfer_error,
  public_transfer_error,
  TRANSFER_LIMITS,
} from "../../../utils/instrument_transfer.js";

const LOCAL_OWNER = transfer_hash("instrument-transfer-local-admin");
export async function instrument_request(
  url,
  {
    method = "GET",
    body,
    headers = {},
    signal,
    max_bytes = TRANSFER_LIMITS.control_bytes,
    raw = false,
    fetcher = fetch,
    stream_body,
    stream_headers,
  } = {},
) {
  let response;
  try {
    const payload =
      stream_body ?? (body === undefined ? undefined : JSON.stringify(body));
    if (
      !stream_body &&
      payload &&
      Buffer.byteLength(payload) > TRANSFER_LIMITS.preview_request_bytes
    )
      throw transfer_error("limit_exceeded", 413);
    response = await fetcher(url, {
      method,
      body: payload,
      headers: {
        ...headers,
        ...(stream_body
          ? stream_headers
          : payload
            ? { "content-type": "application/json" }
            : {}),
      },
      redirect: "error",
      ...(stream_body ? { duplex: "half" } : {}),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(
          stream_body ? TRANSFER_LIMITS.file_seconds * 1000 : 30000,
        ),
      ]),
    });
    if (Number(response.headers.get("content-length")) > max_bytes) {
      await response.body?.cancel();
      throw transfer_error("limit_exceeded", 413);
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > max_bytes) throw transfer_error("limit_exceeded", 413);
      chunks.push(chunk);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const legacy = response.status === 404 || response.ok;
      throw transfer_error(
        legacy ? "upgrade_required" : "peer_unavailable",
        legacy ? 409 : 503,
      );
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status))
        throw transfer_error("unauthorized", response.status);
      if (
        response.status === 404 &&
        !data.error?.code?.startsWith("instrument_transfer_")
      )
        throw transfer_error("upgrade_required");
      const error = new Error();
      error.code = data.error?.code;
      const safe = public_transfer_error(error);
      throw Object.assign(new Error(safe.code), {
        code: safe.code,
        status: response.status === 403 ? 403 : response.status,
      });
    }
    return raw ? text : data;
  } catch (error) {
    if (signal?.aborted)
      throw signal.reason?.code?.startsWith("instrument_transfer_")
        ? signal.reason
        : transfer_error("cancelled", 503);
    if (error.code?.startsWith("instrument_transfer_")) throw error;
    throw transfer_error(
      error.name === "TimeoutError" ? "timeout" : "peer_unavailable",
      503,
    );
  }
}
export function local_instrument_request(
  suffix,
  options = {},
  owner = LOCAL_OWNER,
) {
  const connection = local_instrument_connection(owner);
  return instrument_request(`${connection.url}${suffix}`, {
    ...options,
    headers: connection.headers,
  });
}
export function local_instrument_connection(owner = LOCAL_OWNER) {
  if (!process.env.FRACTO_INTERNAL_SERVICE_TOKEN)
    throw transfer_error("storage_not_ready", 503);
  return {
    url: `http://127.0.0.1:${Number(process.env.FRACTO_ASSET_PORT || 3003)}/internal/instrument-transfer`,
    headers: internal_service_headers({ "x-fracto-transfer-owner": owner }),
  };
}
export function peer_instrument_request(peer, suffix, options = {}) {
  return instrument_request(
    `${peer.endpoint}/instrument-transfer/peer${suffix}`,
    { ...options, headers: { "x-fracto-sync-token": peer.token } },
  );
}
