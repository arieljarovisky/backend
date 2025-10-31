// routes/admin.js
import { Router } from "express";
import { pool } from "../db.js";

export const admin = Router();

// GET /api/admin/charts/income-by-month?year=2025
admin.get("/charts/income-by-month", async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();

    const [rows] = await pool.query(
      `
      WITH months AS (
        SELECT 1 AS m UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
        UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8
        UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
      )
      SELECT 
        LPAD(months.m, 2, '0') AS month,
        COALESCE(SUM(x.income), 0) AS income
      FROM months
      LEFT JOIN (
        SELECT 
          MONTH(a.starts_at) AS m,
          CAST(s.price_decimal AS DECIMAL(18,2)) AS income
        FROM appointment a
        JOIN service s ON s.id = a.service_id
        WHERE YEAR(a.starts_at) = ?
          AND a.status IN ('completed','confirmed','deposit_paid')
      ) AS x ON x.m = months.m
      GROUP BY months.m
      ORDER BY months.m
      `,
      [year]
    );

    // Devuelve SIEMPRE 12 meses como números reales
    const data = rows.map(r => ({ month: r.month, income: Number(r.income || 0) }));
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
/** Top servicios ?months=3&limit=6 (desde hoy hacia atrás) */
admin.get("/charts/top-services", async (req, res) => {
  try {
    const months = Math.max(1, Number(req.query.months) || 3);
    const limit = Math.max(1, Number(req.query.limit) || 6);
    const [rows] = await pool.query(
      `
      SELECT s.name AS service_name, COUNT(*) AS count
      FROM appointment a
      JOIN service s ON s.id = a.service_id
      WHERE a.starts_at >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
        AND a.status IN ('scheduled','confirmed','deposit_paid','completed')
      GROUP BY s.id, s.name
      ORDER BY count DESC
      LIMIT ?
      `,
      [months, limit]
    );
    res.json({ ok: true, data: rows.map(r => ({ service_name: r.service_name, count: Number(r.count) })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Agenda de hoy para la tabla “Agenda de Hoy” */
admin.get("/agenda/today", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT 
        a.id,
        a.starts_at,
        a.status,
        c.name AS customer_name,
        s.name AS service_name,
        st.name AS stylist_name
      FROM appointment a
      LEFT JOIN customer c ON c.id=a.customer_id
      LEFT JOIN service s  ON s.id=a.service_id
      LEFT JOIN stylist st ON st.id=a.stylist_id
      WHERE DATE(a.starts_at)=CURDATE()
      ORDER BY a.starts_at
      `
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
