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
  status = "scheduled",     // respetamos si viene uno válido
  durationMin = null,
  depositDecimal = 0,       // monto de seña en moneda
  markDepositAsPaid = false // true si ya vino pagada (caso backoffice)
}) {
  if (!customerPhone || !stylistId || !serviceId || !startsAt) {
    throw new Error("Faltan campos requeridos");
  }

  const STATUS = {
    SCHEDULED: "scheduled",
    PENDING: "pending_deposit",
    DEPOSIT_PAID: "deposit_paid",
    CONFIRMED: "confirmed",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
  };
  const ALLOWED = new Set(Object.values(STATUS));


  // normaliza estados de versiones anteriores
  const normalizeStatus = (s) => {
    const t = String(s || "").toLowerCase().trim();
    if (t === "deposit_pending") return STATUS.PENDING; // alias viejo
    return ALLOWED.has(t) ? t : STATUS.SCHEDULED;
  };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log("[createAppointment] IN", {
      stylistId, serviceId, startsAt, status, depositDecimal, markDepositAsPaid
    });

    // 1) upsert cliente
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

    // 2) fechas (MySQL)
    const startMySQL = anyToMySQL(startsAt);
    if (!startMySQL) throw new Error("Fecha/hora inválida");
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

    // 3) horario laboral
    const dateStr = startMySQL.slice(0, 10);
    const wh = await getWorkingHoursForDate(stylistId, dateStr, conn);
    if (!wh) throw new Error("El peluquero no tiene horarios definidos para ese día");

    const startDate = new Date(startMySQL.replace(" ", "T"));
    const endDate = new Date(endMySQL.replace(" ", "T"));

    if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
      throw new Error("Fuera del horario laboral");
    }

    // 4) solapamientos
    await checkAppointmentOverlap(pool, {
      stylistId: Number(stylistId),
      startTime: startDate,
      endTime: endDate,
      bufferMinutes: Number(process.env.APPT_BUFFER_MIN || 0)
    });

    // 5) decidir estado final y hold_until
    const rawStatus = normalizeStatus(status);
    const wantsDeposit = Number(depositDecimal) > 0;

    // si ya viene pagada la seña -> deposit_paid

    let finalStatus = markDepositAsPaid
      ? STATUS.DEPOSIT_PAID
      : wantsDeposit ? STATUS.PENDING : rawStatus;

    // si el estado que vino no es compatible con depósito, ajusto

    if (!wantsDeposit && finalStatus === STATUS.PENDING) finalStatus = STATUS.SCHEDULED;
    if (!wantsDeposit && finalStatus === STATUS.SCHEDULED) finalStatus = STATUS.CONFIRMED;
    // si no usás "scheduled", podés convertirlo a "confirmed" directamente
    if (!wantsDeposit && finalStatus === STATUS.SCHEDULED) {
      finalStatus = STATUS.CONFIRMED;
    }



    // hold_until: expira la reserva si no seña a tiempo
    let holdUntil = null;
    if (finalStatus === STATUS.PENDING) {
      const HOLD_MIN = Number(process.env.DEPOSIT_HOLD_MIN || 30);             // ej. 30'
      const EXPIRE_BEFORE_START_MIN = Number(process.env.DEPOSIT_EXPIRE_BEFORE_START_MIN || 120); // ej. 120'
      const [[{ hu_grace }]] = await conn.query(
        "SELECT DATE_ADD(NOW(), INTERVAL ? MINUTE) AS hu_grace",
        [HOLD_MIN]
      );
      // si falta poco para el turno, expira antes
      const [[{ hu_by_start }]] = await conn.query(
        "SELECT DATE_SUB(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS hu_by_start",
        [startMySQL, EXPIRE_BEFORE_START_MIN]
      );
      // elegimos el mínimo positivo
      const grace = new Date(anyToMySQL(hu_grace).replace(" ", "T"));
      const byStart = new Date(anyToMySQL(hu_by_start).replace(" ", "T"));
      holdUntil = anyToMySQL(new Date(Math.min(grace.getTime(), byStart.getTime())));
    }

    // 6) campos de pago
    const depositPaidAt = markDepositAsPaid ? anyToMySQL(new Date()) : null;

    // 7) insert
    const [r] = await conn.query(
      `INSERT INTO appointment
     (customer_id, stylist_id, service_id,
      deposit_decimal, starts_at, ends_at,
      status, hold_until, deposit_paid_at, created_at)
   VALUES (?,?,?,?,?,?, ?, ?, ?, NOW())`,
      [
        cust.id, Number(stylistId), Number(serviceId),
        Number(depositDecimal || 0), startMySQL, endMySQL,
        finalStatus, holdUntil, depositPaidAt
      ]
    );

    const appointmentId = r.insertId;

    await conn.commit();
    console.log("[createAppointment] OUT", appointmentId);

    // Si requiere seña, afuera (o acá) generás el link de pago de MP
    // const mp = wantsDeposit && !markDepositAsPaid
    //   ? await createDepositPaymentLink({ appointmentId, amount: depositDecimal, /*...*/ })
    //   : null;

    return {
      ok: true,
      id: appointmentId,
      status: finalStatus,
      deposit: wantsDeposit ? {
        required: true,
        amount: Number(depositDecimal),
        // init_point: mp?.init_point || null
      } : { required: false }
    };
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
      SELECT 
        a.id, a.customer_id, a.stylist_id, a.service_id, a.status,
        a.deposit_decimal,
        DATE_FORMAT(a.deposit_paid_at, '%Y-%m-%dT%H:%i:%s') AS deposit_paid_at,
        DATE_FORMAT(a.starts_at,      '%Y-%m-%dT%H:%i:%s') AS starts_at,
        DATE_FORMAT(a.ends_at,        '%Y-%m-%dT%H:%i:%s') AS ends_at,
        c.name AS customer_name, c.phone_e164,
        s.name AS service_name,
        st.name AS stylist_name, st.color_hex,

        /* === NUEVO: info de pagos agregada === */
        p.last_payment_method,
        p.paid_cash,
        p.paid_card,
        p.payment_methods

      FROM appointment a
      JOIN customer  c  ON c.id  = a.customer_id
      JOIN service   s  ON s.id  = a.service_id
      JOIN stylist   st ON st.id = a.stylist_id

      /* Subquery de agregación de pagos por turno */
