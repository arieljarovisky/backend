import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAdmin } from "../auth/middlewares.js";

export const stylistCommission = Router();

stylistCommission.get("/", requireAuth, requireAdmin, async (req, res) => {
  const tenantId = req.tenant.id;
  const [rows] = await pool.query(`
 SELECT s.id, s.name, COALESCE(c.percentage, 0) AS percentage
   FROM stylist s
   LEFT JOIN stylist_commission c ON s.id = c.stylist_id
   WHERE s.is_active = 1 AND s.tenant_id = ?
    ORDER BY s.name
  `, [tenantId]);
  res.json(rows);
});

stylistCommission.put("/:stylistId", requireAuth, requireAdmin, async (req, res) => {
  const { stylistId } = req.params;
  const { percentage } = req.body;
  const [[st]] = await pool.query(`SELECT id FROM stylist WHERE id=? AND tenant_id=?`, [stylistId, req.tenant.id]);
  if (!st) return res.status(404).json({ ok: false, error: "Peluquero no encontrado en tu cuenta" });
  await pool.query(`
  INSERT INTO stylist_commission (tenant_id, stylist_id, percentage)
  VALUES (?, ?, ?)
   ON DUPLICATE KEY UPDATE percentage = VALUES(percentage)
 `, [req.tenant.id, stylistId, Number(percentage) ?? 0]);
  res.json({ ok: true });
});
