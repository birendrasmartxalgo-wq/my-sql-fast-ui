// schema.js — MySQL schema introspection (tables/columns/PKs/FKs) and join-suggestion builders.
import { getPool, quoteIdent } from "./db.js";

export async function fetchSchema(db, connId = 0) {
  const sql = await getPool(db, connId);
  // MySQL information_schema spans every database on the server, so scope each
  // query to the selected db — otherwise the sidebar tree merges all databases.
  const tables = await sql.unsafe(`
    SELECT t.table_schema AS \`schema\`, t.table_name AS name,
           CASE t.table_type WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' ELSE t.table_type END AS kind,
           CAST(COALESCE(t.data_length + t.index_length, 0) AS UNSIGNED) AS bytes,
           t.table_rows AS est_rows
    FROM information_schema.TABLES t
    WHERE t.table_schema = ?
    ORDER BY t.table_name`, [db]);
  const columns = await sql.unsafe(`
    SELECT c.table_schema AS \`schema\`, c.table_name AS \`table\`, c.column_name AS name,
           c.column_type AS type,
           c.is_nullable = 'YES' AS nullable, c.column_default AS dflt,
           c.extra AS extra, c.ordinal_position AS pos
    FROM information_schema.COLUMNS c
    WHERE c.table_schema = ?
    ORDER BY c.table_name, c.ordinal_position`, [db]);
  const pks = await sql.unsafe(`
    SELECT k.table_schema AS \`schema\`, k.table_name AS \`table\`,
           GROUP_CONCAT(k.column_name ORDER BY k.ordinal_position SEPARATOR ',') AS cols
    FROM information_schema.TABLE_CONSTRAINTS tc
    JOIN information_schema.KEY_COLUMN_USAGE k
      ON k.constraint_name = tc.constraint_name
     AND k.table_schema = tc.table_schema
     AND k.table_name = tc.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = ?
    GROUP BY k.table_schema, k.table_name`, [db]);
  // split comma-separated cols into arrays for join-builders
  for (const pk of pks) pk.cols = pk.cols ? pk.cols.split(",") : [];
  return { tables, columns, pks };
}

export async function fetchFks(db, connId = 0) {
  const sql = await getPool(db, connId);
  // MySQL KEY_COLUMN_USAGE returns one row per column in the FK; group them into
  // src/dst column arrays. Scope to the selected db (information_schema is server-wide).
  const grouped = await sql.unsafe(`
    SELECT k.table_schema AS src_schema, k.table_name AS src_table,
           k.referenced_table_schema AS dst_schema, k.referenced_table_name AS dst_table,
           GROUP_CONCAT(k.column_name ORDER BY k.ordinal_position SEPARATOR ',') AS src_cols,
           GROUP_CONCAT(k.referenced_column_name ORDER BY k.position_in_unique_constraint SEPARATOR ',') AS dst_cols,
           k.constraint_name AS name
    FROM information_schema.KEY_COLUMN_USAGE k
    WHERE k.referenced_table_name IS NOT NULL
      AND k.table_schema = ?
    GROUP BY k.table_schema, k.table_name, k.referenced_table_schema, k.referenced_table_name, k.constraint_name`, [db]);
  for (const f of grouped) {
    f.src_cols = f.src_cols ? f.src_cols.split(",") : [];
    f.dst_cols = f.dst_cols ? f.dst_cols.split(",") : [];
  }
  return grouped;
}

// ---------------------------------------------------------------- join suggestions
const tkey = (schema, table) => `${schema}.${table}`;
const fqtn = (schema, table) =>
  quoteIdent(schema) + "." + quoteIdent(table);

function joinSql(steps) {
  // steps: [{schema,table,alias}, {schema,table,alias,on:[[lAlias,lCol,rCol],…]}, …]
  let sqlText = `SELECT ${steps.map(s => s.alias + ".*").join(", ")}\nFROM ${fqtn(steps[0].schema, steps[0].table)} ${steps[0].alias}`;
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i];
    const conds = s.on.map(([la, lc, rc]) => `${la}.${quoteIdent(lc)} = ${s.alias}.${quoteIdent(rc)}`).join(" AND ");
    sqlText += `\nJOIN ${fqtn(s.schema, s.table)} ${s.alias} ON ${conds}`;
  }
  return sqlText + "\nLIMIT 100;";
}