LEFT JOIN (
  SELECT
    appointment_id,
    SUBSTRING_INDEX(
      GROUP_CONCAT(method ORDER BY created_at DESC SEPARATOR ','),
      ',', 1
    ) AS last_payment_method,
    (SUM(method = 'cash')  > 0) AS paid_cash,
    (SUM(method IN ('card','debit','credit')) > 0) AS paid_card,
    GROUP_CONCAT(DISTINCT method ORDER BY method SEPARATOR ',') AS payment_methods
  FROM payment
  GROUP BY appointment_id
) p ON p.appointment_id = a.id

      WHERE 1=1
    `;

    const params = [];
    if (from && to) { sql += " AND a.starts_at BETWEEN ? AND ?"; params.push(from, to); }
    if (stylistId) { sql += " AND a.stylist_id = ?"; params.push(stylistId); }
    sql += " ORDER BY a.starts_at";

    const [rows] = await pool.query(sql, params);
    res.json({ ok: true, appointments: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- POST /api/appointments -------- */
appointments.post("/", async (req, res) => {
  try {
    const {
      customerName, customerPhone,
      stylistId, serviceId,
      startsAt, endsAt,
      status = "scheduled",     // puede venir del FE (ej. "pending_deposit")
      durationMin,
      depositDecimal,           // opcional: si el FE ya lo manda
      markDepositAsPaid = false // opcional
    } = req.body || {};

    // Validación básica antes de delegar
    if (!customerPhone || !stylistId || !serviceId || !startsAt) {
      return res.status(400).json({ ok: false, error: "Faltan campos requeridos" });
    }

    // ✅ Reutilizamos la lógica robusta arriba
    const result = await createAppointment({
      customerPhone,
      customerName,
      stylistId,
      serviceId,
      startsAt,
      endsAt,
      status,            // será normalizado adentro
      durationMin,
      depositDecimal: depositDecimal ?? 0,
      markDepositAsPaid: Boolean(markDepositAsPaid)
    });

    // Podés sumar aquí la generación del link de pago y adjuntarlo al response
    // si tu createAppointment no lo hace:
    // if (result.status === "pending_deposit" && !markDepositAsPaid) {
    //   const mp = await createDepositPaymentLink({ appointmentId: result.id, amount: result.deposit.amount });
    //   result.deposit.init_point = mp?.init_point || null;
    // }

    return res.status(201).json(result);
  } catch (e) {
    console.error("   ❌ Error general:", e.message);
    return res.status(400).json({ ok: false, error: e.message });
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

    // ✅ Si no viene fin, intentamos recalcular con la duración y el INICIO EFECTIVO
    if (!endMySQL) {
      // inicio efectivo: el nuevo (si lo mandaron) o el actual
      const effectiveStart = startMySQL || current.starts_at;

      // ¿Necesitamos recalcular? solo si cambió el inicio o el servicio, o si piden durationMin
      const mustRecalc =
        Boolean(startMySQL) || Boolean(b.serviceId ?? b.service_id) || durationMin != null;

      if (mustRecalc) {
        const dur = await resolveServiceDuration(serviceId, durationMin);
        if (dur && effectiveStart) {
          const [[{ calc_end }]] = await pool.query(
            "SELECT DATE_ADD(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS calc_end",
            [anyToMySQL(effectiveStart), Number(dur)]
          );
          endMySQL = anyToMySQL(calc_end);
        } else {
          // Si no hay datos para recalcular, NO errores: mantené el fin actual
          endMySQL = current.ends_at;
        }
      } else {
        // No hace falta recalcular: mantené el fin actual
        endMySQL = current.ends_at;
      }
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



// Estados “futuros” válidos (excluye cancelados y completados)
const UPCOMING_STATUSES = ["scheduled", "confirmed", "deposit_paid", "pending_deposit"];
export async function listUpcomingAppointmentsByPhone(phone_e164, { limit = 5 } = {}) {
  if (!phone_e164) return [];

  const phone = normPhone(phone_e164);              // ← conserva el '+'
  const params = [
    phone,
    ...UPCOMING_STATUSES,
    Number(limit)
  ];

  const placeholders = UPCOMING_STATUSES.map(() => "?").join(",");

  const [rows] = await pool.query(
    `
    SELECT a.id, a.starts_at, a.ends_at, a.status,
           s.name  AS service_name,
           st.name AS stylist_name
      FROM appointment a
      JOIN customer  c  ON c.id  = a.customer_id
      JOIN service   s  ON s.id  = a.service_id
      JOIN stylist   st ON st.id = a.stylist_id
     WHERE c.phone_e164 = ?
       AND a.status IN (${placeholders})
       AND a.starts_at >= NOW()
     ORDER BY a.starts_at ASC
     LIMIT ?
    `,
    params
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