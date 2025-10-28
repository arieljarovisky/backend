// src/routes/calendar.js
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth/middlewares.js";

export const calendar = Router();
calendar.use(requireAuth);

/**
 * GET /api/calendar/events
 * Query:
 *  - includePending=0|1  (default 0: oculta pending_deposit y cancelled)
 *  - from=YYYY-MM-DD | ISO (opcional)
 *  - to=YYYY-MM-DD   | ISO (opcional)
 *  - stylistId=number (opcional)
 */
calendar.get("/events", async (req, res) => {
  try {
    const includePending = req.query.includePending === "1";
    const { from, to, stylistId } = req.query;

    // Estados visibles por defecto (NO incluye cancelled)
    const baseStatuses = ["confirmed", "deposit_paid", "completed", "scheduled"];
    const statuses = includePending ? [...baseStatuses, "pending_deposit"] : baseStatuses;

    const where = [];
    const params = [];

    // Normaliza fechas: si viene ISO, MySQL igual entiende 'YYYY-MM-DDTHH:mm:ssZ',
    // pero preferimos recortar a día.
    const normDay = (s) => {
      if (!s) return s;
      // acepta ISO o 'YYYY-MM-DD'
      const day = String(s).slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
    };

    const fromDay = normDay(from);
    const toDay = normDay(to);

    if (fromDay && toDay) {
      where.push("a.starts_at BETWEEN ? AND ?");
      params.push(`${fromDay} 00:00:00`, `${toDay} 23:59:59`);
    } else {
      // por defecto: desde hoy -7d hasta hoy +60d
      where.push("a.starts_at BETWEEN DATE_SUB(NOW(), INTERVAL 7 DAY) AND DATE_ADD(NOW(), INTERVAL 60 DAY)");
    }

    if (stylistId) {
      where.push("a.stylist_id = ?");
      params.push(Number(stylistId));
    }

    where.push(`a.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);

    const sql = `
      SELECT
        a.id,
        a.starts_at, a.ends_at, a.status,
        a.deposit_decimal, a.deposit_paid_at,
        a.service_id, a.stylist_id,
        s.name  AS service_name,
        s.duration_min,
        st.name AS stylist_name,
        st.color_hex,
        c.name  AS customer_name,
        c.phone_e164
      FROM appointment a
      JOIN customer c ON c.id = a.customer_id
      JOIN service  s ON s.id = a.service_id
      JOIN stylist st ON st.id = a.stylist_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.starts_at ASC
    `;

    const [rows] = await pool.query(sql, params);

    const events = rows.map((r) => ({
      id: r.id,
      title: `${r.service_name} • ${r.customer_name ?? "Cliente"}`,
      start: r.starts_at, // 'YYYY-MM-DD HH:MM:SS' ok para FullCalendar
      end: r.ends_at,
      extendedProps: {
        // estado / pago
        status: r.status,
        deposit_decimal: r.deposit_decimal,
        deposit_paid_at: r.deposit_paid_at,
        // ids para re-agendar
        service_id: r.service_id,
        stylist_id: r.stylist_id,
        // meta de front
        duration_min: r.duration_min,
        service_name: r.service_name,
        stylist_name: r.stylist_name,
        color_hex: r.color_hex,
        // cliente (WhatsApp, etc.)
        customer_name: r.customer_name,
        phone_e164: r.phone_e164,
      },
    }));

    res.json({ ok: true, events });
  } catch (e) {
    console.error("[/api/calendar/events] error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default calendar;
