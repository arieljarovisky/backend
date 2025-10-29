import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAdmin } from "../auth/middlewares.js";

export const stylistStats = Router();

/**
 * GET /api/stats/:stylistId?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Devuelve total de cortes, monto facturado, comisión y neto.
 */
stylistStats.get("/:stylistId", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { stylistId } = req.params;
    const { from, to } = req.query;

    // 1. Obtener porcentaje de comisión
    const [c] = await pool.query(
      "SELECT percentage FROM stylist_commission WHERE stylist_id = ?",
      [stylistId]
    );
    const pct = Number(c[0]?.percentage || 0);

    // 2. Construir filtros
    const where = ["a.stylist_id = ?"];
    const params = [stylistId];

    if (from) { where.push("DATE(a.starts_at) >= ?"); params.push(from); }
    if (to)   { where.push("DATE(a.starts_at) <= ?"); params.push(to); }

    // Turnos considerados “realizados / facturables”
    where.push("a.status IN ('confirmed','deposit_paid','completed')");

    // 3. Query principal
    const [agg] = await pool.query(
      `
      SELECT 
        COUNT(DISTINCT a.id) AS total_cortes,
        COALESCE(SUM(p.amount_cents)/100, SUM(s.price_decimal), 0) AS monto_total
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      LEFT JOIN payment p ON p.appointment_id = a.id
      WHERE ${where.join(" AND ")}
      `,
      params
    );

    const total = Number(agg[0]?.monto_total || 0);
    const comision = total * (pct / 100);

    res.json({
      stylist_id: Number(stylistId),
      total_cortes: Number(agg[0]?.total_cortes || 0),
      monto_total: total,
      porcentaje: pct,
      comision_ganada: comision,
      neto_local: total - comision,
    });
  } catch (err) {
    console.error("[STYLIST_STATS] Error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
