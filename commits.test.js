import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { load_commit_snapshot } from "./handlers/commits.js";

test("a missing packaged commit snapshot produces an empty snapshot", () => {
  const missing_path = path.join(os.tmpdir(), `fracto-build-info-${randomUUID()}.json`);
  assert.deepEqual(load_commit_snapshot(missing_path), {
    commits: [],
    tag_records: [],
    tag_events: [],
  });
});
