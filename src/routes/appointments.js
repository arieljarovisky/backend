// src/routes/appointments.js — MULTI-TENANT
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

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      s = s.replace("T", " ");
      return s.length === 16 ? s + ":00" : s.slice(0, 19);
    }

    if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      return s.length === 16 ? s + ":00" : s.slice(0, 19);
    }

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
async function getWorkingHoursForDate(stylistId, dateStr, db = pool, tenantId) {
  const weekday = new Date(`${dateStr}T00:00:00`).getDay();
  const [rows] = await db.query(
    `SELECT start_time, end_time
       FROM working_hours
      WHERE stylist_id=? AND tenant_id=? AND weekday IN (?, ?) 
      ORDER BY start_time
      LIMIT 1`,
    [stylistId, tenantId, weekday, weekday === 0 ? 7 : weekday]
  );
  return rows[0] || null;
}

function insideWorkingHours(dateStr, start_time, end_time, start, end) {
  const dayStart = new Date(`${dateStr}T${start_time}`);
  const dayEnd = new Date(`${dateStr}T${end_time}`);
  return !isBefore(start, dayStart) && !isAfter(end, dayEnd);
}

/* ========= Servicios / duración ========= */
async function resolveServiceDuration(serviceId, fallbackDurationMin, db = pool, tenantId) {
  try {
    if (serviceId) {
      const [[row]] = await db.query(
        "SELECT duration_min FROM service WHERE id = ? AND tenant_id = ? LIMIT 1",
        [serviceId, tenantId]
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

async function ensureCustomerId({ name, phone }, db = pool, tenantId) {
  const phoneNorm = normPhone(phone);
  if (!phoneNorm) return null;

  // Por diseño: UNIQUE (tenant_id, phone_e164)
  const [rows] = await db.query(
    "SELECT id FROM customer WHERE phone_e164=? AND tenant_id=? LIMIT 1",
    [phoneNorm, tenantId]
  );
  if (rows.length) return rows[0].id;

  const [ins] = await db.query(
    "INSERT INTO customer (tenant_id, name, phone_e164) VALUES (?, ?, ?)",
    [tenantId, name || null, phoneNorm]
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
  depositDecimal,
  markDepositAsPaid = false,
  tenantId // 👈 requerido para multi-tenant si se invoca fuera de rutas HTTP
}) {
  if (!customerPhone || !stylistId || !serviceId || !startsAt) {
    throw new Error("Faltan campos requeridos");
  }
  if (!tenantId) throw new Error("Tenant no identificado");

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
    if (t === "deposit_pending") return STATUS.PENDING;
    return ALLOWED.has(t) ? t : STATUS.SCHEDULED;
  };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) upsert cliente scoped
    await conn.query(
      `INSERT INTO customer (tenant_id, name, phone_e164)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)`,
      [tenantId, customerName ?? null, normPhone(customerPhone)]
    );
    const [[cust]] = await conn.query(
      `SELECT id, phone_e164 FROM customer WHERE phone_e164=? AND tenant_id=? LIMIT 1`,
      [normPhone(customerPhone), tenantId]
    );

    // 2) fechas (MySQL)
    const startMySQL = anyToMySQL(startsAt);
    if (!startMySQL) throw new Error("Fecha/hora inválida");
    let endMySQL = anyToMySQL(endsAt);
    if (!endMySQL) {
      const dur = await resolveServiceDuration(serviceId, durationMin, conn, tenantId);
      if (dur == null) throw new Error("No se pudo determinar la duración del servicio");
      const [[{ calc_end }]] = await conn.query(
        "SELECT DATE_ADD(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS calc_end",
        [startMySQL, dur]
      );
      endMySQL = anyToMySQL(calc_end);
    }

    // 2.1) precio del servicio (para seña)
    const [[svc]] = await conn.query(
      "SELECT price_decimal FROM service WHERE id=? AND tenant_id=? LIMIT 1",
      [serviceId, tenantId]
    );
    if (!svc) throw new Error("Servicio inexistente");
    const price = Number(svc.price_decimal ?? 0);

    // 2.2) % de seña desde config (default 50)
    const depositPct = await cfgNumber("deposit.percentage", 50);

    // 2.3) decidir monto de seña
    const depositValue =
      depositDecimal == null
        ? Math.round(price * (depositPct / 100))
        : Number(depositDecimal);

    // 3) horario laboral
    const dateStr = startMySQL.slice(0, 10);
    const wh = await getWorkingHoursForDate(stylistId, dateStr, conn, tenantId);
    if (!wh) throw new Error("El peluquero no tiene horarios definidos para ese día");

    const startDate = new Date(startMySQL.replace(" ", "T"));
    const endDate = new Date(endMySQL.replace(" ", "T"));

    if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
      throw new Error("Fuera del horario laboral");
    }

    // 4) VALIDAR SOLAPAMIENTO (usa conn) — internamente debe chequear por stylist/tenant
    await checkAppointmentOverlap(conn, {
      stylistId: Number(stylistId),
      startTime: startDate,
      endTime: endDate,
      bufferMinutes: Number(process.env.APPT_BUFFER_MIN || 0),
      useLock: true
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

    // 7) INSERT con tenant
    const [r] = await conn.query(
      `INSERT INTO appointment
       (tenant_id, customer_id, stylist_id, service_id,
        deposit_decimal, starts_at, ends_at,
        status, hold_until, deposit_paid_at, created_at)
       VALUES (?,?,?,?,?,?, ?, ?, ?, ?, NOW())`,
      [
        tenantId,
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

appointments.get("/", requireAuth, requireRole("admin", "user"), async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { from, to, stylistId } = req.query;

    let sql = `
      SELECT a.*, 
             c.name AS customer_name, 
             s.name AS service_name, 
             st.name AS stylist_name
        FROM appointment a
        JOIN customer c ON c.id = a.customer_id  AND c.tenant_id = a.tenant_id
        JOIN service  s ON s.id = a.service_id   AND s.tenant_id = a.tenant_id
        JOIN stylist st ON st.id = a.stylist_id  AND st.tenant_id = a.tenant_id
       WHERE a.tenant_id = ?
    `;
    const params = [tenantId];

    if (from) {
      sql += " AND a.starts_at >= ?";
      params.push(from);
    }
    if (to) {
      sql += " AND a.starts_at <= ?";
      params.push(to);
    }
    if (stylistId) {
      sql += " AND a.stylist_id = ?";
      params.push(stylistId);
    }

    sql += " ORDER BY a.starts_at ASC";

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("❌ [GET /appointments] ERROR:", err);
    res.status(500).json({ ok: false, error: "Error al listar turnos" });
  }
});

// ✅ POST con tenant en todas las consultas
appointments.post("/", requireRole("admin", "user"), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const tenantId = req.tenant.id;

    const {
      stylistId,
      serviceId,
      customerId,
      customerName,
      customerPhone,
      customerNotes,
      startsAt,
      endsAt
    } = req.body;

    // --- 1) Asegurar cliente ---
    let effectiveCustomerId = customerId || null;

    if (!effectiveCustomerId) {
      effectiveCustomerId = await ensureCustomerId(
        { name: customerName, phone: customerPhone, notes: customerNotes },
        conn,
        tenantId
      );
    }

    if (!effectiveCustomerId) {
      await conn.rollback();
      return res.status(400).json({
        ok: false,
        error: "No se pudo determinar/crear el cliente (faltan datos)"
      });
    }

    // --- 2) Obtener servicio ---
    const [[svc]] = await conn.query(
      "SELECT duration_min FROM service WHERE id=? AND tenant_id=? LIMIT 1",
      [serviceId, tenantId]
    );
    if (!svc) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "Servicio inexistente" });
    }

    // --- 3) Calcular fechas ---
    const startMySQL = anyToMySQL(startsAt);
    let endMySQL = anyToMySQL(endsAt);

    if (!endMySQL) {
      const [[{ calc_end }]] = await conn.query(
        "SELECT DATE_ADD(STR_TO_DATE(?, '%Y-%m-%d %H:%i:%s'), INTERVAL ? MINUTE) AS calc_end",
        [startMySQL, svc.duration_min]
      );
      endMySQL = anyToMySQL(calc_end);
    }

    const startDate = new Date(startMySQL.replace(" ", "T"));
    const endDate = new Date(endMySQL.replace(" ", "T"));

    // --- 4) VALIDAR SOLAPAMIENTO ---
    try {
      await checkAppointmentOverlap(conn, {
        stylistId: Number(stylistId),
        startTime: startDate,
        endTime: endDate,
        bufferMinutes: Number(process.env.APPT_BUFFER_MIN || 0),
        useLock: true
      });
    } catch (overlapError) {
      await conn.rollback();
      return res.status(409).json({
        ok: false,
        error: overlapError.message
      });
    }

    // --- 4.1) Horario laboral del estilista (por tenant) ---
    const dateStr = startMySQL.slice(0, 10);
    const wh = await getWorkingHoursForDate(stylistId, dateStr, conn, tenantId);
    if (!wh) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "El peluquero no tiene horarios definidos para ese día" });
    }
    if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "Fuera del horario laboral" });
    }

    // --- 5) Insertar turno con tenant ---
    const [ins] = await conn.query(
      `INSERT INTO appointment 
       (tenant_id, stylist_id, service_id, customer_id, starts_at, ends_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', NOW())`,
      [tenantId, stylistId, serviceId, effectiveCustomerId, startMySQL, endMySQL]
    );
    const appointmentId = ins.insertId;

    await conn.commit();
    console.log("✅ [appointments POST] Turno creado:", appointmentId);

    // --- 6) Notificaciones (fuera de la transacción) ---
    try {
      let customerLabel = `Cliente #${effectiveCustomerId}`;
      let serviceLabel = `Servicio #${serviceId}`;

      const [[c]] = await pool.query(
        "SELECT COALESCE(name,'') AS name, COALESCE(phone_e164,'') AS phone FROM customer WHERE id=? AND tenant_id=?",
        [effectiveCustomerId, tenantId]
      );
      if (c?.name || c?.phone) customerLabel = c.name || c.phone || customerLabel;

      const [[s]] = await pool.query(
        "SELECT COALESCE(name,'') AS name FROM service WHERE id=? AND tenant_id=?",
        [serviceId, tenantId]
      );
      if (s?.name) serviceLabel = s.name;

      await createNotification({
        userId: req.user.id,
        type: "appointment",
        title: "Nuevo turno reservado",
        message: `${customerLabel} — ${serviceLabel} — Inicio: ${startsAt}`,
        data: { tenantId, appointmentId, stylistId, serviceId, customerId: effectiveCustomerId, startsAt, endsAt: endMySQL }
      });

      // Notificar al estilista si existe mapping user_id
      const [[sty]] = await pool.query(
        "SELECT user_id FROM stylist WHERE id=? AND tenant_id=? LIMIT 1",
        [stylistId, tenantId]
      );
      if (sty?.user_id) {
        await createNotification({
          userId: sty.user_id,
          type: "appointment",
          title: "Te asignaron un nuevo turno",
          message: `${customerLabel} — ${serviceLabel} — Inicio: ${startsAt}`,
          data: { tenantId, appointmentId, stylistId, serviceId, customerId: effectiveCustomerId, startsAt, endsAt: endMySQL }
        });
      }
    } catch (e) {
      console.error("⚠️ [appointments] No se pudo crear notificación:", e.message);
    }

    return res.status(201).json({ ok: true, id: appointmentId });

  } catch (err) {
    await conn.rollback();
    console.error("❌ [appointments POST] ERROR:", err);
    return res.status(500).json({ ok: false, error: "No se pudo crear el turno" });
  } finally {
    conn.release();
  }
});

