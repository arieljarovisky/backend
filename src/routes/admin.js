// src/routes/admin.js
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const admin = Router();
admin.use(requireAuth, requireRole("admin", "user"));


/** Métricas rápidas para cards */
admin.get("/metrics", async (_req, res) => {
    try {
        // OJO: si tu MySQL corre en UTC y tu negocio en AR,
        // podés reemplazar CURDATE() por DATE(CONVERT_TZ(NOW(),'UTC','America/Argentina/Buenos_Aires'))
        const [[today]] = await pool.query(`
      SELECT
        SUM(a.status='scheduled') AS today_scheduled,
        SUM(a.status='cancelled') AS today_cancelled,
        COUNT(*)                  AS today_total
      FROM appointment a
      WHERE DATE(a.starts_at) = CURDATE()
    `);

        const [[week]] = await pool.query(`
      SELECT COALESCE(SUM(s.price_decimal),0) AS week_income
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      WHERE a.status IN ('scheduled','done')
        AND YEARWEEK(a.starts_at,1) = YEARWEEK(CURDATE(),1)
    `);

        res.json({
            today_scheduled: Number(today?.today_scheduled || 0),
            today_cancelled: Number(today?.today_cancelled || 0),
            today_total: Number(today?.today_total || 0),
            week_income: Number(week?.week_income || 0),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
/** Línea: ingresos por mes del año dado */
admin.get("/charts/income-by-month", async (req, res) => {
    try {
        const year = Number(req.query.year) || new Date().getFullYear();
        const [rows] = await pool.query(`
      SELECT MONTH(a.starts_at) AS m,
             DATE_FORMAT(a.starts_at,'%b') AS month,
             COALESCE(SUM(s.price_decimal),0) AS income
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      WHERE YEAR(a.starts_at)=? AND a.status IN ('scheduled','done')
      GROUP BY m, month
      ORDER BY m
    `, [year]);

        const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
        const byM = Object.fromEntries(rows.map(r => [r.m, Number(r.income || 0)]));
        const full = months.map((label, idx) => ({ month: label, income: byM[idx + 1] || 0 }));
        res.json(full);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** Barra: servicios más pedidos en los últimos N meses */
admin.get("/charts/top-services", async (req, res) => {
  try {
    const limit  = Number(req.query.limit  || 6);
    const months = Number(req.query.months || 3);
    const [rows] = await pool.query(`
      SELECT s.name AS service_name, COUNT(*) AS count
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      WHERE a.status IN ('scheduled','done')
        AND a.starts_at >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
      GROUP BY s.id, s.name
      ORDER BY count DESC
      LIMIT ?
    `, [months, limit]);
    res.json(rows.map(r => ({ service_name: r.service_name, count: Number(r.count||0) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/** Agenda de hoy (próximos turnos) */
admin.get("/agenda/today", async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.id, a.starts_at, a.status,
             c.name  AS customer_name,
             s.name  AS service_name,
             st.name AS stylist_name
      FROM appointment a
      JOIN customer  c  ON c.id  = a.customer_id
      JOIN service   s  ON s.id  = a.service_id
      JOIN stylist   st ON st.id = a.stylist_id
      WHERE DATE(a.starts_at) = CURDATE()
      ORDER BY a.starts_at
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/** Búsqueda de clientes (para tu CustomersPage) */
admin.get("/customers", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) {
      const [rows] = await pool.query(`
        SELECT c.id, c.name, c.phone_e164 AS phone,
               (SELECT COUNT(*) FROM appointment a WHERE a.customer_id=c.id) AS total_appointments
        FROM customer c
        ORDER BY c.id DESC
        LIMIT 50
      `);
      return res.json(rows);
    }
    const like = `%${q}%`;
    const [rows] = await pool.query(`
      SELECT c.id, c.name, c.phone_e164 AS phone,
             (SELECT COUNT(*) FROM appointment a WHERE a.customer_id=c.id) AS total_appointments
      FROM customer c
      WHERE c.name LIKE ? OR c.phone_e164 LIKE ?
      ORDER BY c.name
      LIMIT 50
    `, [like, like]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

