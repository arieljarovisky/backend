// src/services/config.js
import { pool } from "../db.js";

const CACHE_MS = 30_000; // 30s
let cache = { ts: 0, data: null };

function parseValue(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (!Number.isNaN(Number(v)) && v.trim() !== "") return Number(v);
  return v;
}

async function loadAll() {
  const [rows] = await pool.query("SELECT config_key, config_value FROM system_config");
  const obj = {};
  for (const r of rows) obj[r.config_key] = parseValue(String(r.config_value ?? ""));
  return obj;
}

export async function getConfigSnapshot(force = false) {
  const now = Date.now();
  if (!cache.data || force || now - cache.ts > CACHE_MS) {
    cache.data = await loadAll();
    cache.ts = now;
  }
  return cache.data;
}

export async function getSection(section) {
  const all = await getConfigSnapshot();
  const out = {};
  const prefix = `${section}.`;
  for (const k of Object.keys(all)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = all[k];
  }
  return out;
}

export async function cfgNumber(key, def) {
  const all = await getConfigSnapshot();
  const v = all[key];
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}
export async function cfgBool(key, def) {
  const all = await getConfigSnapshot();
  const v = all[key];
  return typeof v === "boolean" ? v : def;
}
export async function cfgString(key, def) {
  const all = await getConfigSnapshot();
  const v = all[key];
  return typeof v === "string" ? v : def;
}
