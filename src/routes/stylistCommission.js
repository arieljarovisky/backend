import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAdmin } from "../auth/middlewares.js";

export const stylistCommission = Router();

stylistCommission.get("/", requireAuth, requireAdmin, async (_req, res) => {
  const [rows] = await pool.query(`
    SELECT s.id, s.name, COALESCE(c.percentage, 0) AS percentage
    FROM stylist s
    LEFT JOIN stylist_commission c ON s.id = c.stylist_id
    WHERE s.is_active = 1
    ORDER BY s.name
  `);
  res.json(rows);
});

stylistCommission.put("/:stylistId", requireAuth, requireAdmin, async (req, res) => {
  const { stylistId } = req.params;
  const { percentage } = req.body;
  await pool.query(`
    INSERT INTO stylist_commission (stylist_id, percentage)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE percentage = VALUES(percentage)
  `, [stylistId, Number(percentage) ?? 0]);
  res.json({ ok: true });
});