// ✅ PUT con tenant en locks/selects/updates
appointments.put("/:id", requireAuth, requireRole("admin", "user"), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const tenantId = req.tenant.id;
    const { id } = req.params;
    const b = req.body || {};

    const depositDecimal = b.depositDecimal ?? null;
    const markDepositAsPaid = b.markDepositAsPaid === true;

    // Turno actual (lock y tenant)
    const [[current]] = await conn.query(
      `SELECT id, customer_id, stylist_id, service_id, starts_at, ends_at, status, deposit_decimal
         FROM appointment 
        WHERE id=? AND tenant_id=? FOR UPDATE`,
      [id, tenantId]
    );

    if (!current) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }

    let newCustomerId = null;
    if (b.customerPhone || b.phone_e164) {
      newCustomerId = await ensureCustomerId({
        name: b.customerName ?? b.customer_name,
        phone: b.customerPhone ?? b.phone_e164
      }, conn, tenantId);
    }

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
        await conn.rollback();
        return res.status(400).json({ ok: false, error: validationError.message });
      }
    }

    // Recalcular fin si hace falta
    if (!endMySQL) {
      const effectiveStart = startMySQL || current.starts_at;
      const mustRecalc =
        Boolean(startMySQL) || Boolean(b.serviceId ?? b.service_id) || durationMin != null;

      if (mustRecalc) {
        const dur = await resolveServiceDuration(serviceId, durationMin, conn, tenantId);
        if (dur && effectiveStart) {
          const [[{ calc_end }]] = await conn.query(
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
      const wh = await getWorkingHoursForDate(stylistId, dateStr, conn, tenantId);

      if (!wh) {
        await conn.rollback();
        return res.status(400).json({ ok: false, error: "El peluquero no tiene horarios definidos para ese día" });
      }

      const startDate = new Date(startMySQL.replace(" ", "T"));
      const endDate = new Date(endMySQL.replace(" ", "T"));

      if (!insideWorkingHours(dateStr, wh.start_time, wh.end_time, startDate, endDate)) {
        await conn.rollback();
        return res.status(400).json({ ok: false, error: "Fuera del horario laboral" });
      }

      try {
        await checkAppointmentOverlap(conn, {
          stylistId: Number(stylistId),
          startTime: startDate,
          endTime: endDate,
          excludeId: id,
          bufferMinutes: Number(process.env.APPT_BUFFER_MIN || 0),
          useLock: true
        });
      } catch (overlapError) {
        await conn.rollback();
        return res.status(409).json({ ok: false, error: overlapError.message });
      }
    }

    // Validación de seña si viene
    if (depositDecimal != null) {
      const [[svc]] = await conn.query(
        "SELECT price_decimal FROM service WHERE id=? AND tenant_id=? LIMIT 1",
        [serviceId, tenantId]
      );
      if (!svc) {
        await conn.rollback();
        return res.status(400).json({ ok: false, error: "Servicio inexistente" });
      }
      const price = Number(svc.price_decimal ?? 0);
      const dep = Number(depositDecimal);
      if (Number.isNaN(dep)) {
        await conn.rollback();
        return res.status(400).json({ ok: false, error: "Seña inválida" });
      }
      if (dep < 0) {
        await conn.rollback();
        return res.status(400).json({ ok: false, error: "La seña no puede ser negativa" });
      }
      if (price > 0 && dep > price) {
        await conn.rollback();
        return res.status(400).json({ ok: false, error: "La seña no puede superar el precio del servicio" });
      }
    }

    // UPDATE (scoped)
    let setPaidAtSQL = "";
    const params = [
      newCustomerId,
      stylistId,
      serviceId,
      startMySQL,
      endMySQL,
      status,
      depositDecimal,
      id,
      tenantId
    ];

    if (markDepositAsPaid) {
      setPaidAtSQL = ", deposit_paid_at = NOW()";
    }

    const [r] = await conn.query(
      `UPDATE appointment a
          SET a.customer_id     = COALESCE(?, a.customer_id),
              a.stylist_id      = COALESCE(?, a.stylist_id),
              a.service_id      = COALESCE(?, a.service_id),
              a.starts_at       = COALESCE(?, a.starts_at),
              a.ends_at         = COALESCE(?, a.ends_at),
              a.status          = COALESCE(?, a.status),
              a.deposit_decimal = COALESCE(?, a.deposit_decimal)
              ${setPaidAtSQL}
        WHERE a.id = ? AND a.tenant_id = ?`,
      params
    );

    if (r.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error("❌ [PUT /appointments/:id] ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    conn.release();
  }
});

appointments.delete("/:id", requireAuth, requireRole("admin", "user"), async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const { id } = req.params;
    const [r] = await pool.query(
      `DELETE FROM appointment WHERE id=? AND tenant_id=?`,
      [id, tenantId]
    );

    if (r.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------- Utilidades -------- */
const UPCOMING_STATUSES = ["scheduled", "confirmed", "deposit_paid", "pending_deposit"];

// Si la usás fuera de rutas, pasá explícito tenantId en opts
export async function listUpcomingAppointmentsByPhone(phone_e164, { limit = 5, tenantId } = {}) {
  if (!phone_e164) return [];
  if (!tenantId) throw new Error("Tenant no identificado");

  const phone = String(phone_e164).replace(/\D/g, "");
  const params = [tenantId, phone, ...UPCOMING_STATUSES, Number(limit)];
  const placeholders = UPCOMING_STATUSES.map(() => "?").join(",");

  const [rows] = await pool.query(
    `
    SELECT a.id, a.starts_at, a.ends_at, a.status,
           s.name  AS service_name,
           st.name AS stylist_name
      FROM appointment a
      JOIN customer  c  ON c.id  = a.customer_id AND c.tenant_id = a.tenant_id
      JOIN service   s  ON s.id  = a.service_id  AND s.tenant_id = a.tenant_id
      JOIN stylist   st ON st.id = a.stylist_id AND st.tenant_id = a.tenant_id
     WHERE a.tenant_id = ?
       AND c.phone_e164 = ?
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
