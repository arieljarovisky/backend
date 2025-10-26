// src/whatsapp.js
import { toSandboxAllowed } from "./helpers/numbers.js";

const WA_API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
const WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
const WA_TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();
const DEFAULT_COUNTRY = (process.env.DEFAULT_COUNTRY_DIAL || "54").replace(/^\+/, ""); // 54 = AR
const DEBUG = String(process.env.WHATSAPP_DEBUG || "false").toLowerCase() === "true";


if (!WHATSAPP_PHONE_NUMBER_ID || !WA_TOKEN) {
  console.error("[WA] Faltan variables de entorno: WHATSAPP_PHONE_NUMBER_ID y/o WHATSAPP_TOKEN");
  // No tiro error duro para no tumbar el server si solo querés desactivar WA
}

const BASE_URL = `https://graph.facebook.com/${WA_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}`;

/** Normaliza a E.164 numérica. Si no trae prefijo país, agrega DEFAULT_COUNTRY. */
export function normalizeTo(num) {
  // 1) dejá solo dígitos
  const digits = String(num || "").replace(/\D/g, "");
  if (!digits) return "";

  // 2) quita el '9' post 54 para móviles AR (54911xxxx -> 5411xxxx)
  const arFixed = toSandboxAllowed(digits);

  // 3) si no trae país, agregá el por defecto
  if (arFixed.startsWith(DEFAULT_COUNTRY)) return arFixed;
  return DEFAULT_COUNTRY + arFixed;
}
/** Fetch con manejo de errores de Graph */
async function request(path, body) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WA_TOKEN) {
    if (DEBUG) console.warn("[WA] Saltando envío (sin credenciales):", path, body?.type);
    return { skipped: true };
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let text = "";
  try { text = await res.text(); } catch { }

  if (DEBUG) {
    console.log(`[WA][${res.status}] ${path}`, {
      req: body,
      resRaw: text?.slice(0, 800),
    });
  }

  if (!res.ok) {
    // intento parsear el json de error de Graph
    try {
      const j = JSON.parse(text);
      const err = j?.error || {};
      const msg = `[WA] ${body?.type || "request"} ${res.status} code=${err.code} sub=${err.error_subcode} type=${err.type} ${err.message || ""} fbtrace_id=${err.fbtrace_id || ""}`;
      throw new Error(msg);
    } catch {
      throw new Error(`[WA] ${body?.type || "request"} ${res.status}: ${text || "(sin cuerpo)"}`);
    }
  }

  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

/** ✅ Texto simple */
export async function sendWhatsAppText(toE164, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID; // << ID del número de LA EMPRESA
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneNumberId || !token) throw new Error("Faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_TOKEN");

  const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: String(toE164),            // E.164 (sin + opcional)
      type: "text",
      text: { body: text },
    }),
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    console.error("[WA] sendText error:", errTxt);
    throw new Error(`[WA] ${resp.status} ${errTxt}`);
  }
}
/** ✅ Plantilla (HSM) aprobada en Business Manager */
export async function sendWhatsAppTemplate(toE164, templateName, lang = "es_AR", components = []) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: String(toE164),
      type: "template",
      template: {
        name: templateName, // ej: payment_confirmation
        language: { code: lang },
        components,         // variables si el template las tiene
      },
    }),
  });

  if (!resp.ok) throw new Error(`[WA] ${resp.status} ${await resp.text()}`);
}

/** ✅ Lista interactiva */
export async function sendWhatsAppList(to, { header, body, buttonText, sections }) {
  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "interactive",
    interactive: {
      type: "list",
      header: header ? { type: "text", text: String(header) } : undefined,
      body: { text: String(body || "") },
      footer: { text: "Pelu de Barrio" },
      action: { button: String(buttonText || "Elegir"), sections: sections || [] },
    },
  };
  return request("/messages", payload);
}

/** (Extra) Imagen por URL (útil para flyers/promo) */
export async function sendWhatsAppImageUrl(to, imageUrl, caption = "") {
  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "image",
    image: { link: String(imageUrl), caption: String(caption || "") },
  };
  return request("/messages", payload);
}

/* ========= Helpers de alto nivel (opcional) ========= */

/** Mensaje de confirmación de turno (texto plano) */
export async function sendBookingConfirmation({ to, customerName, serviceName, stylistName, startsAt }) {
  // formateo local legible
  const d = new Date(startsAt);
  const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
  const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  const msg =
    `¡Hola ${customerName || ""}! 👋\n` +
    `✅ Confirmamos tu turno:\n` +
    `• Servicio: *${serviceName}*\n` +
    `• Peluquero/a: *${stylistName}*\n` +
    `• Fecha: *${fecha} ${hora}*\n\n` +
    `Si necesitás reprogramar, escribinos por acá.`;
  return sendWhatsAppText(to, msg);
}
