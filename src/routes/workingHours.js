// src/routes/workingHours.js
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const workingHours = Router();

// Seguridad (podés ajustar roles si querés)
workingHours.use(requireAuth, requireRole("admin", "user"));

// Helper: asegura que existan los 7 días
function ensureSevenDays(rows, stylistId) {
  const map = new Map(rows.map(r => [Number(r.weekday), r]));
  return Array.from({ length: 7 }, (_, d) => {
    const r = map.get(d);
    return r || { stylist_id: Number(stylistId), weekday: d, start_time: null, end_time: null };
  });
}

// GET /api/working-hours?stylistId=1
workingHours.get("/", async (req, res) => {
  try {
    const stylistId = Number(req.query.stylistId);
    if (!stylistId) {
      return res.status(400).json({ ok: false, error: "Falta stylistId" });
    }
    const [rows] = await pool.query(
      `SELECT stylist_id, weekday, start_time, end_time
       FROM working_hours
       WHERE stylist_id = ?
       ORDER BY weekday ASC`,
      [stylistId]
    );
    const data = ensureSevenDays(rows, stylistId);
    return res.json({ ok: true, data });
  } catch (e) {
    console.error("[GET /api/working-hours] error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// PUT /api/working-hours
// Body: { stylistId: 1, hours: [{weekday, start_time|null|"", end_time|null|""}, ...7] }
workingHours.put("/", async (req, res) => {
  try {
    const stylistId = Number(req.body?.stylistId);
    const hours = Array.isArray(req.body?.hours) ? req.body.hours : null;

    if (!stylistId) return res.status(400).json({ ok: false, error: "Falta stylistId" });
    if (!hours || hours.length !== 7)
      return res.status(400).json({ ok: false, error: "Debe enviar 7 items en 'hours' (0..6)" });

    // Normalizar y validar
    const cleaned = hours.map((h) => {
      const weekday = Number(h.weekday);
      if (!(weekday >= 0 && weekday <= 6)) {
        throw new Error("Falta weekday (0..6)");
      }
      // "" → null
      let start = h.start_time;
      let end = h.end_time;
      start = (start === "" || start === undefined) ? null : start;
      end   = (end   === "" || end   === undefined) ? null : end;

      // Si uno es null, ambos a null (franco)
      if (start == null || end == null) {
        start = null; end = null;
      } else {
        // Asegurar formato HH:MM:SS
        if (/^\d{2}:\d{2}$/.test(start)) start += ":00";
        if (/^\d{2}:\d{2}$/.test(end)) end += ":00";
      }

      return { weekday, start_time: start, end_time: end };
    });

    // Upsert por cada día
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const item of cleaned) {
        const { weekday, start_time, end_time } = item;

        // ¿ya existe fila?
        const [[exists]] = await conn.query(
          `SELECT id FROM working_hours WHERE stylist_id=? AND weekday=?`,
          [stylistId, weekday]
        );

        if (exists) {
          await conn.query(
            `UPDATE working_hours
               SET start_time = ?, end_time = ?
             WHERE id = ?`,
            [start_time, end_time, exists.id]
          );
        } else {
          await conn.query(
            `INSERT INTO working_hours (stylist_id, weekday, start_time, end_time)
             VALUES (?,?,?,?)`,
            [stylistId, weekday, start_time, end_time]
          );
        }
      }

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[PUT /api/working-hours] error:", e);
    return res.status(400).json({ ok: false, error: e.message || "Bad Request" });
  }
});
