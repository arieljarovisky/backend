// src/routes/adminDashboard.js
import { Router } from "express";
import { pool } from "../db.js";

export const adminDashboard = Router();

/** Dashboard general con KPIs básicos */
adminDashboard.get("/", async (_req, res) => {
  try {
    const [[todayCount]] = await pool.query(`
      SELECT COUNT(*) AS total
      FROM appointment
      WHERE DATE(starts_at) = CURDATE()
    `);

    const [[tomorrowCount]] = await pool.query(`
      SELECT COUNT(*) AS total
      FROM appointment
      WHERE DATE(starts_at) = CURDATE() + INTERVAL 1 DAY
    `);

    const [[totalCustomers]] = await pool.query(`SELECT COUNT(*) AS total FROM customer`);

    const [byStylist] = await pool.query(`
      SELECT s.name AS stylist, COUNT(a.id) AS total
      FROM appointment a
      JOIN stylist s ON s.id = a.stylist_id
      WHERE DATE(a.starts_at) >= CURDATE()
      GROUP BY s.id
    `);

    res.json({
      ok: true,
      data: {
        todayAppointments: todayCount.total,
        tomorrowAppointments: tomorrowCount.total,
        totalCustomers: totalCustomers.total,
        byStylist
      }
    });
  } catch (e) {
    console.error("[DASHBOARD] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
 