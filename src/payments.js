// src/payments.js
import crypto from "crypto";

let mp = null;
try {
  // npm i mercadopago
  const { MercadoPagoConfig, Preference } = await import("mercadopago");
  const accessToken = process.env.MP_ACCESS_TOKEN || "";
  if (accessToken) {
    const client = new MercadoPagoConfig({ accessToken });
    mp = { pref: new Preference(client) };
  }
} catch {
  // sin SDK o sin token → modo fallback
}

function fmt(n) {
  return Number(n || 0).toFixed(2);
}

/**
 * Crea un link de pago para la seña.
 * Por defecto NO configura back_urls ni auto_return,
 * por lo que el usuario permanece en el flujo de Mercado Pago.
 */
export async function createDepositPaymentLink({
  amount,                // number
  title,                 // string
  externalReference,     // string (ej: appointmentId)
  successUrl,            // opcional: si querés redirigir, pasalo explícito
  failureUrl,            // opcional: si querés redirigir, pasalo explícito
  notificationUrl = process.env.WH_URL_MP_WEBHOOK, // URL del webhook
  payer = {}             // { name, email, phone }
}) {
  const value = Math.max(0, Number(amount || 0));
  if (!value) throw new Error("Monto de seña inválido");

  // === Mercado Pago real ===
  if (mp?.pref) {
    const body = {
      items: [
        {
          id: "deposit",
          title: title || "Seña turno",
          quantity: 1,
          currency_id: "ARS",
          unit_price: value,
        },
      ],
      // 🔔 dejamos el webhook para confirmar server-side
      notification_url: notificationUrl || undefined,
      // 🔗 referenciamos el turno para que el webhook lo encuentre
      external_reference: String(externalReference || ""),
      // ❌ NO seteamos back_urls ni auto_return por defecto
      payer: {
        name: payer.name,
        email: payer.email,
        phone: { number: payer.phone },
      },
    };

    // Si querés redirecciones explícitas, las pasás al llamar la función
    if (successUrl || failureUrl) {
      body.back_urls = {
        ...(successUrl ? { success: successUrl } : {}),
        ...(failureUrl ? { failure: failureUrl } : {}),
        ...(successUrl ? { pending: successUrl } : {}), // opcional
      };
      // auto_return sólo tiene efecto si hay back_urls
      body.auto_return = "approved";
    }

    const pref = await mp.pref.create({ body });
    const initPoint = pref?.init_point || pref?.sandbox_init_point;
    if (!initPoint) throw new Error("No se pudo obtener init_point");
    return initPoint;
  }

  // === Fallback DEV (sin MP) ===
  const fakeId = crypto.randomUUID();
  const q = new URLSearchParams({
    amount: fmt(value),
    ref: String(externalReference || ""),
    t: title || "Sena turno",
  });
  return `https://example-pay.local/pay?${q.toString()}#${fakeId}`;
}
