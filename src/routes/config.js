// src/routes/config.js — MULTI-TENANT
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAdmin } from "../auth/middlewares.js";
import { getConfigSnapshot } from "../services/config.js";

export const config = Router();
config.use(requireAuth, requireAdmin);

function parseVal(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
async function getSection(tenantId, section) {
  const [rows] = await pool.query(
    "SELECT config_key, config_value FROM system_config WHERE tenant_id = ? AND config_key LIKE ?",
    [tenantId, `${section}.%`]
  );
  const out = {};
  for (const r of rows) out[r.config_key.replace(`${section}.`, "")] = parseVal(r.config_value);
  return out;
}
async function saveSection(tenantId, section, body) {
  const entries = Object.entries(body || {});
  for (const [key, val] of entries) {
    await pool.query(
      `
      INSERT INTO system_config (tenant_id, config_key, config_value)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)
      `,
      [tenantId, `${section}.${key}`, String(val)]
    );
  }
}

/** ====== GENERAL ====== */
config.get("/general", async (req, res) => {
  res.json(await getSection(req.tenant.id, "general"));
});
config.put("/general", async (req, res) => {
  await saveSection(req.tenant.id, "general", req.body);
  // Si cacheás, refrescá acá también si corresponde
  res.json({ ok: true });
});

/** ====== DEPOSIT ====== (compat mantenida pero scopiada) */
config.get("/deposit", async (req, res) => {
  const tenantId = req.tenant.id;
  const [rows] = await pool.query(
    "SELECT config_key, config_value FROM system_config WHERE tenant_id = ?",
    [tenantId]
  );
  const map = Object.fromEntries(rows.map(r => [r.config_key, r.config_value]));
  res.json(map);
});
config.put("/deposit", async (req, res) => {
  const tenantId = req.tenant.id;
  const entries = Object.entries(req.body || {});
  for (const [key, val] of entries) {
    await pool.query(
      `
      INSERT INTO system_config (tenant_id, config_key, config_value)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)
      `,
      [tenantId, key, String(val)]
    );
  }
  await getConfigSnapshot(true, tenantId); // refrescar caché del tenant
  res.json({ ok: true });
});

/** ====== COMMISSIONS ====== */
config.get("/commissions", async (req, res) => {
  res.json(await getSection(req.tenant.id, "commissions"));
});
config.put("/commissions", async (req, res) => {
  await saveSection(req.tenant.id, "commissions", req.body);
  res.json({ ok: true });
});

/** ====== NOTIFICATIONS ====== */
config.get("/notifications", async (req, res) => {
  res.json(await getSection(req.tenant.id, "notifications"));
});
config.put("/notifications", async (req, res) => {
  await saveSection(req.tenant.id, "notifications", req.body);
  res.json({ ok: true });
});
