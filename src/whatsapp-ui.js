// src/whatsapp-ui.js
// ❌ No importamos desde whatsapp.js para evitar el ciclo circular

// Normaliza el número para la API de WhatsApp (e.164 simple / dígitos y '+')
function normalizeTo(to) {
  return String(to || "").trim().replace(/[^\d+]/g, "");
}

// Corta strings con sufijo "…" si supera el límite (evita 400 de la API)
function clamp(s, max) {
  const txt = String(s ?? "");
  return txt.length <= max ? txt : txt.slice(0, Math.max(0, max - 1)) + "…";
}

// En WhatsApp List:
// - Máx 10 filas por request
// - buttonText máx 20
// - row.title máx 24
// - row.description máx ~72 (dejamos 72)
// - row.id máx ~200 (estamos bien)
export async function sendList(
  to,
  { header, body, buttonText = "Ver", rows, title = "Opciones" }
) {
  const safeRows = (rows || [])
    .slice(0, 10)
    .map((r) => ({
      id: String(r.id),
      title: clamp(r.title ?? "", 24),
      ...(r.description ? { description: clamp(r.description, 72) } : {}),
    }));

  if (safeRows.length === 0) {
    // Evitamos llamar a la API sin filas (también rompe)
    return;
  }

  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "interactive",
    interactive: {
      type: "list",
      ...(header ? { header: { type: "text", text: clamp(header, 60) } } : {}),
      body: { text: clamp(body ?? "", 1024) },
      footer: { text: "Pelu de Barrio" },
      action: {
        button: clamp(buttonText, 20),
        sections: [
          {
            title: clamp(title, 24),
            rows: safeRows,
          },
        ],
      },
    },
  };

  return sendInteractive(payload);
}

export async function sendButtons(to, { header, body, buttons = [] }) {
  const safeButtons = (buttons || []).slice(0, 3).map((b) => ({
    type: "reply",
    reply: {
      id: String(b.id),
      title: clamp(b.title ?? "", 20),
    },
  }));

  const payload = {
    messaging_product: "whatsapp",
    to: normalizeTo(to),
    type: "interactive",
    interactive: {
      type: "button",
      ...(header ? { header: { type: "text", text: clamp(header, 60) } } : {}),
      body: { text: clamp(body ?? "", 1024) },
      action: { buttons: safeButtons },
    },
  };

  return sendInteractive(payload);
}

async function sendInteractive(payload) {
  const url = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[WA] interactive ${res.status}: ${text}`);
  }
}
