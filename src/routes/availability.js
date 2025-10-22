// src/routes/availability.js
import { Router } from "express";
import { pool } from "../db.js";
import { addMinutes, isBefore } from "date-fns";

export const availability = Router();

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

  // 2) Working hours
  const weekday = new Date(`${date}T00:00:00`).getDay();
  const [whRows] = await pool.query(
    `SELECT start_time, end_time
       FROM working_hours
      WHERE stylist_id=? AND weekday=?`,
    [stylistId, weekday]
  );

  if (!whRows.length) {
    console.log(`❌ Sin horarios de trabajo para día ${weekday}`);
    return { slots: [], busySlots: [] };
  }

  const { start_time, end_time } = whRows[0];
  console.log(`🕐 Horario laboral: ${start_time} - ${end_time}`);

  const open = new Date(`${date}T${start_time}`);
  const close = new Date(`${date}T${end_time}`);

  // 4) traer turnos del día (scheduled) y ausencias que solapen
  const [appts] = await pool.query(
    `SELECT starts_at, ends_at
     FROM appointment
    WHERE stylist_id = ?
      AND status = 'scheduled'
      AND starts_at < ?
      AND ends_at   > ?`,
    [stylistId, close, open]
  );

  const [offs] = await pool.query(
    `SELECT starts_at, ends_at
     FROM time_off
    WHERE stylist_id = ?
      AND starts_at < ?
      AND ends_at   > ?`,
    [stylistId, close, open]
  );

  console.log(`📅 Turnos existentes: ${appts.length}, Ausencias: ${offs.length}`);

  // Crear array de intervalos ocupados
  const busy = [
    ...appts.map((a) => ({
      start: new Date(a.starts_at),
      end: new Date(a.ends_at),
      type: 'appointment',
      id: a.id
    })),
    ...offs.map((o) => ({
      start: new Date(o.starts_at),
      end: new Date(o.ends_at),
      type: 'time_off'
    })),
  ];

  console.log(`🔴 Total intervalos ocupados: ${busy.length}`);
  busy.forEach(b => {
    const s = b.start.toTimeString().slice(0, 5);
    const e = b.end.toTimeString().slice(0, 5);
    console.log(`   ${s} - ${e} (${b.type})`);
  });

  // 4) Generar todos los slots posibles
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

    // ❌ Filtrar slots pasados
    if (start <= now) continue;

    const hh = String(start.getHours()).padStart(2, "0");
    const mm = String(start.getMinutes()).padStart(2, "0");
    const timeSlot = `${hh}:${mm}`;

    // ⚡ Verificar solapamiento con CUALQUIER turno/ausencia
    const overlap = busy.some(({ start: b0, end: b1 }) => {
      // Un slot se solapa si:
      // - Empieza antes de que termine el turno ocupado
      // - Termina después de que empiece el turno ocupado
      return start < b1 && end > b0;
    });

    allSlots.push(timeSlot);

    if (overlap) {
      busySlots.push(timeSlot);
    }
  }

  console.log(`\n📊 Resultado:`);
  console.log(`   Total slots: ${allSlots.length}`);
  console.log(`   Ocupados: ${busySlots.length}`);
  console.log(`   Libres: ${allSlots.length - busySlots.length}`);
  console.log(`   Slots libres:`, allSlots.filter(s => !busySlots.includes(s)));

  return {
    slots: allSlots,
    busySlots: busySlots,
  };
}

/**
 * Endpoint GET /api/availability
 */
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

    console.log("\n✅ [API RESPONSE]");
    console.log(`   Enviando ${result.slots.length} slots, ${result.busySlots.length} ocupados`);

    return res.json({
      ok: true,
      data: {
        slots: result.slots,
        busySlots: result.busySlots,
      },
    });
  } catch (e) {
    console.error("\n❌ [GET /api/availability] error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});