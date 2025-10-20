// src/whatsapp-ui.js
// src/whatsapp-ui.js
export async function sendList(to, { header, body, buttonText, rows, title = "Opciones" }) {
  const limited = rows.slice(0, 10); // ← nunca más de 10 filas
  const payload = {
    messaging_product: "whatsapp",
    to: String(to).replace(/\D/g, ""),
    type: "interactive",
    interactive: {
      type: "list",
      header: header ? { type: "text", text: header } : undefined,
      body: { text: body },
      footer: { text: "Pelu de Barrio" },
      action: { button: buttonText.slice(0, 20), sections: [{ title, rows: limited }] }
    }
  };
  return sendInteractive(payload);
}

export async function sendButtons(to, { header, body, buttons }) {
  const payload = {
    messaging_product: "whatsapp",
    to: String(to).replace(/\D/g, ""),
    type: "interactive",
    interactive: {
      type: "button",
      header: header ? { type: "text", text: header } : undefined,
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) }
        }))
      }
    }
  };
  return sendInteractive(payload);
}

async function sendInteractive(payload) {
  const url = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`[WA] interactive ${res.status}: ${await res.text()}`);
}
