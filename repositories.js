import path from "node:path";
import { fileURLToPath } from "node:url";

const admin_directory = path.dirname(fileURLToPath(import.meta.url));
const root_directory = path.resolve(admin_directory, "..", "..");
const service_names = [
  "fracto-admin-server",
  "fracto-asset-server",
  "fracto-data-server",
  "fracto-tiles-server",
  "fracto-ui",
];

/** Fixed Git repositories that the Admin server may inspect. */
export const REPOSITORY_PATHS = Object.freeze([
  Object.freeze({ name: "fracto", directory: root_directory }),
  ...service_names.map((name) => Object.freeze({
    name,
    directory: path.join(root_directory, "servers", name),
  })),
]);
