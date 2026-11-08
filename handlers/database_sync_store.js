import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonical_migration_history } from "../../../utils/migration_checksums.js";
import { json_insert_value } from "./database_sync_values.js";

export const EXCLUDED_TABLES = ["tiles", "automation"];
export const MAX_BYTES = 512 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 480 * 1024 * 1024;
export const sync_error = (code, status = 409) =>
  Object.assign(new Error(code), { code, status });
export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const qi = (name) => {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw sync_error("unsupported_identifier");
  return `\`${name}\``;
};
const encode = (v) => (Buffer.isBuffer(v) ? { hex: v.toString("hex") } : v);
const decode = (v) =>
  v && typeof v === "object" && typeof v.hex === "string"
    ? Buffer.from(v.hex, "hex")
    : v;
const writable = (table) =>
  table.columns.filter(
    (c) => !/VIRTUAL GENERATED|STORED GENERATED/i.test(c.Extra),
  );
const temp_name = (index) => `fracto_sync_${index}`;
const row_key = (table, row) =>
  JSON.stringify(
    table.primary.map(
      (name) => row[table.columns.findIndex((c) => c.Field === name)],
    ),
  );

export const snapshot_digest = (snapshot) => {
  const hash = createHash("sha256");
  const append = (value) => {
    hash.update(String(Buffer.byteLength(value)) + ":");
    hash.update(value);
  };
  append(JSON.stringify(snapshot.manifest));
  for (const table of snapshot.manifest.tables) {
    append(table.name);
    // Hash rows incrementally instead of serializing an escaped copy of the
    // entire database into one giant JavaScript string.
    const rows = snapshot.tables[table.name]
      .map((row) => JSON.stringify(row))
      .sort();
    append(String(rows.length));
    for (const row of rows) append(row);
  }
  return hash.digest("hex");
};
const row_bytes = (rows) =>
  rows.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row)) + 1, 2);
const assert_snapshot_budget = (snapshot) => {
  let bytes = Buffer.byteLength(JSON.stringify(snapshot.manifest)),
    count = 0;
  for (const table of snapshot.manifest.tables) {
    const rows = snapshot.tables[table.name];
    count += rows.length;
    bytes += row_bytes(rows);
    if (count > 250000 || bytes > MAX_SNAPSHOT_BYTES)
      throw sync_error("sync_snapshot_limit", 413);
  }
};

export async function open_sync_database() {
  const config = JSON.parse(
    await readFile(
      new URL("../../../config/mysql.json", import.meta.url),
      "utf8",
    ),
  );
  const { default: mysql } = await import("mysql2/promise");
  const db = await mysql.createConnection({
    ...config,
    host: process.env.FRACTO_MYSQL_HOST || config.host,
    port: Number(process.env.FRACTO_MYSQL_PORT || config.port || 3306),
    database: process.env.FRACTO_MYSQL_DATABASE || config.database,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    jsonStrings: true,
    multipleStatements: false,
    connectTimeout: 15000,
  });
  return db;
}

