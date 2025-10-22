// src/routes/appointments.js
import { Router } from "express";
import { pool } from "../db.js";
import { addMinutes, isAfter, isBefore } from "date-fns";
import { validateAppointmentDate } from "../helpers/dateValidation.js";

/* ================== Helpers de fecha ================== */
function anyToMySQL(val) {
  if (!val) return null;

  const fmt = (d) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  if (val instanceof Date && !Number.isNaN(val.getTime())) return fmt(val);

  if (typeof val === "string") {
    let s = val.trim();

    // "YYYY-MM-DDTHH:MM(:SS)?" -> local (solo reemplazo la T)
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      s = s.replace("T", " ");
      return s.length === 16 ? s + ":00" : s.slice(0, 19);
    }

    // "YYYY-MM-DD HH:MM(:SS)?" -> ya está
    if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      return s.length === 16 ? s + ":00" : s.slice(0, 19);
    }

    // Si trae Z / offset → convertir a local
    if (/[Zz]$/.test(s) || /[+\-]\d{2}:\d{2}$/.test(s)) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return fmt(d);
    }

    return null;
  }

  if (typeof val === "number") {
    const ms = val > 1e12 ? val : val * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return fmt(d);
  }

  return null;
}

function fmtLocal(iso) {
  const d = new Date(iso);
  const f = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
  const h = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  return `${f} ${h}`;
}

/* ========= Working hours ========= */
async function getWorkingHoursForDate(stylistId, dateStr) {
  const weekday = new Date(`${dateStr}T00:00:00`).getDay(); // 0..6
  const [rows] = await pool.query(
    `SELECT start_time, end_time
       FROM working_hours
      WHERE stylist_id=? AND weekday=? LIMIT 1`,
    [stylistId, weekday]
  );
  return rows[0] || null;
}

function insideWorkingHours(dateStr, start_time, end_time, start, end) {
  const dayStart = new Date(`${dateStr}T${start_time}`);
  const dayEnd = new Date(`${dateStr}T${end_time}`);
  return !isBefore(start, dayStart) && !isAfter(end, dayEnd);
}

/* ========= Overlaps ========= */
async function hasOverlapDB({ stylistId, start, end, bufferMin = 0, excludingId = null }) {
  const startWithBuffer = addMinutes(start, -bufferMin);
  const endWithBuffer = addMinutes(end, bufferMin);

  const paramsAppt = [stylistId, endWithBuffer, startWithBuffer];
  let sqlAppt = `
    SELECT 1
      FROM appointment
     WHERE stylist_id = ?
       AND starts_at < ?
       AND ends_at   > ?
  `;
  if (excludingId) { sqlAppt += " AND id <> ?"; paramsAppt.push(excludingId); }

  const [appts] = await pool.query(sqlAppt, paramsAppt);
  const [offs] = await pool.query(
    `SELECT 1
       FROM time_off
      WHERE stylist_id = ?
        AND starts_at < ?
        AND ends_at   > ?`,
    [stylistId, endWithBuffer, startWithBuffer]
  );
  return appts.length > 0 || offs.length > 0;
}

/* ========= Servicios / duración ========= */
async function resolveServiceDuration(serviceId, fallbackDurationMin) {
  try {
    if (serviceId) {
      const [[row]] = await pool.query(
        "SELECT duration_min FROM service WHERE id = ? LIMIT 1",
        [serviceId]
      );
      if (row && row.duration_min != null) return Number(row.duration_min);
    }
  } catch { }
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
  const [rows] = await pool.query("SELECT id FROM customer WHERE phone_e164=? LIMIT 1", [phoneNorm]);
  if (rows.length) return rows[0].id;
  const [ins] = await pool.query(
    "INSERT INTO customer (name, phone_e164) VALUES (?, ?)",
    [name || null, phoneNorm]
  );
  return ins.insertId;
}

/* ========= WhatsApp (best-effort) ========= */
let sendWhatsAppText = null;
try {
  const m = await import("../whatsapp.js");
  sendWhatsAppText = m.sendWhatsAppText || m.waSendText || null;
} catch { }

