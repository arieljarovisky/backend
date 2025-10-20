// src/routes/availability.js
import { Router } from "express";
import { pool } from "../db.js";
import { addMinutes, isBefore, parseISO } from "date-fns";

export const availability = Router();

/**
 * Devuelve los HH:mm disponibles para un estilista en una fecha dada,
 * tomando como bloque la duración del servicio (o stepMin si se provee).
 *
 * @param {Object} params
 * @param {number} params.stylistId
 * @param {number} params.serviceId
 * @param {string} params.date       // 'YYYY-MM-DD'
 * @param {number=} params.stepMin   // opcional, override de bloque
 * @returns {Promise<string[]>}      // ['10:00','10:30',...]
 */
export async function getFreeSlots({ stylistId, serviceId, date, stepMin }) {
  if (!stylistId || !serviceId || !date) return [];

  // 1) duración del servicio
  const [[svc]] = await pool.query(
    `SELECT duration_min FROM service WHERE id=? AND is_active=1`,
    [serviceId]
  );
  if (!svc) return [];
  const blockMin = Number(stepMin || svc.duration_min || 30);

  // 2) working hours del día (weekday 0..6)
  const weekday = new Date(`${date}T00:00:00`).getDay();
  const [whRows] = await pool.query(
    `SELECT start_time, end_time
       FROM working_hours
      WHERE stylist_id=? AND weekday=?`,
    [stylistId, weekday]
  );
  if (!whRows.length) return [];
  const { start_time, end_time } = whRows[0];

  // 3) Armar rango del día en UTC (usamos la hora "local" del server)
  //    Si prefieres, podrías ajustar a una TZ fija con date-fns-tz.
  const open = new Date(`${date}T${start_time}`);
  const close = new Date(`${date}T${end_time}`);

  // 4) traer turnos del día (scheduled) y ausencias que solapen
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

  // normalizar intervalos ocupados
  const busy = [
    ...appts.map(a => [new Date(a.starts_at), new Date(a.ends_at)]),
    ...offs.map(o => [new Date(o.starts_at), new Date(o.ends_at)]),
  ];

  // 5) generar slots saltando por blockMin
  const out = [];
  for (let t = new Date(open); isBefore(addMinutes(t, blockMin), addMinutes(close, 1)); t = addMinutes(t, blockMin)) {
    const start = new Date(t);
    const end = addMinutes(start, blockMin);

    // verificar solape
    const overlap = busy.some(([b0, b1]) => start < b1 && end > b0);
    if (!overlap) {
      const hh = String(start.getHours()).padStart(2, "0");
      const mm = String(start.getMinutes()).padStart(2, "0");
      out.push(`${hh}:${mm}`);
    }
  }
  return out;
}

/**
 * GET /api/availability?stylistId=1&serviceId=2&date=2025-10-22&stepMin=10
 */
availability.get("/availability", async (req, res) => {
  try {
    const stylistId = Number(req.query.stylistId);
    const serviceId = Number(req.query.serviceId);
    const date = String(req.query.date || "");
    const stepMin = req.query.stepMin ? Number(req.query.stepMin) : undefined;

    if (!stylistId || !serviceId || !date) {
      return res.status(400).json({ ok:false, error:"Parámetros requeridos: stylistId, serviceId, date" });
    }

    const slots = await getFreeSlots({ stylistId, serviceId, date, stepMin });
    return res.json({ ok:true, data:{ slots } });
  } catch (e) {
    console.error("[GET /api/availability] error:", e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});
