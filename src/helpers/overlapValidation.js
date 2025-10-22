// src/helpers/overlapValidation.js
import { addMinutes } from "date-fns";

export function toMySQLDateTime(val) {
  if (!val) return null;
  const d = (val instanceof Date) ? val : new Date(String(val));
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function parseDateTime(s) {
  if (!s) return null;
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    if (s.length === 16) s += ":00";
    return new Date(s.replace(" ", "T"));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Verifica solapes de turnos/ausencias para EL MISMO peluquero.
 * Si hay solape => lanza Error.
 * - db: pool o conn (ambos tienen .query)
 * - useLock: true si estás dentro de BEGIN con `conn` para hacer FOR UPDATE (evita carreras).
 */
export async function checkAppointmentOverlap(db, {
  stylistId,
  startTime,     // Date
  endTime,       // Date
  bufferMinutes = 0,
  excludeId = null,
  useLock = true
}) {
  if (!stylistId || !startTime || !endTime) {
    throw new Error("Parámetros insuficientes para validar solape");
  }

  const startWithBuffer = addMinutes(startTime, -Number(bufferMinutes || 0));
  const endWithBuffer   = addMinutes(endTime,  Number(bufferMinutes || 0));

  const startStr = toMySQLDateTime(startWithBuffer);
  const endStr   = toMySQLDateTime(endWithBuffer);

  let sqlAppt = `
    SELECT id
      FROM appointment
     WHERE stylist_id = ?
       AND starts_at < ?
       AND ends_at   > ?
  `;
  const params = [Number(stylistId), endStr, startStr];
  if (excludeId) { sqlAppt += " AND id <> ?"; params.push(Number(excludeId)); }
  if (useLock)   { sqlAppt += " FOR UPDATE"; }   // ← clave cuando estás en transacción

  const [appts] = await db.query(sqlAppt, params);

  let sqlOff = `
    SELECT id
      FROM time_off
     WHERE stylist_id = ?
       AND starts_at < ?
       AND ends_at   > ?
  `;
  const paramsOff = [Number(stylistId), endStr, startStr];
  if (useLock) { sqlOff += " FOR UPDATE"; }

  const [offs] = await db.query(sqlOff, paramsOff);

  if (appts.length > 0 || offs.length > 0) {
    throw new Error("Ese horario se superpone con otro turno o ausencia del peluquero");
  }
}
