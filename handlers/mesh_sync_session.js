/** Inventory reconciliation may outlast HTTP/proxy timeouts. Reserve quickly,
 * then poll bounded status requests while the tiles service owns the scan. */
export async function acquire_mesh_session(
  send,
  on_progress = () => {},
  {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    timeout_ms = 60 * 60 * 1000,
  } = {},
) {
  let opened;
  const started = now();
  try {
    try {
      opened = await send("/sessions/start");
    } catch (error) {
      // Older peers still work for inventories that fit their request timeout.
      if (
        error.status === 404 ||
        (error.status === 403 && error.code === "Untrusted request origin")
      )
        return await send("/sessions");
      throw error;
    }
    if (!opened?.id)
      throw Object.assign(new Error("mesh_catalog_incompatible"), {
        code: "mesh_catalog_incompatible",
        status: 409,
      });
    while (now() - started < timeout_ms) {
      const state = await send(`/sessions/${opened.id}/status`);
      on_progress({ files_checked: Number(state.files_checked) || 0 });
      if (state.status === "ready")
        return { id: opened.id, catalog: state.catalog };
      if (state.status === "failed")
        throw Object.assign(
          new Error(state.error || "mesh_sync_storage_failed"),
          { code: state.error || "mesh_sync_storage_failed", status: 503 },
        );
      if (state.status !== "checking")
        throw Object.assign(new Error("mesh_catalog_incompatible"), {
          code: "mesh_catalog_incompatible",
          status: 409,
        });
      await sleep(1000);
    }
    throw Object.assign(new Error("mesh_inventory_timeout"), {
      code: "mesh_inventory_timeout",
      status: 504,
    });
  } catch (error) {
    if (opened?.id) await send(`/sessions/${opened.id}/close`).catch(() => {});
    throw error;
  }
}
