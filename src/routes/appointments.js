// src/routes/appointments.js
import { Router } from "express";
import { pool } from "../db.js";
import { addMinutes, isAfter, isBefore, parseISO } from "date-fns";

// ====== WhatsApp (opcional) ======
// Si no tenés el módulo o no querés enviar WhatsApp, no pasa nada.
let sendWhatsAppText = null;
try {
  const m = await import("../whatsapp.js");
  sendWhatsAppText = m.sendWhatsAppText || m.waSendText || null;
} catch (_) { /* noop */ }

// =================================
export const appointments = Router();
// =================================

// ---------- Helpers comunes ----------

/** Devuelve { start_time, end_time } para (stylistId, date 'YYYY-MM-DD') o null */
async function getWorkingHoursForDate(stylistId, dateStr) {
  // 0=Dom ... 6=Sab (coincide con getDay())
  const weekday = new Date(`${dateStr}T00:00:00`).getDay();
  const [rows] = await pool.query(
    `SELECT start_time, end_time
       FROM working_hours
      WHERE stylist_id=? AND weekday=?`,
    [stylistId, weekday]
  );
  if (!rows.length) return null;
  return rows[0];
}

/** Chequea que [start, end] esté dentro del horario laboral del día */
function insideWorkingHours(dateStr, start_time, end_time, start, end) {
  const dayStart = new Date(`${dateStr}T${start_time}`);
  const dayEnd = new Date(`${dateStr}T${end_time}`);
  return !isBefore(start, dayStart) && !isAfter(end, dayEnd);
}

/** ¿Hay solape entre [start,end] y la lista intervals (starts_at/ends_at)? */
function hasOverlap(intervals, start, end) {
  for (const it of intervals) {
    const s = new Date(it.starts_at);
    const e = new Date(it.ends_at);
    // Solapa si NO se cumple (e <= start OR s >= end)
    if (!(e <= start || s >= end)) return true;
  }
  return false;
}

/** Formato legible local (es-AR) */
function fmtLocal(iso) {
  const d = new Date(iso);
  const f = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
  const h = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  return `${f} ${h}`;
}

// =====================================================
// ========== Servicio reutilizable (exportado) =========
// =====================================================
/**
 * createAppointment({ customerPhone, customerName?, stylistId, serviceId, startsAt })
 *  - customerPhone: "54911..." (solo dígitos)
 *  - startsAt: ISO con tz (ej "2025-10-22T15:30:00-03:00") o con Z
 * Lanza Error con mensajes entendibles en caso de validación.
 */
export async function createAppointment({
  customerPhone,
  customerName = null,
  stylistId,
  serviceId,
  startsAt
}) {
  if (!customerPhone || !stylistId || !serviceId || !startsAt) {
    throw new Error("Faltan campos requeridos");
  }

  const bufferMin = Number(process.env.APPT_BUFFER_MIN || 0);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Servicio activo y duración
    const [[srv]] = await conn.query(
      `SELECT name, duration_min FROM service WHERE id=? AND is_active=1`,
      [serviceId]
    );
    if (!srv) throw new Error("Servicio inexistente o inactivo");

    // 2) Parseo de fecha/hora
    const start = parseISO(startsAt);           // respeta la zona enviada
    if (isNaN(start)) throw new Error("Fecha inválida");
    const end = addMinutes(start, Number(srv.duration_min));

    // 3) Valida horario laboral del día
    //    dateStr en zona local del server (normalizamos con TZ offset del start)
    const dateStr = new Date(start.getTime() - start.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 10);
    const wh = await getWorkingHoursForDate(stylistId, dateStr);
    if (!wh) throw new Error("El peluquero no tiene horarios definidos para ese día");
    if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, start, end)) {
      throw new Error("El turno cae fuera del horario laboral del día");
    }

    // 4) Estilista activo
    const [[{ cnt: existsStylist }]] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM stylist WHERE id=? AND is_active=1`,
      [stylistId]
    );
    if (!existsStylist) throw new Error("Peluquero inexistente o inactivo");

    // 5) Solapes (con buffer)
    const startWithBuffer = addMinutes(start, -bufferMin);
    const endWithBuffer = addMinutes(end, bufferMin);

    const [appts] = await conn.query(
      `SELECT starts_at, ends_at
         FROM appointment
        WHERE stylist_id=? AND status='scheduled'
          AND NOT(ends_at <= ? OR starts_at >= ?)`,
      [stylistId, startWithBuffer, endWithBuffer]
    );
    const [offs] = await conn.query(
      `SELECT starts_at, ends_at
         FROM time_off
        WHERE stylist_id=? 
          AND NOT(ends_at <= ? OR starts_at >= ?)`,
      [stylistId, startWithBuffer, endWithBuffer]
    );
    if (hasOverlap(appts, startWithBuffer, endWithBuffer) ||
      hasOverlap(offs, startWithBuffer, endWithBuffer)) {
      throw new Error("Horario no disponible (solapado o buffer)");
    }

    // 6) Upsert cliente por teléfono
    await conn.query(
      `INSERT INTO customer (name, phone_e164) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)`,
      [customerName ?? null, customerPhone]
    );
    const [[cust]] = await conn.query(
      `SELECT id, name, phone_e164 FROM customer WHERE phone_e164=?`,
      [customerPhone]
    );

    // 7) Insert turno
    const [result] = await conn.query(
      `INSERT INTO appointment (customer_id, stylist_id, service_id, starts_at, ends_at, status, created_at)
       VALUES (?,?,?,?,?, 'scheduled', NOW())`,
      [cust.id, stylistId, serviceId, start, end]
    );

    await conn.commit();

    // 8) WhatsApp best-effort (no afecta el OK de la reserva)
    if (sendWhatsAppText) {
      try {
        const [[sty]] = await pool.query(`SELECT name FROM stylist WHERE id=?`, [stylistId]);
        const msg = `¡Turno reservado! ✅
