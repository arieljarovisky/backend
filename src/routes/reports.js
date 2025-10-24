import { Router } from "express";
import { pool } from "../db.js";
export const reports = Router();

reports.get("/reports/stylist-earnings", async (req, res) => {
  const { from, to, groupBy = "day" } = req.query;
  if (!from || !to) return res.status(400).json({ ok: false, error: "from y to requeridos" });
  const fmt =
    groupBy === "week"
      ? "%Y-%u"
      : groupBy === "month"
      ? "%Y-%m"
      : "%Y-%m-%d";
  const [rows] = await pool.query(
    `SELECT st.id AS stylist_id, st.name AS stylist_name,
            DATE_FORMAT(a.starts_at, ?) AS period,
            SUM(s.price_decimal) AS total_ganancia,
            COUNT(a.id) AS cantidad_turnos
       FROM appointment a
       JOIN service s  ON s.id  = a.service_id
       JOIN stylist st ON st.id = a.stylist_id
      WHERE a.starts_at BETWEEN ? AND ?
        AND a.status='scheduled'
      GROUP BY st.id, period
      ORDER BY st.name, period`,
    [fmt, from, to]
  );
  res.json({ ok: true, data: rows });
});
