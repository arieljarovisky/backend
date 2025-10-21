// src/routes/appointments.js
import { Router } from "express";
import { pool } from "../db.js";
import { addMinutes, isAfter, isBefore, parseISO } from "date-fns";
// ⚙️ Crea turno con todas las validaciones y en transacción
export async function createAppointment({
  customerPhone,
  customerName = null,
  stylistId,
  serviceId,
  startsAt,           // ISO o "YYYY-MM-DD HH:MM:SS"
  endsAt = null,      // opcional, si no viene se calcula por duración del servicio
  status = "scheduled",
  durationMin = null, // fallback por si no hay tabla service
}) {
  if (!customerPhone || !stylistId || !serviceId || !startsAt) {
    throw new Error("Faltan campos requeridos");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) upsert cliente por teléfono
    await conn.query(
      `INSERT INTO customer (name, phone_e164) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)`,
      [customerName ?? null, String(customerPhone).replace(/[\s-]/g, "")]
    );
    const [[cust]] = await conn.query(
      `SELECT id, phone_e164 FROM customer WHERE phone_e164=? LIMIT 1`,
      [String(customerPhone).replace(/[\s-]/g, "")]
    );

    // 2) fechas
    const startMySQL = anyToMySQL(startsAt);
    if (!startMySQL) throw new Error("Fecha/hora inválida");

    let endMySQL = anyToMySQL(endsAt);
    if (!endMySQL) {
      const dur = await resolveServiceDuration(serviceId, durationMin);
      if (!dur) throw new Error("No se pudo determinar la duración del servicio");
      const [[{ calc_end }]] = await conn.query(
        "SELECT DATE_ADD(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS calc_end",
        [startMySQL, dur]
      );
      endMySQL = anyToMySQL(calc_end);
    }
    // 3) horario laboral por peluquero
    const dateStr = startMySQL.slice(0, 10);
    const [[wh]] = await conn.query(
      `SELECT start_time, end_time FROM working_hours WHERE stylist_id=? AND weekday=? LIMIT 1`,
      [stylistId, new Date(`${dateStr}T00:00:00`).getDay()]
    );
    if (!wh) throw new Error("El peluquero no tiene horarios definidos para ese día");
    const startDate = new Date(startMySQL.replace(" ", "T"));
    const endDate = new Date(endMySQL.replace(" ", "T"));
    const dayStart = new Date(`${dateStr}T${wh.start_time}`);
    const dayEnd = new Date(`${dateStr}T${wh.end_time}`);
    if (startDate < dayStart || endDate > dayEnd) {
      throw new Error("Fuera del horario laboral");
    }

    // 4) solape (con buffer opcional)
    const bufferMin = Number(process.env.APPT_BUFFER_MIN || 0);
    const startBuf = new Date(startDate.getTime() - bufferMin * 60000);
    const endBuf = new Date(endDate.getTime() + bufferMin * 60000);
    const [appts] = await conn.query(
      `SELECT 1
         FROM appointment
        WHERE stylist_id=?
          AND NOT(ends_at <= ? OR starts_at >= ?)
        LIMIT 1`,
      [stylistId, endBuf, startBuf]
    );
    const [offs] = await conn.query(
      `SELECT 1
         FROM time_off
        WHERE stylist_id=?
          AND NOT(ends_at <= ? OR starts_at >= ?)
        LIMIT 1`,
      [stylistId, endBuf, startBuf]
    );
    if (appts.length || offs.length) {
      throw new Error("Horario no disponible (solapado o buffer)");
    }

    // 5) inserción
    const [r] = await conn.query(
      `INSERT INTO appointment (customer_id, stylist_id, service_id, starts_at, ends_at, status, created_at)
       VALUES (?,?,?,?,?, ?, NOW())`,
      [cust.id, Number(stylistId), Number(serviceId), startMySQL, endMySQL, status]
    );

    await conn.commit();
    return { ok: true, id: r.insertId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}


function anyToMySQL(val) {
  if (!val) return null;
  const fmt = (d) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // Si ya es Date, lo tomamos como local
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return fmt(val);
  }

  if (typeof val === "string") {
    let s = val.trim();

    // Caso 1: viene "YYYY-MM-DDTHH:MM(:SS)" sin Z → local
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      return s.replace("T", " ");
    }

    // Caso 2: viene "YYYY-MM-DD HH:MM(:SS)" ya listo
    if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      return s.length === 16 ? s + ":00" : s;
    }

    // Caso 3: trae Z (UTC) → le aplicamos offset local
    if (s.endsWith("Z")) {
      const d = new Date(s);
      return fmt(new Date(d.getTime() - d.getTimezoneOffset() * 60000));
    }
  }

  return null;
}
function fmtLocal(iso) {
  const d = new Date(iso);
  const f = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
  const h = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  return `${f} ${h}`;
}

/* ========= Horario laboral por peluquero (DB) ========= */