Servicio: *${srv.name}*
Peluquero: *${sty?.name ?? ""}*
Fecha: *${fmtLocal(start)}*`;
        await sendWhatsAppText(cust.phone_e164, msg);
      } catch (waErr) {
        console.warn("[WA] No se pudo enviar confirmación:", waErr?.message);
      }
    }

    return { ok: true, id: result.insertId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
export async function listUpcomingAppointmentsByPhone(phone_e164, { limit = 5 } = {}) {
  if (!phone_e164) return [];
  const [rows] = await pool.query(
    `SELECT a.id,
            a.starts_at, a.ends_at, a.status,
            s.name  AS service_name,
            st.name AS stylist_name
       FROM appointment a
       JOIN customer  c  ON c.id  = a.customer_id
       JOIN service   s  ON s.id  = a.service_id
       JOIN stylist   st ON st.id = a.stylist_id
      WHERE c.phone_e164 = ?
        AND a.status = 'scheduled'
        AND a.starts_at >= NOW()
      ORDER BY a.starts_at ASC
      LIMIT ?`,
    [String(phone_e164).replace(/\D/g, ""), limit]
  );
  return rows;
}

// ======================================
// ============ Rutas REST ==============
// ======================================

/**
 * GET /api/appointments?from=ISO&to=ISO&stylistId=#
 * Devuelve turnos con joins útiles para calendario.
 */
appointments.get("/appointments", async (req, res) => {
  try {
    const { from, to, stylistId } = req.query;

    const params = [];
    let where = "1=1";
    if (from) { where += " AND a.starts_at >= ?"; params.push(new Date(from)); }
    if (to) { where += " AND a.starts_at <  ?"; params.push(new Date(to)); }
    if (stylistId) { where += " AND a.stylist_id = ?"; params.push(Number(stylistId)); }

    const [rows] = await pool.query(
      `SELECT a.id, a.customer_id, a.stylist_id, a.service_id,
              a.starts_at, a.ends_at, a.status,
              c.name AS customer_name, c.phone_e164,
              s.name AS service_name,
              st.name AS stylist_name, st.color_hex
         FROM appointment a
         JOIN customer c ON c.id = a.customer_id
         JOIN service  s ON s.id = a.service_id
         JOIN stylist st ON st.id = a.stylist_id
        WHERE ${where}
        ORDER BY a.starts_at ASC`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error("[GET /api/appointments] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/appointments
 * body: { customerPhone, customerName?, stylistId, serviceId, startsAt(ISO) }
 * Usa createAppointment(...) internamente.
 */
appointments.post("/appointments", async (req, res) => {
  try {
    const result = await createAppointment(req.body || {});
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * PATCH /api/appointments/:id
 * body: { status: 'scheduled' | 'cancelled' | 'done' }
 */
appointments.patch("/appointments/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!id || !["scheduled", "cancelled", "done"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Datos inválidos" });
  }
  try {
    const [r] = await pool.query(
      `UPDATE appointment SET status=? WHERE id=?`,
      [status, id]
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
