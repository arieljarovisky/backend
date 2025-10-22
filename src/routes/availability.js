// src/routes/availability.js
import { Router } from "express";
import { pool } from "../db.js";
import { addMinutes, isBefore } from "date-fns";

export const availability = Router();

export async function getFreeSlots({ stylistId, serviceId, date, stepMin }) {
  if (!stylistId || !serviceId || !date) return { slots: [], busySlots: [] };

  // 1) Duración del servicio
  const [[svc]] = await pool.query(
    `SELECT duration_min FROM service WHERE id=? AND is_active=1`,
    [serviceId]
  );
  if (!svc) return { slots: [], busySlots: [] };
  const blockMin = Number(stepMin || svc.duration_min || 30);

  // 2) Working hours
  const weekday = new Date(`${date}T00:00:00`).getDay();
  const [whRows] = await pool.query(
    `SELECT start_time, end_time
       FROM working_hours
      WHERE stylist_id=? AND weekday=?`,
    [stylistId, weekday]
  );
  if (!whRows.length) return { slots: [], busySlots: [] };
  const { start_time, end_time } = whRows[0];

  const open = new Date(`${date}T${start_time}`);
  const close = new Date(`${date}T${end_time}`);

  // 3) Traer turnos y ausencias
  const [appts] = await pool.query(
    `SELECT starts_at, ends_at
       FROM appointment
      WHERE stylist_id=? AND status='scheduled' AND DATE(starts_at)=DATE(?)`,
    [stylistId, date]
  );
  const [offs] = await pool.query(
    `SELECT starts_at, ends_at
       FROM time_off
      WHERE stylist_id=? AND NOT(ends_at <= ? OR starts_at >= ?)`,
    [stylistId, open, close]
  );

  const busy = [
    ...appts.map((a) => [new Date(a.starts_at), new Date(a.ends_at)]),
    ...offs.map((o) => [new Date(o.starts_at), new Date(o.ends_at)]),
  ];

  console.log(`[AVAILABILITY] ${date} - ${busy.length} ocupados`); // ✅ Debug

  // 4) Generar todos los slots
  const allSlots = [];
  const busySlots = [];
  const now = new Date();

  for (
    let t = new Date(open);
    isBefore(addMinutes(t, blockMin), addMinutes(close, 1));
    t = addMinutes(t, blockMin)
  ) {
    const start = new Date(t);
    const end = addMinutes(start, blockMin);

    // Filtrar slots pasados
    if (start <= now) continue;

    const hh = String(start.getHours()).padStart(2, "0");
    const mm = String(start.getMinutes()).padStart(2, "0");
    const timeSlot = `${hh}:${mm}`;

    // Verificar solapamiento
    const overlap = busy.some(([b0, b1]) => start < b1 && end > b0);

    allSlots.push(timeSlot);
    if (overlap) {
      busySlots.push(timeSlot);
      console.log(`  ✗ ${timeSlot} - OCUPADO`); // ✅ Debug
    } else {
      console.log(`  ✓ ${timeSlot} - LIBRE`); // ✅ Debug
    }
  }

  console.log(`[RESULT] Total: ${allSlots.length}, Ocupados: ${busySlots.length}`); // ✅ Debug

  return {
    slots: allSlots,
    busySlots: busySlots,
  };
}

availability.get("/availability", async (req, res) => {
  try {
    const stylistId = Number(req.query.stylistId);
    const serviceId = Number(req.query.serviceId);
    const date = String(req.query.date || "");
    const stepMin = req.query.stepMin ? Number(req.query.stepMin) : undefined;

    if (!stylistId || !serviceId || !date) {
      return res.status(400).json({
        ok: false,
        error: "Parámetros requeridos: stylistId, serviceId, date",
      });
    }

    const result = await getFreeSlots({ stylistId, serviceId, date, stepMin });

    console.log("[API RESPONSE]", { // ✅ Debug
      slots: result.slots.length,
      busySlots: result.busySlots.length,
    });

    return res.json({
      ok: true,
      data: {
        slots: result.slots,
        busySlots: result.busySlots,
      },
    });
  } catch (e) {
    console.error("[GET /api/availability] error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});