async function getWorkingHoursForDate(stylistId, dateStr) {
  // 0=Dom ... 6=Sáb (coincide con getDay())
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

function insideWorkingHours(dateStr, start_time, end_time, start, end) {
  const dayStart = new Date(`${dateStr}T${start_time}`);
  const dayEnd = new Date(`${dateStr}T${end_time}`);
  return !isBefore(start, dayStart) && !isAfter(end, dayEnd);
}

/* ========= Solapes ========= */

// Versión DB (consulta turnos/time_off); evita nombre duplicado.
async function hasOverlapDB({ stylistId, start, end, bufferMin = 0, excludingId = null }) {
  const startWithBuffer = addMinutes(start, -bufferMin);
  const endWithBuffer = addMinutes(end, bufferMin);

  const paramsAppt = [stylistId, startWithBuffer, endWithBuffer];
  let sqlAppt = `
    SELECT starts_at, ends_at
      FROM appointment
     WHERE stylist_id = ?
       AND NOT(ends_at <= ? OR starts_at >= ?)
  `;
  if (excludingId) { sqlAppt += " AND id <> ?"; paramsAppt.push(excludingId); }

  const [appts] = await pool.query(sqlAppt, paramsAppt);
  const [offs] = await pool.query(
    `SELECT starts_at, ends_at
       FROM time_off
      WHERE stylist_id = ?
        AND NOT(ends_at <= ? OR starts_at >= ?)`,
    [stylistId, startWithBuffer, endWithBuffer]
  );

  // Chequeo simple en memoria
  const overlapsIntervals = (intervals) => {
    for (const it of intervals) {
      const s = new Date(it.starts_at);
      const e = new Date(it.ends_at);
      if (!(e <= startWithBuffer || s >= endWithBuffer)) return true;
    }
    return false;
  };

  return overlapsIntervals(appts) || overlapsIntervals(offs);
}

/* ========= Servicios / Duración ========= */

async function resolveServiceDuration(serviceId, fallbackDurationMin) {
  try {
    if (serviceId) {
      const [[row]] = await pool.query(
        "SELECT duration_min FROM service WHERE id = ? LIMIT 1",
        [serviceId]
      );
      if (row && row.duration_min != null) return Number(row.duration_min);
    }
  } catch (_) { }
  return fallbackDurationMin != null ? Number(fallbackDurationMin) : null;
}

/* ========= Clientes ========= */

function normPhone(p) {
  if (!p) return null;
  return String(p).replace(/[\s-]/g, "");
}

async function ensureCustomerId({ name, phone }) {
  const phoneNorm = normPhone(phone);
  if (!phoneNorm) return null;
  const [rows] = await pool.query(
    "SELECT id FROM customer WHERE phone_e164 = ? LIMIT 1",
    [phoneNorm]
  );
  if (rows.length) return rows[0].id;

  const [ins] = await pool.query(
    "INSERT INTO customer (name, phone_e164) VALUES (?, ?)",
    [name || null, phoneNorm]
  );
  return ins.insertId;
}

/* ========= WhatsApp (opcional) ========= */

let sendWhatsAppText = null;
try {
  const m = await import("../whatsapp.js");
  sendWhatsAppText = m.sendWhatsAppText || m.waSendText || null;
} catch (_) { }

/* ========= Router ========= */

export const appointments = Router();

/* -------- GET /api/appointments -------- */
appointments.get("/", async (req, res) => {
  try {
    const { from, to, stylistId } = req.query;
    let sql = `
      SELECT a.id, a.customer_id, a.stylist_id, a.service_id, a.status,
             DATE_FORMAT(a.starts_at, '%Y-%m-%dT%H:%i:%s') AS starts_at,
             DATE_FORMAT(a.ends_at,   '%Y-%m-%dT%H:%i:%s') AS ends_at,
             c.name  AS customer_name, c.phone_e164,
             s.name  AS service_name,
             st.name AS stylist_name, st.color_hex
        FROM appointment a
        JOIN customer  c  ON c.id  = a.customer_id
        JOIN service   s  ON s.id  = a.service_id
        JOIN stylist   st ON st.id = a.stylist_id
       WHERE 1=1
    `;
    const p = [];
    if (from && to) { sql += " AND a.starts_at BETWEEN ? AND ?"; p.push(from, to); }
    if (stylistId) { sql += " AND a.stylist_id = ?"; p.push(stylistId); }
    sql += " ORDER BY a.starts_at";
    const [rows] = await pool.query(sql, p);
    res.json({ ok: true, appointments: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- POST /api/appointments -------- */
appointments.post("/", async (req, res) => {
  const logPrefix = "[POST /api/appointments]";
  try {
    const { customerName, customerPhone, stylistId, serviceId, startsAt, endsAt, status, durationMin } = req.body;

    console.log(logPrefix, "payload:", {
      customerName, customerPhone, stylistId, serviceId, startsAt, endsAt, status, durationMin
    });

    // 1) cliente
    const customerId = await ensureCustomerId({ name: customerName, phone: customerPhone });
    if (!customerId) {
      console.warn(logPrefix, "Falta teléfono del cliente");
      return res.status(400).json({ ok: false, error: "Falta teléfono del cliente" });
    }

    // 2) fechas: inicio
    const startMySQL = anyToMySQL(startsAt);
    if (!startMySQL) {
      console.warn(logPrefix, "Fecha/hora inválida:", startsAt);
      return res.status(400).json({ ok: false, error: "Fecha/hora inválida" });
    }


    // 3) fin: calcular si no viene
    let endMySQL = anyToMySQL(endsAt);
    if (!endMySQL) {
      const dur = await resolveServiceDuration(serviceId, durationMin);
      if (!dur) {
        console.warn(logPrefix, "No se pudo determinar la duración", { serviceId, durationMin });
        return res.status(400).json({ ok: false, error: "No se pudo determinar la duración del servicio" });
      }
      const [[{ calc_end }]] = await pool.query(
        "SELECT DATE_ADD(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS calc_end",
        [startMySQL, dur]
      );
      endMySQL = anyToMySQL(calc_end);
    }

    // 4) horario laboral (working_hours)
    const dateStr = startMySQL.slice(0, 10);
    const wh = await getWorkingHoursForDate(stylistId, dateStr);
    if (!wh) {
      console.warn(logPrefix, "Sin working_hours para ese día/peluquero", { stylistId, dateStr });
      return res.status(400).json({ ok: false, error: "El peluquero no tiene horarios definidos para ese día" });
    }
    const startDate = new Date(startMySQL.replace(" ", "T"));
    const endDate = new Date(endMySQL.replace(" ", "T"));
    if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
      console.warn(logPrefix, "Fuera de horario laboral", { startMySQL, endMySQL, wh });
      return res.status(400).json({ ok: false, error: "Fuera del horario laboral" });
    }

    // 5) solape
    const bufferMin = Number(process.env.APPT_BUFFER_MIN || 0);
    const overlap = await hasOverlapDB({ stylistId: Number(stylistId), start: startDate, end: endDate, bufferMin });
    if (overlap) {
      console.warn(logPrefix, "Solapamiento", { stylistId, startMySQL, endMySQL });
      return res.status(409).json({ ok: false, error: "Ese horario se superpone con otro turno del mismo peluquero" });
    }

    // 6) insertar
    const [r] = await pool.query(
      `INSERT INTO appointment (customer_id, stylist_id, service_id, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [customerId, Number(stylistId), Number(serviceId), startMySQL, endMySQL, status || "scheduled"]
    );

    console.log(logPrefix, "OK created id:", r.insertId);
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    console.error("[POST /api/appointments] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- PUT /api/appointments/:id -------- */
appointments.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};

    // (opcional) re-asignar cliente por teléfono
    let newCustomerId = null;
    if (b.customerPhone || b.phone_e164) {
      newCustomerId = await ensureCustomerId({ name: b.customerName ?? b.customer_name, phone: b.customerPhone ?? b.phone_e164 });
    }

    const stylistId = b.stylistId ?? b.stylist_id ?? null;
    const serviceId = b.serviceId ?? b.service_id ?? null;

    const startMySQL = anyToMySQL(startsAt);
    let endMySQL = anyToMySQL(endsAt);

    // Si no vino endsAt válido, lo calculo con la duración del servicio:
    if (!endMySQL) {
      const dur = await resolveServiceDuration(serviceId, durationMin);
      if (!dur || !startMySQL) {
        return res.status(400).json({ ok: false, error: "No se pudo determinar la duración/fecha" });
      }
      const [[{ calc_end }]] = await pool.query(
        "SELECT DATE_ADD(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS calc_end",
        [startMySQL, dur]
      );
      endMySQL = anyToMySQL(calc_end);
    }


    if (startMySQL && endMySQL) {
      const dateStr = startMySQL.slice(0, 10);
      const wh = await getWorkingHoursForDate(stylistId, dateStr);
      if (!wh) return res.status(400).json({ ok: false, error: "El peluquero no tiene horarios definidos para ese día" });
      const startDate = new Date(startMySQL.replace(" ", "T"));
      const endDate = new Date(endMySQL.replace(" ", "T"));
      if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
        return res.status(400).json({ ok: false, error: "Fuera del horario laboral" });
      }
      if (stylistId && await hasOverlapDB({ stylistId: Number(stylistId), start: startDate, end: endDate, excludingId: id })) {
        return res.status(409).json({ ok: false, error: "Ese horario se superpone con otro turno del mismo peluquero" });
      }
    }

    const [r] = await pool.query(
      `UPDATE appointment
          SET customer_id = COALESCE(?, customer_id),
              stylist_id  = COALESCE(?, stylist_id),
              service_id  = COALESCE(?, service_id),
              starts_at   = COALESCE(?, starts_at),
              ends_at     = COALESCE(?, ends_at),
              status      = COALESCE(?, status)
        WHERE id = ?`,
      [newCustomerId, stylistId, serviceId, startMySQL, endMySQL, status, id]
    );

    if (r.affectedRows === 0) return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- DELETE /api/appointments/:id -------- */
appointments.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [r] = await pool.query(`DELETE FROM appointment WHERE id=?`, [id]);
    if (r.affectedRows === 0) return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- Utilidad opcional -------- */
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
