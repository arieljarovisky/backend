import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";
export const payments = Router();

payments.post("/", requireAuth, requireRole("admin","staff"), async (req, res) => {
  try {
    const {
      appointmentId = null,
      method, // 'cash'|'transfer'|'card'|'other'
      amount_cents,
      currency = "ARS",
      recorded_by = null,
      notes = null,
      markDepositAsPaid = true
    } = req.body || {};

    if (!method || !amount_cents) {
      return res.status(400).json({ ok:false, error:"method y amount_cents requeridos" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO payment
         (appointment_id, method, amount_cents, currency, recorded_by, notes, created_at)
         VALUES (?,?,?,?,?,?,NOW())`,
        [appointmentId, method, Number(amount_cents), currency, recorded_by, notes]
      );

      if (appointmentId && markDepositAsPaid) {
        await conn.query(
          `UPDATE appointment
             SET deposit_decimal = COALESCE(deposit_decimal, ?),
                 deposit_paid_at = COALESCE(deposit_paid_at, NOW()),
                 hold_until = NULL,
                 status = CASE WHEN status='pending_deposit' THEN 'deposit_paid' ELSE status END
           WHERE id=?`,
          [ Number(amount_cents) / 100, appointmentId ]
        );
      }

      await conn.commit();
      res.json({ ok:true });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});
