// src/routes/mpWebhook.js
import { Router } from "express";
import { pool } from "../db.js";
import { sendWhatsAppText } from "../whatsapp.js";

export const mpWebhook = Router();

mpWebhook.get("/", (req, res) => res.sendStatus(200));

mpWebhook.post("/", async (req, res) => {
  console.log("[MP Webhook] body:", JSON.stringify(req.body, null, 2));
  try {
    const body = req.body || {};

    const paymentId =
      body?.data?.id || body?.id || body?.resource?.split?.("/")?.pop?.() || null;
    const status = body?.data?.status || body?.status || null;
    const appointmentIdInBody = body?.appointment_id || null;
    const fallbackTenantId = Number(process.env.BOT_TENANT_ID || 0);

    if (paymentId) {
      await pool.query(
        `INSERT INTO mp_webhook_log (payment_id, appointment_id, status, created_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           appointment_id = COALESCE(VALUES(appointment_id), appointment_id)`,
        [String(paymentId), appointmentIdInBody, status || null]
      );
    }

    await processPendingLogs({ onlyPaymentId: paymentId, fallbackTenantId });
    return res.sendStatus(200);
  } catch (e) {
    console.error("[MP Webhook] Error general:", e?.message, e);
    return res.sendStatus(200);
  }
});