export function buildSuggestions({ fks, columns, pks }, target) {
  const colsByTable = new Map();
  for (const c of columns) {
    const k = tkey(c.schema, c.table);
    if (!colsByTable.has(k)) colsByTable.set(k, []);
    colsByTable.get(k).push(c);
  }
  const pkByTable = new Map(pks.map(p => [tkey(p.schema, p.table), p.cols || []]));
  const suggestions = [];
  // MySQL databases are the schema — "public" concept doesn't exist
  const [tSchema, tTable] = target.includes(".") ? target.split(".", 2) : [null, target];
  // If no schema specified, search all
  const candidates = tSchema
    ? [{ schema: tSchema, table: tTable }]
    : columns.filter(c => c.table === tTable).map(c => ({ schema: c.schema, table: c.table })).filter((v, i, a) => a.findIndex(x => x.schema === v.schema && x.table === v.table) === i);
  if (!candidates.length) return [];

  const tk = tkey(candidates[0].schema, candidates[0].table);
  const s = candidates[0].schema, t = candidates[0].table;

  // 1. outgoing FKs (high confidence)
  for (const f of fks) {
    if (tkey(f.src_schema, f.src_table) !== tk) continue;
    suggestions.push({
      kind: "fk", confidence: "high",
      title: `${t} → ${f.dst_table} (FK ${f.name})`,
      detail: `Foreign key: ${f.src_cols.join(", ")} → ${f.dst_table}(${f.dst_cols.join(", ")})`,
      sql: joinSql([
        { schema: s, table: t, alias: "t1" },
        { schema: f.dst_schema, table: f.dst_table, alias: "t2",
          on: f.src_cols.map((c, i) => ["t1", c, f.dst_cols[i]]) },
      ]),
    });
  }
  // 2. incoming FKs (high confidence, reverse direction)
  for (const f of fks) {
    if (tkey(f.dst_schema, f.dst_table) !== tk) continue;
    suggestions.push({
      kind: "fk-reverse", confidence: "high",
      title: `${t} ← ${f.src_table} (referenced by FK ${f.name})`,
      detail: `${f.src_table}(${f.src_cols.join(", ")}) references ${t}(${f.dst_cols.join(", ")})`,
      sql: joinSql([
        { schema: s, table: t, alias: "t1" },
        { schema: f.src_schema, table: f.src_table, alias: "t2",
          on: f.dst_cols.map((c, i) => ["t1", c, f.src_cols[i]]) },
      ]),
    });
  }
  // 3. two-hop FK paths through an intermediate table
  for (const f1 of fks) {
    if (tkey(f1.src_schema, f1.src_table) !== tk) continue;
    const midK = tkey(f1.dst_schema, f1.dst_table);
    for (const f2 of fks) {
      if (tkey(f2.src_schema, f2.src_table) !== midK) continue;
      if (tkey(f2.dst_schema, f2.dst_table) === tk) continue;
      suggestions.push({
        kind: "fk-path", confidence: "medium",
        title: `${t} → ${f1.dst_table} → ${f2.dst_table} (2-hop)`,
        detail: `Chain through ${f1.dst_table}`,
        sql: joinSql([
          { schema: s, table: t, alias: "t1" },
          { schema: f1.dst_schema, table: f1.dst_table, alias: "t2",
            on: f1.src_cols.map((c, i) => ["t1", c, f1.dst_cols[i]]) },
          { schema: f2.dst_schema, table: f2.dst_table, alias: "t3",
            on: f2.src_cols.map((c, i) => ["t2", c, f2.dst_cols[i]]) },
        ]),
      });
    }
  }
  // 4. shared column name + type heuristic
  const myCols = colsByTable.get(tk) || [];
  const seen = new Set(suggestions.map(s => s.title));
  for (const [otherK, otherCols] of colsByTable) {
    if (otherK === tk) continue;
    const [oSchema, oTable] = otherK.split(".");
    const matches = [];
    for (const mc of myCols) {
      const oc = otherCols.find(o => o.name === mc.name && o.type === mc.type);
      if (!oc) continue;
      if (/^(created_at|updated_at|id|name|status|mode|notes|description)$/i.test(mc.name)) continue;
      matches.push(mc.name);
    }
    if (!matches.length) continue;
    const otherPk = pkByTable.get(otherK) || [];
    const isPkMatch = matches.some(m => otherPk.includes(m));
    const title = `${t} ~ ${oTable} on shared column${matches.length > 1 ? "s" : ""} ${matches.join(", ")}`;
    if (seen.has(title)) continue;
    suggestions.push({
      kind: "shared-column", confidence: isPkMatch ? "medium" : "low",
      title,
      detail: `Same column name & type${isPkMatch ? " (matches the other table's primary key)" : ""} — verify semantics before trusting`,
      sql: joinSql([
        { schema: s, table: t, alias: "t1" },
        { schema: oSchema, table: oTable, alias: "t2", on: matches.map(m => ["t1", m, m]) },
      ]),
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  return suggestions;
}

export function buildPath({ fks, columns }, from, to) {
  const edges = new Map();
  const addEdge = (a, b, on, via) => {
    if (!edges.has(a)) edges.set(a, []);
    edges.get(a).push({ to: b, on, via });
  };
  for (const f of fks) {
    const a = tkey(f.src_schema, f.src_table), b = tkey(f.dst_schema, f.dst_table);
    addEdge(a, b, f.src_cols.map((c, i) => [c, f.dst_cols[i]]), `FK ${f.name}`);
    addEdge(b, a, f.dst_cols.map((c, i) => [c, f.src_cols[i]]), `FK ${f.name} (reverse)`);
  }
  const colsByTable = new Map();
  for (const c of columns) {
    const k = tkey(c.schema, c.table);
    if (!colsByTable.has(k)) colsByTable.set(k, []);
    colsByTable.get(k).push(c);
  }
  const norm = (t) => (t.includes(".") ? t : [null, t].join("."));
  const src = norm(from), dst = norm(to);

  const bfs = (useShared) => {
    const allEdges = new Map(edges);
    if (useShared) {
      const keys = [...colsByTable.keys()];
      for (const a of keys) for (const b of keys) {
        if (a === b) continue;
        const shared = (colsByTable.get(a) || [])
          .filter(ca => !/^(created_at|updated_at|id|name|status|mode)$/i.test(ca.name))
          .filter(ca => (colsByTable.get(b) || []).some(cb => cb.name === ca.name && cb.type === ca.type))
          .map(ca => [ca.name, ca.name]);
        if (shared.length) {
          if (!allEdges.has(a)) allEdges.set(a, []);
          allEdges.get(a).push({ to: b, on: shared, via: `shared column ${shared.map(s => s[0]).join(", ")}` });
        }
      }
    }
    const prev = new Map([[src, null]]);
    const q = [src];
    while (q.length) {
      const cur = q.shift();
      if (cur === dst) break;
      for (const e of allEdges.get(cur) || []) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, { from: cur, edge: e });
        q.push(e.to);
      }
    }
    if (!prev.has(dst)) return null;
    const chain = [];
    let cur = dst;
    while (prev.get(cur)) { chain.unshift({ table: cur, ...prev.get(cur) }); cur = prev.get(cur).from; }
    return chain;
  };

  const chain = bfs(false) || bfs(true);
  if (!chain) return null;
  const steps = [{ schema: src.split(".")[0], table: src.split(".")[1], alias: "t1" }];
  const aliasOf = new Map([[src, "t1"]]);
  const vias = [];
  chain.forEach((step, i) => {
    const alias = "t" + (i + 2);
    aliasOf.set(step.table, alias);
    const [sch, tbl] = step.table.split(".");
    steps.push({ schema: sch, table: tbl, alias, on: step.edge.on.map(([l, r]) => [aliasOf.get(step.from), l, r]) });
    vias.push(step.edge.via);
  });
  return { sql: joinSql(steps), via: vias };
}
