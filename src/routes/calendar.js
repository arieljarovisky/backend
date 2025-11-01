// src/routes/calendar.js — MULTI-TENANT
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const calendar = Router();
calendar.use(requireAuth, requireRole("admin","user"));

/**
 * GET /api/calendar/day?date=YYYY-MM-DD&stylistId=#
 * Devuelve turnos y bloqueos del día.
 */
calendar.get("/calendar/day", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const date = String(req.query.date || "").slice(0, 10);
    const stylistId = req.query.stylistId ? Number(req.query.stylistId) : null;

    if (!date) {
      return res.status(400).json({ ok:false, error:"Falta date (YYYY-MM-DD)" });
    }

    const paramsBase = [tenantId, `${date} 00:00:00`, `${date} 23:59:59`];

    // --- Turnos ---
    let apptSQL = `
      SELECT 
        a.id, a.starts_at, a.ends_at, a.status,
        s.name  AS service_name, s.price_decimal,
        st.id   AS stylist_id, st.name AS stylist_name,
        c.id    AS customer_id, c.name AS customer_name, c.phone_e164 AS customer_phone
      FROM appointment a
      JOIN service  s  ON s.id  = a.service_id  AND s.tenant_id  = a.tenant_id
      JOIN stylist  st ON st.id = a.stylist_id  AND st.tenant_id = a.tenant_id
      LEFT JOIN customer c ON c.id = a.customer_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = ?
        AND a.starts_at BETWEEN ? AND ?
    `;
    const apptParams = [...paramsBase];

    if (stylistId) {
      apptSQL += " AND a.stylist_id = ?";
      apptParams.push(stylistId);
    }

    apptSQL += " ORDER BY a.starts_at ASC";

    const [appointments] = await pool.query(apptSQL, apptParams);

    // --- Bloqueos ---
    let offSQL = `
      SELECT id, stylist_id, starts_at, ends_at, reason
      FROM time_off
      WHERE tenant_id = ?
        AND starts_at < DATE_ADD(?, INTERVAL 1 DAY)
        AND ends_at   > ?
    `;
    const offParams = [tenantId, `${date} 00:00:00`, `${date} 23:59:59`];
    if (stylistId) {
      offSQL += " AND stylist_id = ?";
      offParams.push(stylistId);
    }
    offSQL += " ORDER BY starts_at ASC";

    const [blocks] = await pool.query(offSQL, offParams);

    return res.json({ ok:true, date, data: { appointments, blocks } });
  } catch (e) {
    console.error("[GET /calendar/day] error:", e);
    return res.status(500).json({ ok:false, error:e.message });
  }
});

/**
 * GET /api/calendar/range?from=YYYY-MM-DD&to=YYYY-MM-DD&stylistId=#
 * Devuelve turnos y bloqueos en un rango (incluye to completo).
 */
calendar.get("/calendar/range", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const from = String(req.query.from || "").slice(0, 10);
    const to   = String(req.query.to   || "").slice(0, 10);
    const stylistId = req.query.stylistId ? Number(req.query.stylistId) : null;

    if (!from || !to) {
      return res.status(400).json({ ok:false, error:"from y to (YYYY-MM-DD) son requeridos" });
    }

    const fromTs = `${from} 00:00:00`;
    const toTs   = `${to} 23:59:59`;

    // Turnos
    let apptSQL = `
      SELECT 
        a.id, a.starts_at, a.ends_at, a.status,
        s.name  AS service_name, s.price_decimal,
        st.id   AS stylist_id, st.name AS stylist_name,
        c.id    AS customer_id, c.name AS customer_name, c.phone_e164 AS customer_phone
      FROM appointment a
      JOIN service  s  ON s.id  = a.service_id  AND s.tenant_id  = a.tenant_id
      JOIN stylist  st ON st.id = a.stylist_id  AND st.tenant_id = a.tenant_id
      LEFT JOIN customer c ON c.id = a.customer_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = ?
        AND a.starts_at BETWEEN ? AND ?
    `;
    const apptParams = [tenantId, fromTs, toTs];

    if (stylistId) {
      apptSQL += " AND a.stylist_id = ?";
      apptParams.push(stylistId);
    }

    apptSQL += " ORDER BY a.starts_at ASC";
    const [appointments] = await pool.query(apptSQL, apptParams);

    // Bloqueos
    let offSQL = `
      SELECT id, stylist_id, starts_at, ends_at, reason
      FROM time_off
      WHERE tenant_id = ?
        AND starts_at < DATE_ADD(?, INTERVAL 1 DAY)
        AND ends_at   > ?
    `;
    const offParams = [tenantId, toTs, fromTs];

    if (stylistId) {
      offSQL += " AND stylist_id = ?";
      offParams.push(stylistId);
    }

    offSQL += " ORDER BY starts_at ASC";
    const [blocks] = await pool.query(offSQL, offParams);

    return res.json({ ok:true, range:{from, to}, data:{ appointments, blocks } });
  } catch (e) {
    console.error("[GET /calendar/range] error:", e);
    return res.status(500).json({ ok:false, error:e.message });
  }
});