async function processPendingLogs({ onlyPaymentId = null, fallbackTenantId = 0 } = {}) {
  const where = onlyPaymentId
    ? "WHERE l.payment_id = ? AND l.processed_at IS NULL"
    : "WHERE l.processed_at IS NULL";
  const params = onlyPaymentId ? [String(onlyPaymentId)] : [];

  const [rows] = await pool.query(
    `SELECT l.payment_id, l.appointment_id, l.status, l.created_at
       FROM mp_webhook_log l
       ${where}
       ORDER BY l.created_at ASC
       LIMIT 50`,
    params
  );
  if (!rows.length) {
    console.log("[MP->PROC] No hay pagos pendientes por procesar");
    return;
  }

  for (const row of rows) {
    const paymentId = String(row.payment_id);
    console.log(`\n[MP->PROC] === Iniciando pago ${paymentId} ===`);

    try {
      // 1) Obtener pago real desde MP
      let pay = null, amount = null, externalRef = null;
      try {
        const token = process.env.MP_ACCESS_TOKEN;
        if (!token) throw new Error("Falta MP_ACCESS_TOKEN");

        const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const raw = await r.text();
        if (!r.ok) throw new Error(`MP ${r.status} ${raw}`);

        pay = JSON.parse(raw);
        amount = Number(pay?.transaction_amount ?? 0) || null;
        externalRef = pay?.external_reference ? String(pay.external_reference) : null;
        console.log(`[MP->PROC] Pago ${paymentId} status=${pay?.status} amount=${amount} extRef=${externalRef}`);
      } catch (e) {
        console.error(`[MP->PROC] Error leyendo MP ${paymentId}:`, e.message);
      }

      // 1.1) Solo aprobados
      const approved = (pay?.status || "").toLowerCase() === "approved";
      if (!approved) {
        await pool.query(
          `UPDATE mp_webhook_log
             SET status = ?,
                 processed_at = NOW(),
                 error_message = NULL
           WHERE payment_id = ?`,
          [pay?.status || row.status || null, paymentId]
        );
        console.log(`[MP->PROC] Pago ${paymentId} NO aprobado (${pay?.status}). Omitido.`);
        continue;
      }

      // 2) appointment_id (por log o por external_reference)
      const appointmentId = row.appointment_id || (externalRef ? Number(externalRef) : null);
      if (!appointmentId || Number.isNaN(appointmentId)) {
        throw new Error("No pude determinar appointment_id (external_reference inválido).");
      }
      console.log(`[MP->PROC] appointment_id=${appointmentId}`);


      // 3) Datos del turno + tenant
      const [[ap]] = await pool.query(
        `SELECT a.id, a.tenant_id, a.starts_at, a.status, a.deposit_decimal, a.deposit_paid_at,
              s.name AS service_name, st.name AS stylist_name,
              c.phone_e164 AS phone, c.name AS customer_name
         FROM appointment a
         JOIN service  s  ON s.id  = a.service_id
         JOIN stylist  st ON st.id = a.stylist_id
         JOIN customer c  ON c.id  = a.customer_id
        WHERE a.id = ?`,
        [appointmentId]
      );
      if (!ap) throw new Error(`Turno ${appointmentId} no encontrado.`);
      const tenantId = Number(ap.tenant_id || fallbackTenantId || 0);
      if (!tenantId) throw new Error("No pude resolver tenant_id para el pago.");
      const wasPending = ap.status === "pending_deposit";
      const hadPaidAt = Boolean(ap.deposit_paid_at);

      // 3.1) Registrar el cobro en tabla payment (ANTES de mensajes y de cerrar el log)
      //      Usamos uq_mp (mp_payment_id único) para idempotencia.
      const gross = amount;
      const fee =
        Array.isArray(pay?.fee_details) && pay.fee_details[0]?.amount != null
          ? Number(pay.fee_details[0].amount)
          : null;
      const net =
        pay?.net_received_amount != null ? Number(pay.net_received_amount) : null;

      await pool.query(
        `INSERT INTO payment
    (tenant_id, appointment_id, method, amount_cents, currency,
     gross_amount_cents, fee_cents, net_amount_cents,
     mp_payment_id, mp_raw_json, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,NOW())
   ON DUPLICATE KEY UPDATE
     appointment_id = COALESCE(VALUES(appointment_id), appointment_id)`
        ,
        [
          tenantId,
          appointmentId,
          'mercadopago',
          amount != null ? Math.round(amount * 100) : null,
          'ARS',
          amount != null ? Math.round(amount * 100) : null,
          fee != null ? Math.round(fee * 100) : null,
          net != null ? Math.round(net * 100) : null,
          String(paymentId),                        // IMPORTANTE: no null
          JSON.stringify(pay || null)
        ]
      );

      // 4) Update idempotente del turno
      const setStatusTo = "deposit_paid"; // o 'confirmed' si preferís
      await pool.query(
        `UPDATE appointment
            SET status = CASE WHEN status = 'pending_deposit' THEN ? ELSE status END,
                deposit_decimal = COALESCE(deposit_decimal, ?),
                deposit_paid_at = COALESCE(deposit_paid_at, NOW()),
                hold_until = NULL,
                mp_payment_id = COALESCE(mp_payment_id, ?),
                mp_payment_status = ?
          WHERE id = ? AND tenant_id = ?`,
        [setStatusTo, amount ?? null, paymentId, (pay?.status || row.status || null), appointmentId, tenantId]
      );

      // 5) WhatsApp solo si “recién confirmado”
      const justConfirmed = wasPending || !hadPaidAt;
      if (justConfirmed) {
        const d = new Date(ap.starts_at);
        const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
        const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
        const saludo = ap.customer_name ? `¡Gracias, ${ap.customer_name}!` : "¡Gracias!";
        const montoTxt = amount != null ? `\nMonto acreditado: *$${amount.toFixed(2)}*` : "";
        const msg =
          `¡Pago recibido! ✅ ${saludo}\n\n` +
          `Tu turno quedó *confirmado*:\n` +
          `• Servicio: *${ap.service_name}*\n` +
          `• Peluquero: *${ap.stylist_name}*\n` +
          `• Fecha: *${fecha} ${hora}*${montoTxt}\n\n` +
          `Te esperamos 💈`;
        try {
          if (ap.phone) await sendWhatsAppText(ap.phone, msg);
        } catch { }
      }

      // 6) Log → processed
      await pool.query(
        `UPDATE mp_webhook_log
            SET appointment_id = COALESCE(appointment_id, ?),
                status = 'approved',
                processed_at = NOW(),
                error_message = NULL
          WHERE payment_id = ?`,
        [appointmentId, paymentId]
      );
      console.log(`[MP->PROC] Marcado processed_at OK para ${paymentId}`);
    } catch (err) {
      console.error(`[MP->PROC] Error con payment_id ${paymentId}:`, err.message);
      await pool.query(
        `UPDATE mp_webhook_log
            SET error_message = ?
          WHERE payment_id = ?`,
        [String(err?.message || err), paymentId]
      );
    }
  }
}

// Reproceso manual
mpWebhook.post("/reprocess", async (_req, res) => {
  try {
    await processPendingLogs();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
