// src/routes/config.js  (EXTENSIÓN)
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAdmin } from "../auth/middlewares.js";
import { getConfigSnapshot } from "../services/config.js";


export const config = Router();

async function getSection(section) {
  const [rows] = await pool.query(
    "SELECT config_key, config_value FROM system_config WHERE config_key LIKE ?",
    [`${section}.%`]
  );
  const out = {};
  for (const r of rows) out[r.config_key.replace(`${section}.`, "")] = parseVal(r.config_value);
  return out;
}
function parseVal(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (!Number.isNaN(Number(v)) && v.trim() !== "") return Number(v);
  return v;
}
async function saveSection(section, body) {
  const entries = Object.entries(body || {});
  for (const [key, val] of entries) {
    await pool.query(`
      INSERT INTO system_config (config_key, config_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)
    `, [`${section}.${key}`, String(val)]);
  }
}

/** ====== GENERAL ====== */
config.get("/general", requireAuth, requireAdmin, async (_req, res) => {
  res.json(await getSection("general"));
});
config.put("/general", requireAuth, requireAdmin, async (req, res) => {
  await saveSection("general", req.body);
  res.json({ ok: true });
});

/** ====== DEPOSIT (ya existía, compat conservada) ====== */
config.get("/deposit", requireAuth, requireAdmin, async (_req, res) => {
  const [rows] = await pool.query("SELECT config_key, config_value FROM system_config");
  const map = Object.fromEntries(rows.map(r => [r.config_key, r.config_value]));
  res.json(map);
});
config.put("/deposit", requireAuth, requireAdmin, async (req, res) => {
  const entries = Object.entries(req.body || {});
  for (const [key, val] of entries) {
    await pool.query(`
      INSERT INTO system_config (config_key, config_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)
    `, [key, String(val)]);
  }
  // 🔄 refrescar caché para que el nuevo valor (ej. 80%) impacte al instante
  await getConfigSnapshot(true);
  res.json({ ok: true });
});

/** ====== COMMISSIONS ====== */
config.get("/commissions", requireAuth, requireAdmin, async (_req, res) => {
  res.json(await getSection("commissions"));
});
config.put("/commissions", requireAuth, requireAdmin, async (req, res) => {
  await saveSection("commissions", req.body);
  res.json({ ok: true });
});

/** ====== NOTIFICATIONS ====== */
config.get("/notifications", requireAuth, requireAdmin, async (_req, res) => {
  res.json(await getSection("notifications"));
});
config.put("/notifications", requireAuth, requireAdmin, async (req, res) => {
  await saveSection("notifications", req.body);
  res.json({ ok: true });
});
