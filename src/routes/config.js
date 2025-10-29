import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAdmin } from "../auth/middlewares.js";

export const config = Router();

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
  res.json({ ok: true });
});
