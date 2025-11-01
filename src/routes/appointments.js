// src/routes/appointments.js
import { Router } from "express";
import { pool } from "../db.js";
import { isAfter, isBefore } from "date-fns";
import { validateAppointmentDate } from "../helpers/dateValidation.js";
import { checkAppointmentOverlap } from "../helpers/overlapValidation.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";
import { cfgNumber } from "../services/config.js";
import { createNotification } from "./notifications.js";
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
  } catch { /* noop */ }
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
} catch { /* noop */ }

/* ========= Servicio programático (opcional) ========= */
export async function createAppointment({
  customerPhone,
  customerName = null,
  stylistId,
  serviceId,
  startsAt,
  endsAt = null,
  status = "scheduled",
  durationMin = null,
  depositDecimal,            // si no viene, calculamos con la config
  markDepositAsPaid = false
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
  const normalizeStatus = (s) => {
    const t = String(s || "").toLowerCase().trim();
    if (t === "deposit_pending") return STATUS.PENDING; // alias viejo
    return ALLOWED.has(t) ? t : STATUS.SCHEDULED;
  };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

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

    // 2.1) precio del servicio (para calcular seña si hace falta)
    const [[svc]] = await conn.query(
      "SELECT price_decimal FROM service WHERE id=? LIMIT 1",
      [serviceId]
    );
    if (!svc) throw new Error("Servicio inexistente");
    const price = Number(svc.price_decimal ?? 0);

    // 2.2) % de seña desde config (default 50)
    const depositPct = await cfgNumber("deposit.percentage", 50);

    // 2.3) decidir monto de seña:
    // - si viene depositDecimal: se respeta (0 => sin seña)
    // - si NO viene: se calcula con el % guardado
    const depositValue =
      depositDecimal == null
        ? Math.round(price * (depositPct / 100))
        : Number(depositDecimal);

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

    // 5) decidir estado final
    const rawStatus = normalizeStatus(status);
    const wantsDeposit = Number(depositValue) > 0;

    let finalStatus = markDepositAsPaid
      ? STATUS.DEPOSIT_PAID
      : wantsDeposit ? STATUS.PENDING : rawStatus;

    if (!wantsDeposit && finalStatus === STATUS.PENDING) finalStatus = STATUS.SCHEDULED;
    if (!wantsDeposit && finalStatus === STATUS.SCHEDULED) finalStatus = STATUS.CONFIRMED;

    // 5.1) hold_until desde config
    let holdUntil = null;
    if (finalStatus === STATUS.PENDING) {
      const HOLD_MIN = await cfgNumber("deposit.holdMinutes", 30);
      const EXPIRE_BEFORE_START_MIN = await cfgNumber("deposit.expirationBeforeStart", 120);

      const [[{ hu_grace }]] = await conn.query(
        "SELECT DATE_ADD(NOW(), INTERVAL ? MINUTE) AS hu_grace",
        [HOLD_MIN]
      );
      const [[{ hu_by_start }]] = await conn.query(
        "SELECT DATE_SUB(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS hu_by_start",
        [startMySQL, EXPIRE_BEFORE_START_MIN]
      );

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
        Number(depositValue || 0), startMySQL, endMySQL,
        finalStatus, holdUntil, depositPaidAt
      ]
    );

    const appointmentId = r.insertId;
    await conn.commit();

    return {
      ok: true,
      id: appointmentId,
      status: finalStatus,
      deposit: wantsDeposit
        ? { required: true, amount: Number(depositValue), pct: depositPct }
        : { required: false }
    };
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
appointments.get("/", requireAuth, async (req, res) => {
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

        /* Info de pagos agregada */
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
appointments.post("/", requireAuth, requireRole("admin", "user"), async (req, res) => {
  try {
    await createNotification({
      userId: req.user.id,
      type: "appointment",
      title: "Nuevo turno reservado",
      message: `Cliente: ${customerName || customerPhone} — Servicio #${serviceId} — Inicio: ${startsAt}`,
      data: { appointmentId: result.id, stylistId, serviceId, startsAt }
    });
    console.log("🔔 [appointments] Notificación creada para user:", req.user.id, "appt:", result.id);
  } catch (e) {
    console.error("⚠️ [appointments] No se pudo crear notificación (admin):", e.message);
  }

  // (Opcional) Notificar al estilista si tiene user asignado
  try {
    const [[styUser]] = await pool.query(
      "SELECT user_id FROM stylist WHERE id=? LIMIT 1",
      [stylistId]
    );
    if (styUser?.user_id) {
      await createNotification({
        userId: styUser.user_id,
        type: "appointment",
        title: "Te asignaron un nuevo turno",
        message: `Cliente: ${customerName || customerPhone} — Servicio #${serviceId} — Inicio: ${startsAt}`,
        data: { appointmentId: result.id, stylistId, serviceId, startsAt }
      });
      console.log("🔔 [appointments] Notificación creada para estilista.user_id:", styUser.user_id);
    }
  } catch (e) {
    console.error("⚠️ [appointments] No se pudo notificar estilista:", e.message);
  }
});

/* -------- PUT /api/appointments/:id -------- */
appointments.put("/:id", requireAuth, requireRole("admin", "user"), async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};

    // seña y marca de pago
    const depositDecimal = b.depositDecimal ?? null;
    const markDepositAsPaid = b.markDepositAsPaid === true;

    // Turno actual
    const [[current]] = await pool.query(
      `SELECT id, customer_id, stylist_id, service_id, starts_at, ends_at, status, deposit_decimal
         FROM appointment WHERE id=? LIMIT 1`,
      [id]
    );
    if (!current) {
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

    // Validación de fecha si cambia inicio
    if (startMySQL) {
      try {
        validateAppointmentDate(startMySQL);
      } catch (validationError) {
        return res.status(400).json({ ok: false, error: validationError.message });
      }
    }

    // Recalcular fin si hace falta
    if (!endMySQL) {
      const effectiveStart = startMySQL || current.starts_at;
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
          endMySQL = current.ends_at;
        }
      } else {
        endMySQL = current.ends_at;
      }
    }

    // Validar horarios y overlaps si cambia rango
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
      } catch (overlapError) {
        return res.status(409).json({ ok: false, error: overlapError.message });
      }
    }

    // Validación de seña si viene
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

    // UPDATE
    let setPaidAtSQL = "";
    const params = [
      newCustomerId,
      stylistId,
      serviceId,
      startMySQL,
      endMySQL,
      status,
      depositDecimal,
      id
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
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- DELETE /api/appointments/:id -------- */
appointments.delete("/:id", requireAuth, requireRole("admin", "user"), async (req, res) => {
  try {
    const { id } = req.params;

    const [r] = await pool.query(`DELETE FROM appointment WHERE id=?`, [id]);

    if (r.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- Utilidades -------- */
// Estados “futuros” válidos (excluye cancelados y completados)
const UPCOMING_STATUSES = ["scheduled", "confirmed", "deposit_paid", "pending_deposit"];

export async function listUpcomingAppointmentsByPhone(phone_e164, { limit = 5 } = {}) {
  if (!phone_e164) return [];

  const phone = normPhone(phone_e164);
  const params = [phone, ...UPCOMING_STATUSES, Number(limit)];
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
