// src/routes/availability.js — MULTI-TENANT
import { Router } from "express";
import { pool } from "../db.js";
import { addMinutes, isBefore } from "date-fns";
import { requireAuth } from "../auth/middlewares.js";

export const availability = Router();
availability.use(requireAuth);

/**
 * Core: obtiene slots libres/ocupados (requiere tenantId)
 * @returns {{ slots: string[], busySlots: string[] }}
 */
export async function getFreeSlots({ tenantId, stylistId, serviceId, date, stepMin }) {
  if (!tenantId || !stylistId || !serviceId || !date) return { slots: [], busySlots: [] };

  // 1) Duración del servicio (scoped)
  const [[svc]] = await pool.query(
    `SELECT duration_min 
       FROM service 
      WHERE id=? AND tenant_id=? AND is_active=1`,
    [serviceId, tenantId]
  );
  if (!svc) return { slots: [], busySlots: [] };

  const blockMin = Number(stepMin || svc.duration_min || 30);

  // --- 2) Working hours (weekday 0..6 y 1..7) ---
  const jsWeekday = new Date(`${date}T00:00:00`).getDay(); // 0=Dom
  const altWeekday = jsWeekday === 0 ? 7 : jsWeekday;

  const [whRows] = await pool.query(
    `SELECT weekday, start_time, end_time
       FROM working_hours
      WHERE tenant_id=? 
        AND stylist_id=? 
        AND weekday IN (?, ?)
      ORDER BY start_time`,
    [tenantId, stylistId, jsWeekday, altWeekday]
  );
  if (!whRows.length) return { slots: [], busySlots: [] };

  const OCCUPYING = ["scheduled", "pending_deposit", "deposit_paid", "confirmed"];
  const placeholders = OCCUPYING.map(() => "?").join(",");

  const dayOpen = new Date(`${date}T00:00:00`);
  const dayClose = new Date(`${date}T23:59:59`);

  // 3) Turnos existentes (scoped)
  const [appts] = await pool.query(
    `SELECT id, starts_at, ends_at, status
       FROM appointment
      WHERE tenant_id=? 
        AND stylist_id=? 
        AND starts_at < ? 
        AND ends_at   > ? 
        AND status IN (${placeholders})`,
    [tenantId, stylistId, dayClose, dayOpen, ...OCCUPYING]
  );

  // 4) Bloqueos del estilista (scoped)
  const [offs] = await pool.query(
    `SELECT starts_at, ends_at
       FROM time_off
      WHERE tenant_id=? 
        AND stylist_id=? 
        AND starts_at < ? 
        AND ends_at   > ?`,
    [tenantId, stylistId, dayClose, dayOpen]
  );

  const BUFFER_MIN = Number(process.env.APPT_BUFFER_MIN || 0);
  const busy = [
    ...appts.map(a => ({
      start: addMinutes(new Date(a.starts_at), -BUFFER_MIN),
      end: addMinutes(new Date(a.ends_at), +BUFFER_MIN),
    })),
    ...offs.map(o => ({
      start: new Date(o.starts_at),
      end: new Date(o.ends_at),
    })),
  ];

  // 5) Generar slots por cada intervalo laboral
  const allSlots = new Set();
  const busySlots = new Set();
  const now = new Date();

  for (const wh of whRows) {
    const open = new Date(`${date}T${wh.start_time}`);
    const close = new Date(`${date}T${wh.end_time}`);

    for (let t = new Date(open);
      isBefore(addMinutes(t, blockMin), addMinutes(close, 1));
      t = addMinutes(t, blockMin)) {

      const start = new Date(t);
      const end = addMinutes(start, blockMin);
      if (start <= now) continue;

      const hh = String(start.getHours()).padStart(2, "0");
      const mm = String(start.getMinutes()).padStart(2, "0");
      const timeSlot = `${hh}:${mm}`;

      const solapa = busy.some(({ start: b0, end: b1 }) => start < b1 && end > b0);

      allSlots.add(timeSlot);
      if (solapa) busySlots.add(timeSlot);
    }
  }

  const slotsArr = Array.from(allSlots).sort();
  const busyArr = Array.from(busySlots).sort();

  return { slots: slotsArr, busySlots: busyArr };
}

// GET /api/availability
availability.get("/availability", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const stylistId = Number(req.query.stylistId);
    const serviceId = Number(req.query.serviceId);
    const date = String(req.query.date || "");
    const stepMin = req.query.stepMin ? Number(req.query.stepMin) : undefined;

    if (!stylistId || !serviceId || !date) {
      return res.status(400).json({ ok: false, error: "Parámetros requeridos: stylistId, serviceId, date" });
    }

    const result = await getFreeSlots({ tenantId, stylistId, serviceId, date, stepMin });
    res.json({ ok: true, data: { slots: result.slots, busySlots: result.busySlots } });
  } catch (e) {
    console.error("❌ [GET /api/availability] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
