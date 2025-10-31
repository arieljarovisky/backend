// src/payments.js
import crypto from "crypto";
import { cfgNumber, cfgString } from "./services/config.js";

let mp = null;
try {
  // npm i mercadopago
  const { MercadoPagoConfig, Preference } = await import("mercadopago");
  const accessToken = process.env.MP_ACCESS_TOKEN || "";
  if (accessToken) {
    const client = new MercadoPagoConfig({ accessToken });
    mp = { pref: new Preference(client) };
  }
} catch { /* fallback sin SDK */ }

function asMoney(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

/**
 * Crea un link de pago para la seña.
 * Acepta:
 * - amount: monto de seña ya calculado (prioridad si viene)
 * - servicePrice: precio total, calcula % desde config
 */
export async function createDepositPaymentLink({
  amount,                // number, seña ya calculada
  servicePrice,          // number, precio total (alternativa)
  title,
  externalReference,
  successUrl,
  failureUrl,
  notificationUrl = process.env.WH_URL_MP_WEBHOOK,
  payer = {},
}) {
  // 1) decidir monto
  let value = 0;
  if (amount != null) {
    value = asMoney(amount);
  } else {
    const pct = await cfgNumber("deposit.percentage", 50);
    const base = asMoney(servicePrice);
    value = asMoney(base * (pct / 100));
  }
  if (!value || value <= 0) throw new Error("Monto de seña inválido");

  const currency = (await cfgString("general.currency", "ARS")) || "ARS";

  // 2) MP real
  if (mp?.pref) {
    const body = {
      items: [{ id: "deposit", title: title || "Seña turno", quantity: 1, currency_id: currency, unit_price: value }],
      notification_url: notificationUrl || undefined,
      external_reference: String(externalReference || ""),
      payer: {
        name: payer.name,
        email: payer.email,
        phone: payer.phone ? { number: payer.phone } : undefined,
      },
    };
    if (successUrl || failureUrl) {
      body.back_urls = {
        ...(successUrl ? { success: successUrl, pending: successUrl } : {}),
        ...(failureUrl ? { failure: failureUrl } : {}),
      };
      body.auto_return = "approved";
    }
    const pref = await mp.pref.create({ body });
    const initPoint = pref?.init_point || pref?.sandbox_init_point;
    if (!initPoint) throw new Error("No se pudo obtener init_point");
    return initPoint;
  }

  // 3) Fallback DEV
  const fakeId = crypto.randomUUID();
  const q = new URLSearchParams({
    amount: value.toFixed(2),
    ref: String(externalReference || ""),
    t: title || "Sena turno",
  });
  return `https://example-pay.local/pay?${q.toString()}#${fakeId}`;
}
