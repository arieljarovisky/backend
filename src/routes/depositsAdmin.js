// src/routes/depositsAdmin.js — MULTI-TENANT
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const depositsAdmin = Router();
depositsAdmin.use(requireAuth, requireRole("admin","user"));

/**
 * GET /api/deposits?status=pending|paid|all&from=YYYY-MM-DD&to=YYYY-MM-DD&stylistId=#
 * Lista señas (turnos con depósito configurado)
 */
depositsAdmin.get("/deposits", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const status = String(req.query.status || "pending");
    const from = (req.query.from || "").toString().slice(0,10);
    const to   = (req.query.to   || "").toString().slice(0,10);
    const stylistId = req.query.stylistId ? Number(req.query.stylistId) : null;

    const fromTs = from ? `${from} 00:00:00` : "1970-01-01 00:00:00";
    const toTs   = to   ? `${to} 23:59:59` : "2999-12-31 23:59:59";

    let sql = `
      SELECT 
        a.id, a.starts_at, a.ends_at, a.status,
        a.deposit_decimal, a.deposit_paid_at, a.hold_until,
        s.name AS service, st.name AS stylist,
        c.name AS customer, c.phone_e164 AS phone
      FROM appointment a
      JOIN service  s  ON s.id=a.service_id  AND s.tenant_id=a.tenant_id
      JOIN stylist  st ON st.id=a.stylist_id AND st.tenant_id=a.tenant_id
      LEFT JOIN customer c ON c.id=a.customer_id AND c.tenant_id=a.tenant_id
      WHERE a.tenant_id=?
        AND a.deposit_decimal IS NOT NULL
        AND a.starts_at BETWEEN ? AND ?
    `;
    const params = [tenantId, fromTs, toTs];

    if (status === "pending") {
      sql += " AND a.status IN ('pending_deposit')";
    } else if (status === "paid") {
      sql += " AND a.status IN ('deposit_paid','confirmed','completed') AND a.deposit_paid_at IS NOT NULL";
    }
    if (stylistId) {
      sql += " AND a.stylist_id = ?";
      params.push(stylistId);
    }

    sql += " ORDER BY a.starts_at ASC";

    const [rows] = await pool.query(sql, params);
    res.json({ ok:true, data: rows });
  } catch (e) {
    console.error("[GET /deposits] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

/**
 * POST /api/deposits/:appointmentId/confirm
 * Body: { amount_decimal? } — marca la seña como pagada (manual/caja)
 */
depositsAdmin.post("/deposits/:appointmentId/confirm", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const tenantId = req.tenant.id;
    const apptId = Number(req.params.appointmentId);
    const amountDecimal = req.body?.amount_decimal != null ? Number(req.body.amount_decimal) : null;

    await conn.beginTransaction();

    const [[appt]] = await conn.query(
      `SELECT id, status, deposit_decimal FROM appointment WHERE id=? AND tenant_id=? FOR UPDATE`,
      [apptId, tenantId]
    );
    if (!appt) {
      await conn.rollback();
      return res.status(404).json({ ok:false, error:"Turno no encontrado en tu cuenta" });
    }
    if (appt.deposit_decimal == null && amountDecimal == null) {
      await conn.rollback();
      return res.status(400).json({ ok:false, error:"El turno no tenía seña configurada. Enviá amount_decimal." });
    }

    const depositToSet = amountDecimal != null ? amountDecimal : Number(appt.deposit_decimal || 0);

    // Registrar pago (opcional) en tabla payment
    await conn.query(
      `INSERT INTO payment (tenant_id, appointment_id, method, amount_cents, currency, created_at)
       VALUES (?,?,?,?, 'ARS', NOW())`,
      [tenantId, apptId, 'manual', Math.round(depositToSet * 100)]
    );

    // Marcar turno como pagado
    await conn.query(
      `UPDATE appointment
          SET deposit_decimal = ?,
              deposit_paid_at = COALESCE(deposit_paid_at, NOW()),
              hold_until = NULL,
              status = CASE 
                         WHEN status='pending_deposit' THEN 'deposit_paid'
                         ELSE status
                       END
        WHERE id=? AND tenant_id=?`,
      [depositToSet, apptId, tenantId]
    );

    await conn.commit();
    res.json({ ok:true, message:"Seña confirmada" });
  } catch (e) {
    await conn.rollback();
    console.error("[POST /deposits/:id/confirm] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  } finally {
    conn.release();
  }
});

/**
 * POST /api/deposits/:appointmentId/cancel
 * Cancela un turno "pendiente de seña" y libera el lugar.
 */
depositsAdmin.post("/deposits/:appointmentId/cancel", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const apptId = Number(req.params.appointmentId);

    // Solo permite cancelar si sigue pendiente
    const [r] = await pool.query(
      `UPDATE appointment
          SET status='cancelled', hold_until=NULL
        WHERE id=? AND tenant_id=? AND status='pending_deposit'`,
      [apptId, tenantId]
    );

    if (!r.affectedRows) {
      return res.status(400).json({ ok:false, error:"No se pudo cancelar (¿ya no está pendiente?)" });
    }

    res.json({ ok:true, message:"Turno cancelado y lugar liberado" });
  } catch (e) {
    console.error("[POST /deposits/:id/cancel] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

/**
 * POST /api/deposits/expire-holds
 * Cancela automáticamente turnos pendientes cuya reserva expiró (hold_until < NOW()).
 */
depositsAdmin.post("/deposits/expire-holds", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const [r] = await pool.query(
      `UPDATE appointment
          SET status='cancelled', hold_until=NULL
        WHERE tenant_id=?
          AND status='pending_deposit'
          AND hold_until IS NOT NULL
          AND hold_until < NOW()`,
      [tenantId]
    );
    res.json({ ok:true, affected: r.affectedRows });
  } catch (e) {
    console.error("[POST /deposits/expire-holds] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});
