import fs from "node:fs";
import path from "node:path";

const SERVICE_ENV = {
  main: "FRACTO_SERVER_PORT",
  data: "FRACTO_DATA_PORT",
  asset: "FRACTO_ASSET_PORT",
  tiles: "FRACTO_TILES_PORT",
  admin: "FRACTO_ADMIN_PORT",
  ui: "FRACTO_UI_PORT",
};

const DEFAULT_PORTS = {
  main: 3001,
  data: 3002,
  asset: 3003,
  tiles: 3004,
  admin: 3005,
  ui: 3006,
};

const ports_file = process.env.FRACTO_PORTS_FILE ||
  path.join(import.meta.dirname, "..", "runtime", "ports.json");

const read_configured_ports = () => {
  let configured = {};
  if (fs.existsSync(ports_file)) {
    configured = JSON.parse(fs.readFileSync(ports_file, "utf8"));
  }
  const source = configured.ports || configured;
  const ports = Object.fromEntries(Object.entries(SERVICE_ENV).map(([name, env]) => [
    name,
    Number(process.env[env] ?? source[name] ?? DEFAULT_PORTS[name]),
  ]));
  const invalid = Object.entries(ports).filter(([, value]) => !Number.isInteger(value) || value < 1 || value > 65535);
  const values = Object.values(ports);
  if (invalid.length || new Set(values).size !== values.length) {
    throw new Error(`Invalid or duplicate service ports in ${ports_file}`);
  }
  return ports;
};

export const get_ports = () => ({
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source: ports_file,
  ports: read_configured_ports(),
});

export const handle_ports = (req, res) => {
  try {
    res.json(get_ports());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
