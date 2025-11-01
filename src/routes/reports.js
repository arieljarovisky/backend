// src/routes/reports.js — MULTI-TENANT (KPIs y reportes)
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const reports = Router();
reports.use(requireAuth, requireRole("admin","user"));

function dayRange(from, to) {
  const f = `${from} 00:00:00`;
  const t = `${to} 23:59:59`;
  return [f, t];
}

/**
 * GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 * KPIs generales del rango: turnos, monto, pagos, depositos, etc.
 */
reports.get("/reports/summary", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const from = String(req.query.from || "").slice(0, 10);
    const to   = String(req.query.to   || "").slice(0, 10);
    if (!from || !to) return res.status(400).json({ ok:false, error:"from/to requeridos" });

    const [fromTs, toTs] = dayRange(from, to);

    const apptStatuses = ["scheduled","confirmed","deposit_paid","completed"];
    const placeholders = apptStatuses.map(() => "?").join(",");

    // Monto por servicios (precio lista) y cantidad de turnos
    const [[kpiAppt]] = await pool.query(
      `
      SELECT 
        COUNT(*)                          AS total_turnos,
        COALESCE(SUM(s.price_decimal),0)  AS monto_lista
      FROM appointment a
      JOIN service s ON s.id = a.service_id AND s.tenant_id = a.tenant_id
      WHERE a.tenant_id = ?
        AND a.status IN (${placeholders})
        AND a.starts_at BETWEEN ? AND ?
      `,
      [tenantId, ...apptStatuses, fromTs, toTs]
    );

    // Pagos registrados en el rango (caja)
    const [[kpiPay]] = await pool.query(
      `
      SELECT
        COALESCE(SUM(p.amount_cents),0) AS cobranzas_cents,
        COUNT(*)                         AS pagos_count
      FROM payment p
      WHERE p.tenant_id = ?
        AND p.created_at BETWEEN ? AND ?
      `,
      [tenantId, fromTs, toTs]
    );

    // Señales registradas sobre turnos (estado deposit_paid)
    const [[kpiDeposits]] = await pool.query(
      `
      SELECT
        COALESCE(SUM(a.deposit_decimal),0) AS depositos_total,
        COUNT(*)                            AS turnos_con_deposito
      FROM appointment a
      WHERE a.tenant_id = ?
        AND a.status IN ('deposit_paid','confirmed','completed')
        AND a.deposit_decimal IS NOT NULL
        AND a.starts_at BETWEEN ? AND ?
      `,
      [tenantId, fromTs, toTs]
    );

    res.json({
      ok: true,
      from, to,
      data: {
        total_turnos: Number(kpiAppt?.total_turnos || 0),
        monto_lista:  Number(kpiAppt?.monto_lista  || 0),
        cobranzas:    Number(kpiPay?.cobranzas_cents || 0) / 100,
        pagos_count:  Number(kpiPay?.pagos_count || 0),
        depositos_total: Number(kpiDeposits?.depositos_total || 0),
        turnos_con_deposito: Number(kpiDeposits?.turnos_con_deposito || 0),
      }
    });
  } catch (e) {
    console.error("[GET /reports/summary] error:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * GET /api/reports/appointments-by-day?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Serie diaria de cantidad y monto (según precio de servicio)
 */
reports.get("/reports/appointments-by-day", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const from = String(req.query.from || "").slice(0, 10);
    const to   = String(req.query.to   || "").slice(0, 10);
    if (!from || !to) return res.status(400).json({ ok:false, error:"from/to requeridos" });

    const [fromTs, toTs] = dayRange(from, to);
    const apptStatuses = ["scheduled","confirmed","deposit_paid","completed"];
    const placeholders = apptStatuses.map(() => "?").join(",");

    const [rows] = await pool.query(
      `
      SELECT 
        DATE(a.starts_at)                 AS date,
        COUNT(*)                          AS count,
        COALESCE(SUM(s.price_decimal),0)  AS amount
      FROM appointment a
      JOIN service s ON s.id = a.service_id AND s.tenant_id = a.tenant_id
      WHERE a.tenant_id = ?
        AND a.status IN (${placeholders})
        AND a.starts_at BETWEEN ? AND ?
      GROUP BY DATE(a.starts_at)
      ORDER BY DATE(a.starts_at)
      `,
      [tenantId, ...apptStatuses, fromTs, toTs]
    );

    res.json({ ok:true, from, to, data: rows });
  } catch (e) {
    console.error("[GET /reports/appointments-by-day] error:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * GET /api/reports/services?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Top servicios por cantidad y monto.
 */
reports.get("/reports/services", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const from = String(req.query.from || "").slice(0, 10);
    const to   = String(req.query.to   || "").slice(0, 10);
    if (!from || !to) return res.status(400).json({ ok:false, error:"from/to requeridos" });

    const [fromTs, toTs] = dayRange(from, to);
    const apptStatuses = ["scheduled","confirmed","deposit_paid","completed"];
    const placeholders = apptStatuses.map(() => "?").join(",");

    const [rows] = await pool.query(
      `
      SELECT 
        s.id,
        s.name AS service,
        COUNT(*)                          AS count,
        COALESCE(SUM(s.price_decimal),0)  AS amount
      FROM appointment a
      JOIN service s ON s.id = a.service_id AND s.tenant_id = a.tenant_id
      WHERE a.tenant_id = ?
        AND a.status IN (${placeholders})
        AND a.starts_at BETWEEN ? AND ?
      GROUP BY s.id
      ORDER BY amount DESC, count DESC
      `,
      [tenantId, ...apptStatuses, fromTs, toTs]
    );

    res.json({ ok:true, from, to, data: rows });
  } catch (e) {
    console.error("[GET /reports/services] error:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

/**
 * GET /api/reports/stylists?from=YYYY-MM-DD&to=YYYY-MM-DD
 * KPIs por estilista (cantidad, monto, comisión estimada).
 */
reports.get("/reports/stylists", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const from = String(req.query.from || "").slice(0, 10);
    const to   = String(req.query.to   || "").slice(0, 10);
    if (!from || !to) return res.status(400).json({ ok:false, error:"from/to requeridos" });

    const [fromTs, toTs] = dayRange(from, to);
    const apptStatuses = ["scheduled","confirmed","deposit_paid","completed"];
    const placeholders = apptStatuses.map(() => "?").join(",");

    const [rows] = await pool.query(
      `
      SELECT 
        st.id               AS stylist_id,
        st.name             AS stylist_name,
        COALESCE(c.percentage,0) AS commission_pct,
        COUNT(*)                 AS count,
        COALESCE(SUM(s.price_decimal),0) AS amount,
        ROUND(COALESCE(SUM(s.price_decimal),0) * (COALESCE(c.percentage,0)/100), 2) AS commission_amount
      FROM appointment a
      JOIN stylist st ON st.id = a.stylist_id AND st.tenant_id = a.tenant_id
      JOIN service  s ON s.id  = a.service_id  AND s.tenant_id  = a.tenant_id
      LEFT JOIN stylist_commission c 
        ON c.stylist_id = st.id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = ?
        AND a.status IN (${placeholders})
        AND a.starts_at BETWEEN ? AND ?
      GROUP BY st.id
      ORDER BY amount DESC
      `,
      [tenantId, ...apptStatuses, fromTs, toTs]
    );

    res.json({ ok:true, from, to, data: rows });
  } catch (e) {
    console.error("[GET /reports/stylists] error:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});
