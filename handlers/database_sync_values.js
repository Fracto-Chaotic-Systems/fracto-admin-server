/** Read numeric lexemes without converting large JSON integers to JS numbers. */
export function json_numbers(source) {
  const result = new Map();
  let offset = 0;
  const whitespace = () => {
    while (/\s/.test(source[offset] || "") && offset < source.length) offset++;
  };
  const string = () => {
    const start = offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === "\\") offset++;
      else if (character === '"')
        return JSON.parse(source.slice(start, offset));
    }
    throw new Error("Invalid JSON string");
  };
  const value = (path) => {
    whitespace();
    if (source[offset] === "{") {
      offset++;
      whitespace();
      if (source[offset] === "}") {
        offset++;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        whitespace();
        if (source[offset++] !== ":") throw new Error("Invalid JSON object");
        value(`${path}.${JSON.stringify(key)}`);
        whitespace();
        if (source[offset++] === "}") return;
        if (source[offset - 1] !== ",") throw new Error("Invalid JSON object");
      }
    }
    if (source[offset] === "[") {
      offset++;
      whitespace();
      if (source[offset] === "]") {
        offset++;
        return;
      }
      let index = 0;
      while (true) {
        value(`${path}[${index++}]`);
        whitespace();
        if (source[offset++] === "]") return;
        if (source[offset - 1] !== ",") throw new Error("Invalid JSON array");
      }
    }
    if (source[offset] === '"') {
      string();
      return;
    }
    const token =
      /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
        source.slice(offset),
      )?.[0];
    if (!token) throw new Error("Invalid JSON value");
    offset += token.length;
    if (/^[\d-]/.test(token)) result.set(path, token);
  };
  value("$");
  whitespace();
  if (offset !== source.length) throw new Error("Invalid JSON document");
  return result;
}

const precision_error = () =>
  Object.assign(new Error("sync_json_precision_unsupported"), {
    code: "sync_json_precision_unsupported",
    status: 409,
  });

/** MySQL's JSON text parser can round doubles differently from its binary
 * protocol. Repair only changed numeric paths with binary double parameters
 * (or exact DECIMAL casts), and require byte-identical JSON before insertion.
 * The original text, including large integer lexemes, is never JSON.parse'd. */
export async function json_insert_value(db, source) {
  if (source === null) return { sql: "?", parameters: [null] };
  const read = async (value) => {
    const [[row]] = await db.execute(
      `SELECT ${value.sql} AS value`,
      value.parameters,
    );
    return row.value;
  };
  const original = { sql: "CAST(? AS JSON)", parameters: [source] };
  const parsed = await read(original);
  if (parsed === source) return original;
  const expected = json_numbers(source),
    actual = json_numbers(parsed);
  const changed = [...expected].filter(
    ([path, token]) => actual.get(path) !== token,
  );
  if (!changed.length || changed.length > 1000) throw precision_error();
  const patches = new Map(
    changed.map(([path, token]) => [
      path,
      { sql: "?", parameters: [Number(token)] },
    ]),
  );
  const expression = () => ({
    sql: `JSON_SET(CAST(? AS JSON), ${[...patches.values()].map((v) => `?, ${v.sql}`).join(", ")})`,
    parameters: [
      source,
      ...[...patches].flatMap(([path, v]) => [path, ...v.parameters]),
    ],
  });
  let candidate = expression();
  let repaired = await read(candidate);
  if (repaired === source) return candidate;
  const remaining = json_numbers(repaired);
  for (const [path, token] of changed) {
    if (remaining.get(path) === token) continue;
    if (!/^-?\d+(?:\.\d+)?$/.test(token)) throw precision_error();
    const scale = token.split(".")[1]?.length || 0;
    if (scale > 30 || token.replace(/[-.]/g, "").length > 65)
      throw precision_error();
    patches.set(path, {
      sql: `CAST(? AS DECIMAL(65,${scale}))`,
      parameters: [token],
    });
  }
  candidate = expression();
  if ((await read(candidate)) !== source) throw precision_error();
  return candidate;
}
