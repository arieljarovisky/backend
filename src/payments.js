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

// === URLs de retorno a WhatsApp (sin páginas web) ===
const waNumber = process.env.BUSINESS_WA_E164 || ""; // ej: 54911XXXXXXXX (sin +)
const successMsg = encodeURIComponent(
    "¡Listo! Volví a WhatsApp. Si el pago fue aprobado te confirmamos por acá ✂️"
);
const failureMsg = encodeURIComponent(
    "El pago no se completó. Volví a WhatsApp y probá de nuevo o pedinos ayuda."
);
const successWa = waNumber ? `https://wa.me/${waNumber}?text=${successMsg}` : "https://wa.me";
const failureWa = waNumber ? `https://wa.me/${waNumber}?text=${failureMsg}` : "https://wa.me";

/**
 * Crea un link de pago para la seña.
 * Si MP no está configurado, devuelve un link de prueba (fallback).
 */
export async function createDepositPaymentLink({
    amount,                // number
    title,                 // string
    externalReference,     // string (ej: appointmentId)
    successUrl,            // opcional: si no viene, usamos successWa
    failureUrl,            // opcional: si no viene, usamos failureWa
    notificationUrl = process.env.WH_URL_MP_WEBHOOK, // puede venir undefined
    payer = {}             // { name, email, phone }
}) {
    const value = Math.max(0, Number(amount || 0));
    if (!value) throw new Error("Monto de seña inválido");

    const backSuccess = successUrl || successWa;
    const backFailure = failureUrl || failureWa;

    // === Mercado Pago real ===
    if (mp?.pref) {
        const pref = await mp.pref.create({
            body: {
                items: [
                    {
                        id: "deposit",
                        title: title || "Seña turno",
                        quantity: 1,
                        currency_id: "ARS",
                        unit_price: value,
                    },
                ],
                back_urls: {
                    success: backSuccess,
                    failure: backFailure,
                    pending: backSuccess, // tratamos pending como success para volver al chat
                },
                auto_return: "approved",
                notification_url: notificationUrl || undefined,
                external_reference: String(externalReference || ""),
                payer: {
                    name: payer.name,
                    email: payer.email,
                    phone: { number: payer.phone },
                },
            },
        });

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
