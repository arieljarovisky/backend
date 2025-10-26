// src/routes/mpWebhook.js
import { Router } from "express";
import { pool } from "../db.js";
import { sendWhatsAppText /*, sendWhatsAppTemplate*/ } from "../whatsapp.js";

export const mpWebhook = Router();

mpWebhook.get("/", (req, res) => res.sendStatus(200));

mpWebhook.post("/", async (req, res) => {
  console.log("[MP Webhook] body:", JSON.stringify(req.body, null, 2));

  try {
    const body = req.body || {};

    // === 1) Detectar paymentId y estado del payload entrante (MP manda mil variantes) ===
    const paymentId =
      body?.data?.id || body?.id || body?.resource?.split?.("/")?.pop?.() || null;
    const status = body?.data?.status || body?.status || null;

    // appointment_id si vos lo mandás en tu webhook interno (si no, luego lo deducimos por external_reference al consultar MP)
    const appointmentIdInBody = body?.appointment_id || null;

    // Log básico (idempotente por payment_id)
    if (paymentId) {
      await pool.query(
        `INSERT INTO mp_webhook_log (payment_id, appointment_id, status, created_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           appointment_id = COALESCE(VALUES(appointment_id), appointment_id)`
        , [String(paymentId), appointmentIdInBody, status || null]
      );
    }

    // === 2) Disparamos el procesador (reintenta y deja trazas en processed_at / error_message) ===
    await processPendingLogs({ onlyPaymentId: paymentId });

    return res.sendStatus(200);
  } catch (e) {
    console.error("[MP Webhook] Error general:", e?.message, e);
    return res.sendStatus(200);
  }
});

// ===== Procesador de logs pendientes =====
async function processPendingLogs({ onlyPaymentId = null } = {}) {
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
      // 1) Leer pago de MP
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

      // 1.1) Debe estar aprobado
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
        console.log(`[MP->PROC] Pago ${paymentId} NO aprobado (${pay?.status}). Marcado como procesado y omitido.`);
        continue;
      }

      // 2) Resolver appointment_id
      const appointmentId = row.appointment_id || externalRef;
      if (!appointmentId) {
        throw new Error("No pude determinar appointment_id (faltan appointment_id y external_reference).");
      }
      console.log(`[MP->PROC] appointment_id=${appointmentId}`);

      // 3) Traer datos del turno (ANTES del update)
      const [[ap]] = await pool.query(
        `SELECT a.id, a.starts_at, a.status, a.deposit_decimal, a.deposit_paid_at,
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

      const wasPending = ap.status === "pending_deposit";
      const hadPaidAt = Boolean(ap.deposit_paid_at);

      // 4) Actualizar turno (status + depósito + paid_at)
      const updParams = [];
      let setDeposit = "";
      if (amount != null) { setDeposit = ", deposit_decimal = COALESCE(deposit_decimal, 0) + ?"; updParams.push(amount); }

      const [upd] = await pool.query(
        `UPDATE appointment
      SET status = CASE WHEN status = 'pending_deposit' THEN 'scheduled' ELSE status END
          ${setDeposit},
          deposit_paid_at = COALESCE(deposit_paid_at, NOW())
    WHERE id = ?`,
        [...updParams, appointmentId]
      );

      // 5) WhatsApp SOLO si recién se confirmó
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
        try { if (ap.phone) await sendWhatsAppText(ap.phone, msg); } catch { }
      }
      // 6) Marcar log como procesado SIEMPRE (aunque falle WA)
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
      // Guardamos el error pero no seteamos processed_at para poder reintentar
      await pool.query(
        `UPDATE mp_webhook_log
           SET error_message = ?
         WHERE payment_id = ?`,
        [String(err?.message || err), paymentId]
      );
    }
  }
}


// ===== (OPCIONAL) endpoint para reintentar manualmente desde el navegador/Postman =====
mpWebhook.post("/reprocess", async (req, res) => {
  try {
    await processPendingLogs();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
