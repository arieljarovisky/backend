// src/routes/adminDashboard.js — MULTI-TENANT
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const adminDashboard = Router();
adminDashboard.use(requireAuth, requireRole("admin","user"));

/**
 * GET /api/dashboard/summary?date=YYYY-MM-DD
 * KPIs del día (o de hoy si no viene "date"):
 * - turnos hoy por estado
 * - próximos (siguientes 10)
 * - clientes totales
 * - monto lista estimado de hoy (sum precio de servicio)
 */
adminDashboard.get("/dashboard/summary", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const date = (req.query.date || "").toString().slice(0,10);
    const today = date || new Date().toISOString().slice(0,10);
    const from = `${today} 00:00:00`;
    const to   = `${today} 23:59:59`;

    // Conteo por estado hoy
    const [stateRows] = await pool.query(
      `
      SELECT a.status, COUNT(*) AS cnt
        FROM appointment a
       WHERE a.tenant_id = ?
         AND a.starts_at BETWEEN ? AND ?
       GROUP BY a.status
      `,
      [tenantId, from, to]
    );

    // Monto lista estimado hoy (sum precio del servicio)
    const [[kpiMonto]] = await pool.query(
      `
      SELECT COALESCE(SUM(s.price_decimal),0) AS total
        FROM appointment a
        JOIN service s ON s.id=a.service_id AND s.tenant_id=a.tenant_id
       WHERE a.tenant_id=?
         AND a.starts_at BETWEEN ? AND ?
         AND a.status IN ('scheduled','pending_deposit','deposit_paid','confirmed','completed')
      `,
      [tenantId, from, to]
    );

    // Próximos 10 turnos (hoy en adelante)
    const [upcoming] = await pool.query(
      `
      SELECT a.id, a.starts_at, a.ends_at, a.status,
             s.name AS service, st.name AS stylist,
             c.name AS customer, c.phone_e164 AS phone
        FROM appointment a
        JOIN service  s  ON s.id=a.service_id  AND s.tenant_id=a.tenant_id
        JOIN stylist  st ON st.id=a.stylist_id AND st.tenant_id=a.tenant_id
        LEFT JOIN customer c ON c.id=a.customer_id AND c.tenant_id=a.tenant_id
       WHERE a.tenant_id=?
         AND a.starts_at >= ?
       ORDER BY a.starts_at ASC
       LIMIT 10
      `,
      [tenantId, from]
    );

    // Total de clientes
    const [[custCount]] = await pool.query(
      `SELECT COUNT(*) AS total FROM customer WHERE tenant_id=?`,
      [tenantId]
    );

    res.json({
      ok: true,
      date: today,
      data: {
        byStatus: stateRows.reduce((acc, r) => (acc[r.status] = Number(r.cnt), acc), {}),
        upcoming,
        customersTotal: Number(custCount?.total || 0),
        amountToday: Number(kpiMonto?.total || 0)
      }
    });
  } catch (e) {
    console.error("[GET /dashboard/summary] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

/**
 * GET /api/dashboard/stylists?from=YYYY-MM-DD&to=YYYY-MM-DD
 * KPIs por estilista en rango: cantidad, monto lista, primera y última hora
 */
adminDashboard.get("/dashboard/stylists", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const from = (req.query.from || "").toString().slice(0,10);
    const to   = (req.query.to   || "").toString().slice(0,10);

    const fromTs = `${from || new Date().toISOString().slice(0,10)} 00:00:00`;
    const toTs   = `${to   || new Date().toISOString().slice(0,10)} 23:59:59`;

    const [rows] = await pool.query(
      `
      SELECT 
        st.id   AS stylist_id,
        st.name AS stylist_name,
        COUNT(*) AS count,
        COALESCE(SUM(s.price_decimal),0) AS amount,
        MIN(a.starts_at) AS first_start,
        MAX(a.ends_at)   AS last_end
      FROM appointment a
      JOIN stylist st ON st.id=a.stylist_id AND st.tenant_id=a.tenant_id
      JOIN service  s ON s.id=a.service_id  AND s.tenant_id=a.tenant_id
      WHERE a.tenant_id=?
        AND a.starts_at BETWEEN ? AND ?
        AND a.status IN ('scheduled','pending_deposit','deposit_paid','confirmed','completed')
      GROUP BY st.id
      ORDER BY amount DESC, count DESC
      `,
      [tenantId, fromTs, toTs]
    );

    res.json({ ok:true, from:fromTs.slice(0,10), to:toTs.slice(0,10), data: rows });
  } catch (e) {
    console.error("[GET /dashboard/stylists] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

/**
 * GET /api/dashboard/today-vs-tomorrow
 * Comparativo de cantidad de turnos (hoy vs mañana)
 */
adminDashboard.get("/dashboard/today-vs-tomorrow", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,"0");
    const dd = String(today.getDate()).padStart(2,"0");
    const todayStr = `${yyyy}-${mm}-${dd}`;

    const tomorrow = new Date(today.getTime()+86400000);
    const y2 = tomorrow.getFullYear();
    const m2 = String(tomorrow.getMonth()+1).padStart(2,"0");
    const d2 = String(tomorrow.getDate()).padStart(2,"0");
    const tomorrowStr = `${y2}-${m2}-${d2}`;

    const [[r1]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM appointment WHERE tenant_id=? AND starts_at BETWEEN ? AND ?`,
      [tenantId, `${todayStr} 00:00:00`, `${todayStr} 23:59:59`]
    );
    const [[r2]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM appointment WHERE tenant_id=? AND starts_at BETWEEN ? AND ?`,
      [tenantId, `${tomorrowStr} 00:00:00`, `${tomorrowStr} 23:59:59`]
    );

    res.json({
      ok:true,
      data: {
        today: { date: todayStr, count: Number(r1?.cnt || 0) },
        tomorrow: { date: tomorrowStr, count: Number(r2?.cnt || 0) }
      }
    });
  } catch (e) {
    console.error("[GET /dashboard/today-vs-tomorrow] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});