export async function read_manifest(db) {
  const [names] = await db.query(
    "SELECT TABLE_NAME AS name,ENGINE AS engine,TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME",
  );
  const included = names.filter((t) => !EXCLUDED_TABLES.includes(t.name));
  if (!included.some((t) => t.name === "fracto_schema_migrations"))
    throw sync_error("migrations_not_installed");
  const [migrations] = await db.query(
    "SELECT version,checksum FROM fracto_schema_migrations ORDER BY version",
  );
  if (!migrations.length) throw sync_error("migrations_not_installed");
  const [triggers] = await db.query(
    "SELECT EVENT_OBJECT_TABLE AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()",
  );
  if (triggers.some((t) => included.some((n) => n.name === t.name)))
    throw sync_error("sync_tables_have_triggers");
  const [boundaries] = await db.query(
    "SELECT TABLE_NAME AS child,REFERENCED_TABLE_NAME AS parent FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL",
  );
  if (
    boundaries.some(
      (f) =>
        EXCLUDED_TABLES.includes(f.child) !==
        EXCLUDED_TABLES.includes(f.parent),
    )
  )
    throw sync_error("foreign_key_to_excluded_table");
  const [external] = await db.query(
    "SELECT 1 FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA<>DATABASE() LIMIT 1",
  );
  if (external.length) throw sync_error("cross_database_foreign_key");
  const tables = [];
  for (const t of included) {
    if (t.engine !== "InnoDB" || t.type !== "BASE TABLE")
      throw sync_error("sync_requires_innodb_tables");
    const [[create]] = await db.query(`SHOW CREATE TABLE ${qi(t.name)}`);
    const [columns] = await db.query(`SHOW FULL COLUMNS FROM ${qi(t.name)}`);
    const [indexes] = await db.query(`SHOW INDEX FROM ${qi(t.name)}`);
    const unique = new Map();
    for (const i of indexes.filter((i) => Number(i.Non_unique) === 0)) {
      if (!i.Column_name)
        throw sync_error("unsupported_functional_unique_index");
      const list = unique.get(i.Key_name) || [];
      list.push({
        name: i.Column_name,
        prefix: i.Sub_part || null,
        order: Number(i.Seq_in_index),
      });
      unique.set(i.Key_name, list);
    }
    if (!unique.has("PRIMARY")) throw sync_error("sync_requires_primary_keys");
    const [foreign] = await db.execute(
      "SELECT CONSTRAINT_NAME AS name,COLUMN_NAME AS column_name,REFERENCED_TABLE_NAME AS parent,REFERENCED_COLUMN_NAME AS parent_column,ORDINAL_POSITION AS position FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION",
      [t.name],
    );
    tables.push({
      name: t.name,
      ddl: create["Create Table"].replace(/ AUTO_INCREMENT=\d+/g, ""),
      columns: columns.map(
        ({ Field, Type, Collation, Null, Default, Extra }) => ({
          Field,
          Type,
          Collation,
          Null,
          Default: encode(Default),
          Extra,
        }),
      ),
      unique: [...unique.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, columns]) => ({
          name,
          columns: columns.sort((a, b) => a.order - b.order),
        })),
      primary: unique
        .get("PRIMARY")
        .sort((a, b) => a.order - b.order)
        .map((i) => i.name),
      foreign,
    });
  }
  return {
    version: 4,
    migrations: canonical_migration_history(migrations),
    tables,
  };
}

export function assert_compatible(a, b) {
  if (a.version !== b.version) throw sync_error("sync_protocol_mismatch");
  const left = { ...a, migrations: canonical_migration_history(a.migrations) };
  const right = { ...b, migrations: canonical_migration_history(b.migrations) };
  if (digest(left.migrations) !== digest(right.migrations))
    throw sync_error("migration_version_mismatch");
  if (digest(left) !== digest(right))
    throw sync_error("table_definitions_mismatch");
}

async function insert_rows(db, name, table, rows) {
  const columns = writable(table),
    indices = columns.map((c) => table.columns.indexOf(c));
  let batch = [],
    bytes = 0,
    parameter_count = 0;
  const flush = async () => {
    if (!batch.length) return;
    const placeholders = batch
      .map((row) => `(${row.map((value) => value.sql).join(",")})`)
      .join(",");
    await db.execute(
      `INSERT INTO ${qi(name)} (${columns.map((c) => qi(c.Field)).join(",")}) VALUES ${placeholders}`,
      batch.flatMap((row) => row.flatMap((value) => value.parameters)),
    );
    batch = [];
    bytes = 0;
    parameter_count = 0;
  };
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (size > 8 * 1024 * 1024) throw sync_error("sync_row_too_large", 413);
    const values = [];
    for (const index of indices) {
      const value = decode(row[index]);
      values.push(
        table.columns[index].Type === "json"
          ? await json_insert_value(db, value)
          : { sql: "?", parameters: [value] },
      );
    }
    const count = values.reduce((n, value) => n + value.parameters.length, 0);
    if (bytes + size > 1024 * 1024 || parameter_count + count > 60000)
      await flush();
    batch.push(values);
    bytes += size;
    parameter_count += count;
  }
  await flush();
}

/** One dedicated connection holds explicit table locks through verification.
 * LOCK TABLES commits implicitly, so autocommit is disabled BEFORE locking;
 * no START TRANSACTION is issued afterwards. COMMIT retains the MySQL locks.
 */
