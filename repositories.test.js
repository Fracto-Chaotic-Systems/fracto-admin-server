import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPOSITORY_PATHS } from "./repositories.js";

test("Admin Git inspection uses the fixed root and service repository allowlist", () => {
  const test_directory = path.dirname(fileURLToPath(import.meta.url));
  const expected_root = path.resolve(test_directory, "..", "..");
  const expected_services = [
    "fracto-admin-server",
    "fracto-asset-server",
    "fracto-data-server",
    "fracto-tiles-server",
    "fracto-ui",
  ];

  assert.deepEqual(
    REPOSITORY_PATHS.map((repository) => repository.name),
    ["fracto", ...expected_services],
  );
  assert.equal(REPOSITORY_PATHS[0].directory, expected_root);
  expected_services.forEach((name, index) => {
    assert.equal(
      REPOSITORY_PATHS[index + 1].directory,
      path.join(expected_root, "servers", name),
    );
  });
});
