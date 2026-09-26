const DATA_PORT = Number(process.env.FRACTO_DATA_PORT || 3002);
import { require_administrator } from "../../../utils/admin_authorization.js";

const forward = async (req, res, pathname, options = {}) => {
  let authorized = false;
  await require_administrator(req, res, () => { authorized = true; });
  if (!authorized) return;
  try {
    const response = await fetch(`http://127.0.0.1:${DATA_PORT}${pathname}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        cookie: req.headers.cookie || "",
        ...(req.headers.origin ? { origin: req.headers.origin } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    res.status(response.status).json(body);
  } catch (error) {
    res.status(502).json({ error: `Data service unavailable: ${error.message}` });
  }
};

/** List users for the administrator workflow. */
export const handle_users = (req, res) => forward(req, res, "/users");

/** Enable or disable one allowlisted user. */
export const handle_user_update = (req, res) =>
  forward(req, res, `/user/${encodeURIComponent(req.params.id)}`, {
    method: "PUT",
    body: JSON.stringify({ enabled: req.body?.enabled }),
  });

/** List recent authentication audit events. */
export const handle_login_events = (req, res) =>
  forward(req, res, `/login_events?limit=${encodeURIComponent(req.query.limit || 100)}`);
