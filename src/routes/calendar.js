// src/routes/calendar.js
import { Router } from "express";
import { pool } from "../db.js";

export const calendar = Router();

/**
 * GET /api/calendar/events
 * Query:
 *  - includePending=0|1  (default 0: oculta pending_deposit y cancelled)
 *  - from=YYYY-MM-DD     (opcional)
 *  - to=YYYY-MM-DD       (opcional)
 *  - stylistId=number    (opcional)
 */
calendar.get("/events", async (req, res) => {
  try {
    const includePending = req.query.includePending === "1";
    const { from, to, stylistId } = req.query;

    // Estados a incluir por defecto
    const baseStatuses = ["confirmed", "deposit_paid", "completed", "scheduled"];
    const statuses = includePending
      ? [...baseStatuses, "pending_deposit"] // opcional si todavía usás 'scheduled'
      : baseStatuses;

    const where = [];
    const params = [];

    // Rango de fechas (opcional). Si no lo mandás, traemos próximo mes por defecto.
    if (from && to) {
      where.push("a.starts_at BETWEEN ? AND ?");
      params.push(`${from} 00:00:00`, `${to} 23:59:59`);
    } else {
      // por defecto: desde hoy - 7d hasta hoy + 60d
      where.push("a.starts_at BETWEEN DATE_SUB(NOW(), INTERVAL 7 DAY) AND DATE_ADD(NOW(), INTERVAL 60 DAY)");
    }

    // Filtrar por estilista (opcional)
    if (stylistId) {
      where.push("a.stylist_id = ?");
      params.push(Number(stylistId));
    }

    // Filtrar por estados
    where.push(`a.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);

    const sql = `
      SELECT
        a.id,
        a.starts_at, a.ends_at, a.status,
        a.deposit_decimal, a.deposit_paid_at,
        c.name  AS customer_name,
        s.name  AS service_name,
        st.name AS stylist_name
      FROM appointment a
      JOIN customer c ON c.id = a.customer_id
      JOIN service  s ON s.id = a.service_id
      JOIN stylist st ON st.id = a.stylist_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.starts_at ASC
    `;

    const [rows] = await pool.query(sql, params);

    // Map a formato FullCalendar
    const events = rows.map(r => ({
      id: r.id,
      title: `${r.service_name} • ${r.customer_name ?? "Cliente"}`,
      start: r.starts_at, // FullCalendar acepta 'YYYY-MM-DD HH:MM:SS'
      end:   r.ends_at,
      extendedProps: {
        status: r.status,
        deposit_decimal: r.deposit_decimal,
        deposit_paid_at: r.deposit_paid_at,
        service_name: r.service_name,
        stylist_name: r.stylist_name,
        customer_name: r.customer_name
      }
    }));

    res.json({ ok: true, events });
  } catch (e) {
    console.error("[/api/calendar/events] error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


export default calendar; 
