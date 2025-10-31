// src/routes/availability.js
import { Router } from "express";
import { pool } from "../db.js";
import { addMinutes, isBefore } from "date-fns";
import { requireAuth } from "../auth/middlewares.js";

export const availability = Router();
availability.use(requireAuth);

/**
 * Obtiene slots libres y ocupados para un estilista/servicio/fecha
 * @returns {{ slots: string[], busySlots: string[] }}
 */
export async function getFreeSlots({ stylistId, serviceId, date, stepMin }) {
  if (!stylistId || !serviceId || !date) return { slots: [], busySlots: [] };

  console.log(`\n🔍 [AVAILABILITY] Consultando: stylist=${stylistId}, service=${serviceId}, date=${date}`);

  // 1) Duración del servicio
  const [[svc]] = await pool.query(
    `SELECT duration_min FROM service WHERE id=? AND is_active=1`,
    [serviceId]
  );
  if (!svc) {
    console.log("❌ Servicio no encontrado o inactivo");
    return { slots: [], busySlots: [] };
  }
  const blockMin = Number(stepMin || svc.duration_min || 30);
  console.log(`⏱️  Duración del servicio: ${svc.duration_min}min, Step: ${blockMin}min`);

  // --- 2) Working hours (soporta weekday 0-6 y 1-7) ---
  const jsWeekday = new Date(`${date}T00:00:00`).getDay(); // 0..6 (0=Dom)
  const altWeekday = jsWeekday === 0 ? 7 : jsWeekday;      // 1..7

  const [whRows] = await pool.query(
    `SELECT weekday, start_time, end_time
     FROM working_hours
    WHERE stylist_id = ?
      AND weekday IN (?, ?)
    ORDER BY start_time`,
    [stylistId, jsWeekday, altWeekday]
  );
  if (!whRows.length) {
    console.log(`❌ Sin horarios para wd=${jsWeekday} (alt=${altWeekday})`);
    return { slots: [], busySlots: [] };
  }

  if (!whRows.length) {
    // Log de ayuda para detectar cómo está cargada la tabla
    const [dbg] = await pool.query(
      `SELECT DISTINCT weekday, start_time, end_time
       FROM working_hours
      WHERE stylist_id = ?
      ORDER BY weekday, start_time`,
      [stylistId]
    );
    console.log(`❌ Sin horarios para el día ${jsWeekday} (alt ${altWeekday}). Horarios existentes para el estilista:`, dbg);
    return { slots: [], busySlots: [] };
  }

  console.log(
    `🕐 Horarios laborales (${whRows.length} intervalo/s):`,
    whRows.map(r => `${r.start_time}-${r.end_time} (wd=${r.weekday})`).join(" | ")
  );

  const OCCUPYING = ["scheduled", "pending_deposit", "deposit_paid", "confirmed"];
  const placeholders = OCCUPYING.map(() => "?").join(",");

  // para cubrir todo el día (no solo la ventana exacta de working hours)
  const dayOpen = new Date(`${date}T00:00:00`);
  const dayClose = new Date(`${date}T23:59:59`);

  const [appts] = await pool.query(
    `SELECT id, starts_at, ends_at, status
     FROM appointment
    WHERE stylist_id = ?
      AND starts_at < ?
      AND ends_at   > ?
      AND status IN (${placeholders})`,
    [stylistId, dayClose, dayOpen, ...OCCUPYING]
  );

  const [offs] = await pool.query(
    `SELECT starts_at, ends_at
     FROM time_off
    WHERE stylist_id = ?
      AND starts_at < ?
      AND ends_at   > ?`,
    [stylistId, dayClose, dayOpen]
  );

  console.log(`📅 Turnos existentes: ${appts.length}, Ausencias: ${offs.length}`);

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

  // --- 4) Generar slots sobre CADA intervalo laboral ---
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

      if (start <= now) continue; // no mostrar pasados

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

  console.log(`\n📊 Resultado: Total ${slotsArr.length}, Ocupados ${busyArr.length}, Libres ${slotsArr.length - busyArr.length}`);
  console.log(`   Slots libres:`, slotsArr.filter(s => !busyArr.includes(s)));

  return { slots: slotsArr, busySlots: busyArr };

}

// GET /api/availability
availability.get("/availability", async (req, res) => {
  try {
    const stylistId = Number(req.query.stylistId);
    const serviceId = Number(req.query.serviceId);
    const date = String(req.query.date || "");
    const stepMin = req.query.stepMin ? Number(req.query.stepMin) : undefined;

    if (!stylistId || !serviceId || !date) {
      return res.status(400).json({ ok: false, error: "Parámetros requeridos: stylistId, serviceId, date" });
    }

    const result = await getFreeSlots({ stylistId, serviceId, date, stepMin });

    console.log("\n✅ [API RESPONSE]");
    console.log(`   Enviando ${result.slots.length} slots, ${result.busySlots.length} ocupados`);

    res.json({ ok: true, data: { slots: result.slots, busySlots: result.busySlots } });
  } catch (e) {
    console.error("\n❌ [GET /api/availability] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
