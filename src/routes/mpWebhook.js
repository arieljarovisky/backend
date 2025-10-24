// src/routes/mpWebhook.js
import { Router } from "express";
import { pool } from "../db.js";
import { sendWhatsAppText } from "../whatsapp.js";

export const mpWebhook = Router();

mpWebhook.post("/webhooks/mp", async (req, res) => {
  try {
    // Soporte real + modo dev con querystring
    const type = req.body?.type || req.query?.type;
    const paymentId = req.body?.data?.id || req.query?.id;
    const extRefQS = req.query?.external_reference;
    const statusQS = (req.query?.status || "").toLowerCase();

    let external_reference = null;
    let status = null;

    // Si usás SDK de MP podés consultar el pago; para simplificar:
    if (extRefQS) {
      external_reference = String(extRefQS);
      status = statusQS || "approved";
    } else if (type === "payment" && paymentId) {
      // TODO: consultar MP Payment por ID y setear external_reference + status
      // (omito por brevedad; si lo querés te paso el bloque con SDK)
    }

    if (!external_reference) return res.json({ ok: true, msg: "noop" });

    if (status === "approved") {
      // Idempotencia: solo actualiza si aún no estaba paga
      const [upd] = await pool.query(
        `UPDATE appointment 
            SET deposit_paid_at = NOW()
          WHERE id = ? AND deposit_paid_at IS NULL`,
        [external_reference]
      );

      if (upd.affectedRows > 0) {
        // obtener datos para el mensaje
        const [[row]] = await pool.query(
          `SELECT a.id, a.deposit_decimal, 
                  c.phone_e164, 
                  s.name AS service_name,
                  st.name AS stylist_name,
                  DATE_FORMAT(a.starts_at, '%Y-%m-%dT%H:%i:%s') AS starts_at
             FROM appointment a
             JOIN customer  c  ON c.id  = a.customer_id
             JOIN service   s  ON s.id  = a.service_id
             JOIN stylist   st ON st.id = a.stylist_id
            WHERE a.id = ?`,
          [external_reference]
        );

        if (row?.phone_e164) {
          const d = new Date(row.starts_at);
          const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
          const hora  = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

          const msg =
            `¡Gracias! ✅ Recibimos tu seña de *$${Number(row.deposit_decimal||0).toFixed(2)}*.\n` +
            `Turno: *${row.service_name}* con *${row.stylist_name}*\n` +
            `Fecha: *${fecha} ${hora}*\n\n` +
            `Cualquier cambio, escribinos por acá.`;
          await sendWhatsAppText(row.phone_e164, msg);
        }
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[MP webhook] error:", e);
    return res.status(200).json({ ok: true }); // MP reintenta
  }
});
