// src/whatsapp.js
const BASE_URL = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`;
const TOKEN = (process.env.WHATSAPP_TOKEN || "").trim();

/** Normaliza el número a formato numérico (sin + ni espacios) */
function normalizeTo(num) {
  return String(num).replace(/\D/g, "");
}

/** ✅ Enviar texto simple */
export async function sendWhatsAppText(to, text) {
  const res = await fetch(`${BASE_URL}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizeTo(to),
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[WA] sendText ${res.status}: ${err}`);
  }
}

/** ✅ Enviar plantilla aprobada (HSM) */
export async function sendWhatsAppTemplate(to, templateName, variables = [], lang = "es") {
  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "template",
    template: {
      name: templateName,               // ej: "recordatorio_turno"
      language: { code: lang },         // "es", "es_AR", etc.
      components: [
        {
          type: "body",
          parameters: variables.map(v => ({ type: "text", text: String(v) })),
        },
      ],
    },
  };

  const res = await fetch(`${BASE_URL}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    // Intentá parsear JSON para ver code y fbtrace_id
    let errTxt;
    try { errTxt = await res.text(); } catch { errTxt = `${res.status}`; }
    throw new Error(`[WA] sendTemplate ${res.status}: ${errTxt}`);
  }
}

/** (sigue igual) enviar lista interactiva */
export async function sendWhatsAppList(to, { header, body, buttonText, sections }) {
  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: header },
      body: { text: body },
      footer: { text: "Pelu de Barrio" },
      action: { button: buttonText, sections },
    },
  };

  const res = await fetch(`${BASE_URL}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[WA] sendList ${res.status}: ${err}`);
  }
}
