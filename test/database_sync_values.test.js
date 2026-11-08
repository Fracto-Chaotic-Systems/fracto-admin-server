import test from "node:test";
import assert from "node:assert/strict";
import { json_numbers } from "../handlers/database_sync_values.js";

test("JSON numeric paths preserve large integer and decimal lexemes through nested arrays and escaped property names", () => {
  const numbers = json_numbers(
    '{"a.b":[9007199254740993,{"x\\\"y":4.449557262054372e-16}],"decimal":0.12345678901234567890,"text":"123","null":null}',
  );
  assert.deepEqual(
    [...numbers],
    [
      ["$." + '"a.b"[0]', "9007199254740993"],
      ["$." + '"a.b"[1]."x\\\"y"', "4.449557262054372e-16"],
      ['$."decimal"', "0.12345678901234567890"],
    ],
  );
  assert.deepEqual([...json_numbers("-0.0")], [["$", "-0.0"]]);
  assert.equal(json_numbers('[true,false,null,"0",{},[]]').size, 0);
});