export class DatabaseSyncSession {
  constructor(db) {
    this.db = db;
    this.closed = false;
    this.committed = false;
  }
  static async open(open = open_sync_database) {
    const db = await open(),
      session = new DatabaseSyncSession(db);
    try {
      await db.query("SET SESSION time_zone='+00:00'");
      await db.query("SET SESSION lock_wait_timeout=15");
      await db.query("SET SESSION innodb_lock_wait_timeout=15");
      await db.query(
        "SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'",
      );
      const [[identity]] = await db.query("SELECT DATABASE() AS name");
      session.lock_key = digest(["fracto_database_sync", identity.name]);
      const [[lock]] = await db.execute("SELECT GET_LOCK(?,0) AS acquired", [
        session.lock_key,
      ]);
      if (Number(lock.acquired) !== 1) throw sync_error("database_sync_busy");
      session.manifest = await read_manifest(db);
      await db.query("SET autocommit=0");
      await db.query(
        `LOCK TABLES ${session.manifest.tables.map((t) => `${qi(t.name)} WRITE`).join(",")}`,
      );
      assert_compatible(session.manifest, await read_manifest(db));
      session.snapshot = await session.read_snapshot();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async read_snapshot() {
    const tables = {};
    let bytes = 0,
      count = 0;
    for (const t of this.manifest.tables) {
      const [rows] = await this.db.execute({
        sql: `SELECT * FROM ${qi(t.name)} LIMIT 250001`,
        rowsAsArray: true,
      });
      tables[t.name] = rows.map((r) => r.map(encode));
      count += rows.length;
      bytes += row_bytes(tables[t.name]);
      if (count > 250000 || bytes > MAX_SNAPSHOT_BYTES)
        throw sync_error("sync_snapshot_limit", 413);
    }
    return { manifest: this.manifest, tables };
  }
  async merge(other, preferred = "local") {
    assert_compatible(this.manifest, other.manifest);
    const first = preferred === "remote" ? other : this.snapshot;
    const second = preferred === "remote" ? this.snapshot : other;
    const conflicts = [],
      tables = {};
    let conflict_count = 0;
    for (const [index, table] of this.manifest.tables.entries()) {
      const name = temp_name(index);
      await this.db.query(`DROP TEMPORARY TABLE IF EXISTS ${qi(name)}`);
      await this.db.query(
        `CREATE TEMPORARY TABLE ${qi(name)} LIKE ${qi(table.name)}`,
      );
      await insert_rows(this.db, name, table, first.tables[table.name]);
      const known = new Set(
        first.tables[table.name].map((row) => JSON.stringify(row)),
      );
      for (const row of second.tables[table.name]) {
        if (known.has(JSON.stringify(row))) continue;
        try {
          await insert_rows(this.db, name, table, [row]);
        } catch (error) {
          if (error.code !== "ER_DUP_ENTRY") throw error;
          const predicates = [],
            parameters = [];
          for (const unique of table.unique) {
            const cells = unique.columns.map(
              (c) =>
                row[table.columns.findIndex((col) => col.Field === c.name)],
            );
            if (cells.some((v) => v === null)) continue;
            predicates.push(
              `(${unique.columns.map((c) => (c.prefix ? `LEFT(${qi(c.name)},${Number(c.prefix)})=LEFT(?,${Number(c.prefix)})` : `${qi(c.name)}=?`)).join(" AND ")})`,
            );
            parameters.push(...cells.map(decode));
          }
          const [existing] = await this.db.execute(
            {
              sql: `SELECT * FROM ${qi(name)} WHERE ${predicates.join(" OR ")}`,
              rowsAsArray: true,
            },
            parameters,
          );
          for (const current of existing.map((r) => r.map(encode))) {
            if (JSON.stringify(current) === JSON.stringify(row)) continue;
            conflict_count++;
            if (conflicts.length < 200)
              conflicts.push({
                table: table.name,
                local_key: row_key(
                  table,
                  preferred === "local" ? current : row,
                ),
                remote_key: row_key(
                  table,
                  preferred === "local" ? row : current,
                ),
                columns: table.columns
                  .filter(
                    (c, i) =>
                      JSON.stringify(current[i]) !== JSON.stringify(row[i]),
                  )
                  .map((c) => c.Field),
              });
          }
        }
      }
      const [merged] = await this.db.execute({
        sql: `SELECT * FROM ${qi(name)}`,
        rowsAsArray: true,
      });
      tables[table.name] = merged.map((r) => r.map(encode));
    }
    const snapshot = { manifest: this.manifest, tables };
    assert_snapshot_budget(snapshot);
    return { snapshot, conflicts, conflict_count };
  }
  async prepare(snapshot) {
    assert_snapshot_budget(snapshot);
    assert_compatible(this.manifest, await read_manifest(this.db));
    assert_compatible(this.manifest, snapshot.manifest);
    // Native temporary indexes validate collisions using the real MySQL collations.
    for (const [index, table] of this.manifest.tables.entries()) {
      const name = temp_name(index);
      await this.db.query(`DROP TEMPORARY TABLE IF EXISTS ${qi(name)}`);
      await this.db.query(
        `CREATE TEMPORARY TABLE ${qi(name)} LIKE ${qi(table.name)}`,
      );
      await insert_rows(this.db, name, table, snapshot.tables[table.name]);
    }
    // Validate every foreign key before temporarily disabling FK insertion order.
    for (const [index, table] of this.manifest.tables.entries()) {
      const groups = Map.groupBy(table.foreign, (f) => f.name);
      for (const foreign of groups.values()) {
        const parent_index = this.manifest.tables.findIndex(
          (t) => t.name === foreign[0].parent,
        );
        // Excluded tables are never scanned or modified; cross-boundary FKs are unsupported.
        if (parent_index < 0) throw sync_error("foreign_key_to_excluded_table");
        let parent_name = temp_name(parent_index);
        if (parent_index === index) {
          parent_name = "fracto_sync_self_fk";
          await this.db.query(
            `DROP TEMPORARY TABLE IF EXISTS ${qi(parent_name)}`,
          );
          await this.db.query(
            `CREATE TEMPORARY TABLE ${qi(parent_name)} LIKE ${qi(temp_name(index))}`,
          );
          await this.db.query(
            `INSERT INTO ${qi(parent_name)} SELECT * FROM ${qi(temp_name(index))}`,
          );
        }
        const [missing] = await this.db.query(
          `SELECT 1 FROM ${qi(temp_name(index))} c LEFT JOIN ${qi(parent_name)} p ON ${foreign.map((f) => `c.${qi(f.column_name)}=p.${qi(f.parent_column)}`).join(" AND ")} WHERE ${foreign.map((f) => `c.${qi(f.column_name)} IS NOT NULL`).join(" AND ")} AND p.${qi(foreign[0].parent_column)} IS NULL LIMIT 1`,
        );
        if (missing.length)
          throw sync_error(
            `foreign_key_conflict:${table.name}:${foreign[0].name}`,
          );
      }
    }
    await this.db.query("SET FOREIGN_KEY_CHECKS=0");
    try {
      for (const t of this.manifest.tables)
        await this.db.query(`DELETE FROM ${qi(t.name)}`);
      for (const [i, t] of this.manifest.tables.entries()) {
        const fields = writable(t)
          .map((c) => qi(c.Field))
          .join(",");
        await this.db.query(
          `INSERT INTO ${qi(t.name)} (${fields}) SELECT ${fields} FROM ${qi(temp_name(i))}`,
        );
      }
    } finally {
      await this.db.query("SET FOREIGN_KEY_CHECKS=1");
    }
    if (
      snapshot_digest(await this.read_snapshot()) !== snapshot_digest(snapshot)
    )
      throw sync_error("prepared_data_mismatch");
    this.prepared = true;
  }
  async commit() {
    if (!this.prepared) throw sync_error("sync_not_prepared");
    assert_compatible(this.manifest, await read_manifest(this.db));
    await this.db.commit();
    this.committed = true;
    return snapshot_digest(await this.read_snapshot());
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.db.rollback();
      await this.db.query("UNLOCK TABLES");
      if (this.lock_key)
        await this.db.execute("SELECT RELEASE_LOCK(?)", [this.lock_key]);
    } finally {
      await this.db.end();
    }
  }
}
