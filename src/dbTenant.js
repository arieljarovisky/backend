// src/dbTenant.js
import { pool } from "./db.js";

/**
 * Inyecta filtro por tenant sin romper alias ni ORDER/GROUP/LIMIT.
 * @param {Request} req  (requiere req.tenant.id)
 * @param {string} sql   SQL con o sin WHERE; puede tener alias
 * @param {Array} params Parámetros para los ? del SQL (en orden)
 * @param {{ alias?: string, aliases?: string[] }} opts
 *    - alias: alias principal de la tabla objetivo (p.ej. "a")
 *    - aliases: si el query usa varias tablas con tenant_id (p.ej. ["a","c","st"])
 *               se agrega (a.tenant_id=? AND c.tenant_id=? AND st.tenant_id=?)
 */
export async function tenantQuery(req, sql, params = [], opts = {}) {
  const tenantId = req?.tenant?.id;
  if (!tenantId) throw new Error("Tenant no identificado");

  // Si ya hay un filtro por tenant, no duplicar.
  if (/\btenant_id\s*=\s*\?/i.test(sql) || /\.\s*tenant_id\s*=\s*\?/i.test(sql)) {
    return pool.query(sql, params);
  }

  const aliases = Array.isArray(opts.aliases) && opts.aliases.length
    ? opts.aliases
    : (opts.alias ? [opts.alias] : []);

  const tenantExpr = (aliases.length
    ? aliases.map(a => `${a}.tenant_id = ?`).join(" AND ")
    : "tenant_id = ?");

  // Dónde insertar: antes de ORDER BY / GROUP BY / LIMIT (si existen)
  const orderIdx = indexOfRegex(sql, /\border\s+by\b/i);
  const groupIdx = indexOfRegex(sql, /\bgroup\s+by\b/i);
  const limitIdx = indexOfRegex(sql, /\blimit\b/i);
  const cut = minPositive([orderIdx, groupIdx, limitIdx]);

  const head = cut >= 0 ? sql.slice(0, cut) : sql;
  const tail = cut >= 0 ? sql.slice(cut) : "";

  // ¿Existe WHERE? entonces agregamos " AND (...)" al final de la cláusula WHERE
  const hasWhere = /\bwhere\b/i.test(head);

  const patchedHead = hasWhere
    ? head.replace(/\bwhere\b/i, match => match) + ` AND (${tenantExpr})`
    : `${head} WHERE (${tenantExpr})`;

  const patchedSQL = `${patchedHead} ${tail}`.replace(/\s+/g, " ").trim();

  // Los parámetros del tenant van al final porque el filtro se inserta al final del WHERE
  const tenantParams = aliases.length ? Array(aliases.length).fill(tenantId) : [tenantId];
  const finalParams = [...params, ...tenantParams];

  return pool.query(patchedSQL, finalParams);
}

/**
 * Inserta tenant_id en un INSERT ... VALUES(...)
 * Requiere que la tabla de destino tenga columna tenant_id.
 */
export async function tenantInsert(req, sql, params = []) {
  const tenantId = req?.tenant?.id;
  if (!tenantId) throw new Error("Tenant no identificado");

  // Inserta `tenant_id` como última columna de la lista explícita
  // Ej: INSERT INTO table (col1,col2) VALUES (?,?)  =>  (col1,col2,tenant_id) VALUES (?,?,?)
  const patched = sql.replace(
    /\(\s*([^)]+?)\s*\)\s*values\s*\(\s*/i,
    (m, cols) => `(${cols}, tenant_id) VALUES (`
  );

  return pool.query(patched, [...params, tenantId]);
}

// --- helpers internos ---
function indexOfRegex(s, re) {
  const m = re.exec(s);
  return m ? m.index : -1;
}
function minPositive(arr) {
  return arr.reduce((min, v) => (v >= 0 && (min < 0 || v < min) ? v : min), -1);
}
