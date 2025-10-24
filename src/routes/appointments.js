// src/routes/appointments.js
import { Router } from "express";
import { pool } from "../db.js";
import { addMinutes, isAfter, isBefore } from "date-fns";
import { validateAppointmentDate } from "../helpers/dateValidation.js";
import { checkAppointmentOverlap, parseDateTime, toMySQLDateTime } from "../helpers/overlapValidation.js";

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
async function getWorkingHoursForDate(stylistId, dateStr, db = pool) {
  const weekday = new Date(`${dateStr}T00:00:00`).getDay(); // 0..6
  const [rows] = await db.query(
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

/* ========= Servicios / duración ========= */
async function resolveServiceDuration(serviceId, fallbackDurationMin, db = pool) {
  try {
    if (serviceId) {
      const [[row]] = await db.query(
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
  status = "scheduled",          // 👈 ahora respetamos el status que venga
  durationMin = null,
  depositDecimal = 0,            // 👈 seña
  markDepositAsPaid = false
}) {
  if (!customerPhone || !stylistId || !serviceId || !startsAt) {
    throw new Error("Faltan campos requeridos");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log("[createAppointment] IN", { stylistId, serviceId, startsAt, status, depositDecimal });

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

    // calcular fin si hace falta
    let endMySQL = anyToMySQL(endsAt);
    if (!endMySQL) {
      const dur = await resolveServiceDuration(serviceId, durationMin, conn);
      if (!dur) throw new Error("No se pudo determinar la duración del servicio");
      const [[{ calc_end }]] = await conn.query(
        "SELECT DATE_ADD(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS calc_end",
        [startMySQL, dur]
      );
      endMySQL = anyToMySQL(calc_end);
    }

    // horario laboral
    const dateStr = startMySQL.slice(0, 10);
    const wh = await getWorkingHoursForDate(stylistId, dateStr, conn);
    if (!wh) throw new Error("El peluquero no tiene horarios definidos para ese día");

    const startDate = new Date(startMySQL.replace(" ", "T"));
    const endDate = new Date(endMySQL.replace(" ", "T"));
    if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
      throw new Error("Fuera del horario laboral");
    }

    // overlap (mantené el mismo contrato que usás en PUT: con pool)
    await checkAppointmentOverlap(pool, {
      stylistId: Number(stylistId),
      startTime: startDate,
      endTime: endDate,
      bufferMinutes: Number(process.env.APPT_BUFFER_MIN || 0)
    });

    // hold si está pendiente de seña
    let holdUntil = null;
    if (String(status) === "pending_deposit") {
      const holdMin = Number(process.env.DEPOSIT_HOLD_MIN || 30); // default 30'
      const [[{ hu }]] = await conn.query(
        "SELECT DATE_ADD(NOW(), INTERVAL ? MINUTE) AS hu",
        [holdMin]
      );
      holdUntil = anyToMySQL(hu);
    }

    // insert
    const paidAt = markDepositAsPaid ? new Date() : null;
    const [r] = await conn.query(
      `INSERT INTO appointment
         (customer_id, stylist_id, service_id, deposit_decimal, starts_at, ends_at, status, hold_until, ${paidAt ? "deposit_paid_at," : ""} created_at)
       VALUES (?,?,?,?,?,?, ?, ?, ${paidAt ? "?," : ""} NOW())`,
      [cust.id, Number(stylistId), Number(serviceId), Number(depositDecimal || 0), startMySQL, endMySQL, status, holdUntil, ...(paidAt ? [anyToMySQL(paidAt)] : [])]
    );

    await conn.commit();
    console.log("[createAppointment] OUT", r.insertId);
    return { ok: true, id: r.insertId };
  } catch (e) {
    console.error("[createAppointment] ERROR:", e?.message);
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
       a.deposit_decimal,
       DATE_FORMAT(a.deposit_paid_at, '%Y-%m-%dT%H:%i:%s') AS deposit_paid_at,
       DATE_FORMAT(a.starts_at, '%Y-%m-%dT%H:%i:%s') AS starts_at,
       DATE_FORMAT(a.ends_at,   '%Y-%m-%dT%H:%i:%s') AS ends_at,
       c.name AS customer_name, c.phone_e164,
       s.name AS service_name,
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

  console.log("\n🆕 [POST /appointments] Nueva solicitud:");
  console.log("   Phone:", customerPhone);
  console.log("   Stylist:", stylistId);
  console.log("   Service:", serviceId);
  console.log("   StartsAt:", startsAt);

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

    console.log("   Fecha normalizada:", startMySQL);

    // ✅ VALIDAR FECHA ANTES DE TODO
    try {
      validateAppointmentDate(startMySQL);
      console.log("   ✅ Validación de fecha OK");
    } catch (validationError) {
      console.error("   ❌ Fecha inválida:", validationError.message);
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

    console.log("   ✅ Cliente:", cust.id);

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

    console.log("   Inicio:", startMySQL);
    console.log("   Fin:", endMySQL);

    // Validar horarios de trabajo
    const dateStr = startMySQL.slice(0, 10);
    const wh = await getWorkingHoursForDate(stylistId, dateStr);
    if (!wh) throw new Error("El peluquero no tiene horarios definidos para ese día");

    const startDate = new Date(startMySQL.replace(" ", "T"));
    const endDate = new Date(endMySQL.replace(" ", "T"));

    if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
      throw new Error("Fuera del horario laboral");
    }

    console.log("   ✅ Dentro del horario laboral");

    // ✅ VALIDACIÓN ROBUSTA DE OVERLAP
    try {
      await checkAppointmentOverlap(conn, {
        stylistId: Number(stylistId),
        startTime: startDate,
        endTime: endDate,
        bufferMinutes: Number(process.env.APPT_BUFFER_MIN || 0)
      });
      console.log("   ✅ Sin overlaps");
    } catch (overlapError) {
      console.error("   ❌ Overlap detectado:", overlapError.message);
      await conn.rollback();
      conn.release();
      return res.status(409).json({
        ok: false,
        error: overlapError.message
      });
    }

    // Insertar turno
    const [r] = await conn.query(
      `INSERT INTO appointment (customer_id, stylist_id, service_id, starts_at, ends_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [cust.id, Number(stylistId), Number(serviceId), startMySQL, endMySQL, status]
    );
    createdId = r.insertId;

    await conn.commit();
    console.log("   ✅ Turno creado con ID:", createdId);

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
          console.log("   📱 WhatsApp enviado");
        }
      } catch (waErr) {
        console.warn("   ⚠️  WA error:", waErr?.message);
      }
    });

  } catch (e) {
    await conn.rollback();
    console.error("   ❌ Error general:", e.message);
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

    // 👇 NUEVO: seña y marca de pago
    const depositDecimal = b.depositDecimal ?? null;
    const markDepositAsPaid = b.markDepositAsPaid === true;

    console.log(`\n✏️  [PUT /appointments/${id}] Actualización:`);

    // Traigo el turno actual para conocer service_id / stylist_id si no los mandan
    const [[current]] = await pool.query(
      `SELECT id, customer_id, stylist_id, service_id, starts_at, ends_at, status, deposit_decimal
         FROM appointment WHERE id=? LIMIT 1`,
      [id]
    );
    if (!current) {
      console.error("   ❌ Turno no encontrado");
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }

    let newCustomerId = null;
    if (b.customerPhone || b.phone_e164) {
      newCustomerId = await ensureCustomerId({
        name: b.customerName ?? b.customer_name,
        phone: b.customerPhone ?? b.phone_e164
      });
    }

    // Si no me mandan, uso los actuales
    const stylistId = (b.stylistId ?? b.stylist_id) ?? current.stylist_id;
    const serviceId = (b.serviceId ?? b.service_id) ?? current.service_id;
    const status = b.status ?? null;
    const durationMin = b.durationMin ?? null;

    let startMySQL = anyToMySQL(b.startsAt ?? b.starts_at);
    let endMySQL = anyToMySQL(b.endsAt ?? b.ends_at);

    // ✅ Validación de fecha si cambia inicio
    if (startMySQL) {
      try {
        validateAppointmentDate(startMySQL);
        console.log("   ✅ Validación de fecha OK");
      } catch (validationError) {
        console.error("   ❌ Fecha inválida:", validationError.message);
        return res.status(400).json({ ok: false, error: validationError.message });
      }
    }

    // Si no viene fin, lo calculo con duración (del servicio efectivo)
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

    // Validar horarios y overlaps si cambia rango (inicio/fin)
    if (startMySQL && endMySQL) {
      const dateStr = startMySQL.slice(0, 10);
      const wh = await getWorkingHoursForDate(stylistId, dateStr);
      if (!wh) {
        return res.status(400).json({ ok: false, error: "El peluquero no tiene horarios definidos para ese día" });
      }

      const startDate = new Date(startMySQL.replace(" ", "T"));
      const endDate = new Date(endMySQL.replace(" ", "T"));

      if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
        return res.status(400).json({ ok: false, error: "Fuera del horario laboral" });
      }

      try {
        await checkAppointmentOverlap(pool, {
          stylistId: Number(stylistId),
          startTime: startDate,
          endTime: endDate,
          excludeId: id,
          bufferMinutes: Number(process.env.APPT_BUFFER_MIN || 0)
        });
        console.log("   ✅ Sin overlaps");
      } catch (overlapError) {
        console.error("   ❌ Overlap:", overlapError.message);
        return res.status(409).json({ ok: false, error: overlapError.message });
      }
    }

    // ✅ Validación de seña contra precio del servicio (si viene depositDecimal)
    if (depositDecimal != null) {
      const [[svc]] = await pool.query(
        "SELECT price_decimal FROM service WHERE id=? LIMIT 1",
        [serviceId]
      );
      if (!svc) return res.status(400).json({ ok: false, error: "Servicio inexistente" });
      const price = Number(svc.price_decimal ?? 0);
      const dep = Number(depositDecimal);
      if (Number.isNaN(dep)) return res.status(400).json({ ok: false, error: "Seña inválida" });
      if (dep < 0) return res.status(400).json({ ok: false, error: "La seña no puede ser negativa" });
      if (price > 0 && dep > price) {
        return res.status(400).json({ ok: false, error: "La seña no puede superar el precio del servicio" });
      }
    }

    // Armo UPDATE dinámico para deposit_paid_at si corresponde
    let setPaidAtSQL = "";
    const params = [
      newCustomerId,          // 1
      stylistId,              // 2
      serviceId,              // 3
      startMySQL,             // 4
      endMySQL,               // 5
      status,                 // 6
      depositDecimal,         // 7 👈 NUEVO (puede ser null => no cambia)
      id                      // 8 (WHERE)
    ];

    if (markDepositAsPaid) {
      setPaidAtSQL = ", deposit_paid_at = NOW()";
    }

    const [r] = await pool.query(
      `UPDATE appointment
          SET customer_id     = COALESCE(?, customer_id),
              stylist_id      = COALESCE(?, stylist_id),
              service_id      = COALESCE(?, service_id),
              starts_at       = COALESCE(?, starts_at),
              ends_at         = COALESCE(?, ends_at),
              status          = COALESCE(?, status),
              deposit_decimal = COALESCE(?, deposit_decimal)
              ${setPaidAtSQL}
        WHERE id = ?`,
      params
    );

    if (r.affectedRows === 0) {
      console.error("   ❌ Turno no encontrado");
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }

    console.log("   ✅ Turno actualizado");
    res.json({ ok: true });
  } catch (e) {
    console.error("   ❌ Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- DELETE /api/appointments/:id -------- */
appointments.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`\n🗑️  [DELETE /appointments/${id}]`);

    const [r] = await pool.query(`DELETE FROM appointment WHERE id=?`, [id]);

    if (r.affectedRows === 0) {
      console.error("   ❌ Turno no encontrado");
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }

    console.log("   ✅ Turno eliminado");
    res.json({ ok: true });
  } catch (e) {
    console.error("   ❌ Error:", e.message);
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
function withTimeout(promise, ms, label = "timeout") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}