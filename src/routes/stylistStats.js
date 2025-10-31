// src/routes/stylistStats.js
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth/middlewares.js";

export const stylistStats = Router();
stylistStats.use(requireAuth);

// helper: incluye todo el día "to"
function dayRange(from, to) {
  const f = `${from} 00:00:00`;
  const t = `${to} 23:59:59`;
  return [f, t];
}

// GET /api/stats/:stylistId?from=YYYY-MM-DD&to=YYYY-MM-DD
stylistStats.get("/:stylistId", async (req, res) => {
  try {
    const stylistId = Number(req.params.stylistId);
    const from = String(req.query.from || "").slice(0, 10);
    const to = String(req.query.to || "").slice(0, 10);
    if (!stylistId || !from || !to) {
      return res.status(400).json({ ok: false, error: "Falta stylistId/from/to" });
    }
    const [fromTs, toTs] = dayRange(from, to);

    // % de comisión (si no hay, 0)
    const [[rowPct]] = await pool.query(
      `SELECT percentage FROM stylist_commission WHERE stylist_id=? LIMIT 1`,
      [stylistId]
    );
    const porcentaje = Number(rowPct?.percentage || 0);

    // Estados a contar (excluimos cancelados)
    const statuses = ["scheduled", "confirmed", "deposit_paid", "completed"];

    // KPIs
    const [[kpi]] = await pool.query(
      `
      SELECT
        COUNT(*)                                    AS total_cortes,
        COALESCE(SUM(s.price_decimal), 0)           AS monto_total
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      WHERE a.stylist_id = ?
        AND a.status IN (?,?,?,?)
        AND a.starts_at BETWEEN ? AND ?
      `,
      [stylistId, ...statuses, fromTs, toTs]
    );

    const monto_total = Number(kpi?.monto_total || 0);
    const total_cortes = Number(kpi?.total_cortes || 0);
    const comision_ganada = +(monto_total * (porcentaje / 100)).toFixed(2);
    const neto_local = +(monto_total - comision_ganada).toFixed(2);

    // Serie diaria
    const [daily] = await pool.query(
      `
      SELECT DATE(a.starts_at) AS date,
             COUNT(*)          AS cortes,
             COALESCE(SUM(s.price_decimal),0) AS amount
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      WHERE a.stylist_id = ?
        AND a.status IN (?,?,?,?)
        AND a.starts_at BETWEEN ? AND ?
      GROUP BY DATE(a.starts_at)
      ORDER BY DATE(a.starts_at)
      `,
      [stylistId, ...statuses, fromTs, toTs]
    );

    // Por servicio
    const [services] = await pool.query(
      `
      SELECT s.name AS service,
             COUNT(*) AS count,
             COALESCE(SUM(s.price_decimal),0) AS amount
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      WHERE a.stylist_id = ?
        AND a.status IN (?,?,?,?)
        AND a.starts_at BETWEEN ? AND ?
      GROUP BY s.id
      ORDER BY amount DESC
      `,
      [stylistId, ...statuses, fromTs, toTs]
    );

    // (Opcional) lista de turnos para exportar
    const [turnos] = await pool.query(
      `
      SELECT a.id, a.starts_at, a.status,
             s.name AS service_name, s.price_decimal,
             c.name AS customer_name, st.name AS stylist_name
      FROM appointment a
      JOIN service s  ON s.id = a.service_id
      LEFT JOIN customer c ON c.id = a.customer_id
      JOIN stylist  st ON st.id = a.stylist_id
      WHERE a.stylist_id = ?
        AND a.status IN (?,?,?,?)
        AND a.starts_at BETWEEN ? AND ?
      ORDER BY a.starts_at
      `,
      [stylistId, ...statuses, fromTs, toTs]
    );

    return res.json({
      stylist_id: stylistId,
      porcentaje,
      total_cortes,
      monto_total,
      comision_ganada,
      neto_local,
      daily,
      services,
      turnos
    });
  } catch (e) {
    console.error("[GET /api/stats/:stylistId] error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