/* ========= Servicio programático (opcional) ========= */
// Útil si lo querés invocar desde otro módulo
export async function createAppointment({
  customerPhone,
  customerName = null,
  stylistId,
  serviceId,
  startsAt,
  endsAt = null,
  status = "scheduled",
  durationMin = null,
}) {
  if (!customerPhone || !stylistId || !serviceId || !startsAt) {
    throw new Error("Faltan campos requeridos");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // upsert cliente
    await conn.query(
      `INSERT INTO customer (name, phone_e164)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)`,
      [customerName ?? null, normPhone(customerPhone)]
    );
    const [[cust]] = await conn.query(
      `SELECT id, phone_e164 FROM customer WHERE phone_e164=? LIMIT 1`,
      [normPhone(customerPhone)]
    );

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

    const dateStr = startMySQL.slice(0, 10);
    const wh = await getWorkingHoursForDate(stylistId, dateStr);
    if (!wh) throw new Error("El peluquero no tiene horarios definidos para ese día");

    const startDate = new Date(startMySQL.replace(" ", "T"));
    const endDate = new Date(endMySQL.replace(" ", "T"));
    if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
      throw new Error("Fuera del horario laboral");
    }

    const bufferMin = Number(process.env.APPT_BUFFER_MIN || 0);
    if (await hasOverlapDB({ stylistId, start: startDate, end: endDate, bufferMin })) {
      throw new Error("Horario no disponible (solapado o buffer)");
    }

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
  const {
    customerName, customerPhone,
    stylistId, serviceId,
    startsAt, endsAt,
    status = "scheduled",
    durationMin
  } = req.body;

  if (!customerPhone || !stylistId || !serviceId || !startsAt) {
    return res.status(400).json({ ok: false, error: "Faltan campos requeridos" });
  }

  const conn = await pool.getConnection();
  let createdId = null;
  let startMySQL = null;
  let endMySQL = null;

  try {
    await conn.beginTransaction();

    startMySQL = anyToMySQL(startsAt);
    if (!startMySQL) throw new Error("Fecha/hora inválida");

    // ✅ VALIDAR FECHA ANTES DE TODO
    try {
      validateAppointmentDate(startMySQL);
    } catch (validationError) {
      return res.status(400).json({
        ok: false,
        error: validationError.message
      });
    }

    // Upsert cliente
    await conn.query(
      `INSERT INTO customer (name, phone_e164)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)`,
      [customerName ?? null, normPhone(customerPhone)]
    );

    const [[cust]] = await conn.query(
      `SELECT id, name, phone_e164 FROM customer WHERE phone_e164=? LIMIT 1`,
      [normPhone(customerPhone)]
    );
    if (!cust) throw new Error("No se pudo obtener el cliente");

    // Calcular fin si no viene
    endMySQL = anyToMySQL(endsAt);
    if (!endMySQL) {
      let dur = null;
      try {
        const [[row]] = await conn.query(
          "SELECT duration_min FROM service WHERE id=? LIMIT 1",
          [serviceId]
        );
        if (row && row.duration_min != null) dur = Number(row.duration_min);
      } catch { }
      if (dur == null && durationMin != null) dur = Number(durationMin);
      if (!dur) throw new Error("No se pudo determinar la duración del servicio");

      const [[{ calc_end }]] = await conn.query(
        "SELECT DATE_ADD(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS calc_end",
        [startMySQL, dur]
      );
      endMySQL = anyToMySQL(calc_end);
    }

    // Validar horarios de trabajo
    const dateStr = startMySQL.slice(0, 10);
    const wh = await getWorkingHoursForDate(stylistId, dateStr);
    if (!wh) throw new Error("El peluquero no tiene horarios definidos para ese día");

    const startDate = new Date(startMySQL.replace(" ", "T"));
    const endDate = new Date(endMySQL.replace(" ", "T"));

    if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
      throw new Error("Fuera del horario laboral");
    }

    // Validar solapamientos
    const bufferMin = Number(process.env.APPT_BUFFER_MIN || 0);
    if (await hasOverlapDB({ stylistId, start: startDate, end: endDate, bufferMin })) {
      throw new Error("Ese horario se superpone con otro turno del mismo peluquero");
    }

    // Insertar turno
    const [r] = await conn.query(
      `INSERT INTO appointment (customer_id, stylist_id, service_id, starts_at, ends_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [cust.id, Number(stylistId), Number(serviceId), startMySQL, endMySQL, status]
    );
    createdId = r.insertId;

    await conn.commit();
    res.status(201).json({ ok: true, id: createdId });

    // WhatsApp en segundo plano (sin await)
    queueMicrotask(async () => {
      try {
        const [[srv]] = await pool.query("SELECT name FROM service WHERE id=?", [serviceId]);
        const [[sty]] = await pool.query("SELECT name FROM stylist WHERE id=?", [stylistId]);
        if (sendWhatsAppText) {
          const d = new Date(startMySQL.replace(" ", "T"));
          const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
          const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
          const msg =
            `¡Turno reservado! ✅\n` +
            `Servicio: *${srv?.name || ""}*\n` +
            `Peluquero/a: *${sty?.name || ""}*\n` +
            `Fecha: *${fecha} ${hora}*`;
          await sendWhatsAppText(cust.phone_e164, msg);
        }
      } catch (waErr) {
        console.warn("[WA] No se pudo enviar confirmación:", waErr?.message);
      }
    });

  } catch (e) {
    await conn.rollback();
    return res.status(400).json({ ok: false, error: e.message });
  } finally {
    conn.release();
  }
});

/* -------- PUT /api/appointments/:id -------- */
appointments.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};

    let newCustomerId = null;
    if (b.customerPhone || b.phone_e164) {
      newCustomerId = await ensureCustomerId({
        name: b.customerName ?? b.customer_name,
        phone: b.customerPhone ?? b.phone_e164
      });
    }

    const stylistId = b.stylistId ?? b.stylist_id ?? null;
    const serviceId = b.serviceId ?? b.service_id ?? null;
    const status = b.status ?? null;
    const durationMin = b.durationMin ?? null;

    let startMySQL = anyToMySQL(b.startsAt ?? b.starts_at);
    let endMySQL = anyToMySQL(b.endsAt ?? b.ends_at);

    // ✅ VALIDAR si se modifica la fecha
    if (startMySQL) {
      try {
        validateAppointmentDate(startMySQL);
      } catch (validationError) {
        return res.status(400).json({
          ok: false,
          error: validationError.message
        });
      }
    }

    // Calcular fin si no vino y tenemos inicio + duración
    if (!endMySQL && (startMySQL || serviceId || durationMin != null)) {
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

    // Validar horarios si cambia rango/estilista
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
    `SELECT a.id, a.starts_at, a.ends_at, a.status,
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
