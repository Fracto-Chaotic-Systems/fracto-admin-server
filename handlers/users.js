const DATA_PORT = Number(process.env.FRACTO_DATA_PORT || 3002);
const MAIN_PORT = Number(process.env.FRACTO_SERVER_PORT || 3001);

const authorize_admin = async (req, res) => {
  const response = await fetch(`http://127.0.0.1:${MAIN_PORT}/auth/session`, {
    headers: { cookie: req.headers.cookie || "" },
  });
  const session = await response.json().catch(() => ({}));
  if (
    !session.authenticated ||
    session.auth_state !== "authenticated" ||
    session.user?.enabled !== true && Number(session.user?.enabled) !== 1
  ) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  if (session.user?.role !== "admin") {
    res.status(403).json({ error: "Administrator access required" });
    return false;
  }
  return true;
};

const forward = async (req, res, pathname, options = {}) => {
  if (!(await authorize_admin(req, res))) return;
  try {
    const response = await fetch(`http://127.0.0.1:${DATA_PORT}${pathname}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
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
