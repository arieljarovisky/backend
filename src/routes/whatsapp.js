// src/routes/whatsapp.js
import { Router } from "express";
import { sendWhatsAppText } from "../whatsapp.js";
import { toSandboxAllowed } from "../helpers/numbers.js";
import { getSession, setStep, reset } from "../helpers/session.js";
import { sendList, sendButtons } from "../whatsapp-ui.js";
import { listServices, listStylists } from "../routes/meta.js"; // si exportás helpers, o crea helpers locales
import { getFreeSlots } from "../routes/availability.js";
import { createAppointment } from "../routes/appointments.js"; // función que haga el insert/transacción
import { parseDay } from "../helpers/parseDay.js";
import { listUpcomingAppointmentsByPhone } from "../routes/appointments.js";
import { getCustomerByPhone, upsertCustomerNameByPhone } from "../routes/customers.js";

export const whatsapp = Router();

// ==== Helpers de paginación (servicios / estilistas / horarios) ====
function formatMyAppointments(list) {
  if (!list?.length) return "No tenés turnos próximos.";
  const lines = list.map((a, i) => {
    const d = new Date(a.starts_at);
    const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
    const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    return `• ${fecha} ${hora} — ${a.service_name} con ${a.stylist_name}`;
  });
  return `Estos son tus próximos turnos:\n${lines.join("\n")}`;
}
function buildServiceRows(services, offset = 0) {
  const page = services.slice(offset, offset + 9).map(s => ({
    id: `svc_${s.id}`, title: s.name, description: `${s.duration_min} min`
  }));
  if (offset + 9 < services.length) page.push({ id: "svc_page_next", title: "Ver más…", description: "Más servicios" });
  return page;
}

function buildStylistRows(stylists, offset = 0) {
  const page = stylists.slice(offset, offset + 9).map(st => ({
    id: `stf_${st.id}`, title: st.name
  }));
  if (offset + 9 < stylists.length) page.push({ id: "stf_page_next", title: "Ver más…", description: "Más peluqueros" });
  return page;
}

function buildSlotRows(slots, day, offset = 0) {
  const page = slots.slice(offset, offset + 9).map(h => ({
    id: `slot_${day}_${h}`, title: h
  }));
  if (offset + 9 < slots.length) page.push({ id: "slot_page_next", title: "Ver más…", description: "Más horarios" });
  return page;
}

function extractNameFromText(txt) {
  let t = (txt || "").trim();
  // soportá formas comunes
  t = t.replace(/^soy\s+/i, "")
    .replace(/^me llamo\s+/i, "")
    .replace(/^mi nombre es\s+/i, "");
  // capitalizar simple
  return t.split(" ")
    .filter(Boolean)
    .map(w => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 80);
}
/** GET verify */
whatsapp.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/** POST inbound */
whatsapp.post("/webhooks/whatsapp", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const user = toSandboxAllowed(msg.from);
    const session = getSession(user);

    // === TEXT ===
    if (msg.type === "text") {
      const text = (msg.text?.body || "").trim().toLowerCase();

      // ======= ATAJOS =======
      if (text === "cancelar") {
        reset(user);
        await sendWhatsAppText(user, "Operación cancelada 👍");
        return res.sendStatus(200);
      }

      // ======= SALUDO / NUEVO CLIENTE =======
      if (text === "hola" || session.step === "idle") {
        const existing = await getCustomerByPhone(user);

        // 🔹 Si NO existe o no tiene nombre → pedirlo
        if (!existing || !existing.name) {
          setStep(user, "collect_name");
          await sendWhatsAppText(
            user,
            "¡Hola! 👋 Para personalizar tu experiencia, decime tu *nombre*.\nEjemplo: *Soy Ariel*"
          );
          return res.sendStatus(200);
        }

        // 🔹 Si ya es cliente → mostrar menú
        await sendButtons(user, {
          header: `¡Hola ${existing.name}! 👋`,
          body: "¿Qué querés hacer?",
          buttons: [
            { id: "action_view", title: "Ver mis turnos" },
            { id: "action_new", title: "Reservar nuevo" }
          ]
        });
        setStep(user, "home_menu", { hasApts: true });
        return res.sendStatus(200);
      }

      // ======= RECOLECCIÓN DEL NOMBRE =======
      if (session.step === "collect_name") {
        const name = extractNameFromText(text);
        if (!name || name.length < 2) {
          await sendWhatsAppText(user, "No me quedó claro 😅. Decime tu *nombre* (ej: *Soy Ariel*).");
          return res.sendStatus(200);
        }

        await upsertCustomerNameByPhone(user, name);

        await sendButtons(user, {
          header: `¡Gracias, ${name}! 🙌`,
          body: "¿Qué querés hacer?",
          buttons: [
            { id: "action_view", title: "Ver mis turnos" },
            { id: "action_new", title: "Reservar nuevo" }
          ]
        });
        setStep(user, "home_menu", { hasApts: true, customer_name: name });
        return res.sendStatus(200);
      }

      // ======= FECHA (después de elegir peluquero) =======
      if (session.step === "picking_day") {
        const day = parseDay(text); // "hoy" | "mañana" | "DD/MM" -> "YYYY-MM-DD"
        if (!day) {
          await sendWhatsAppText(user, "No te entendí. Decime *hoy*, *mañana* o *DD/MM*");
          return res.sendStatus(200);
        }

        // Traer horarios libres
        const slots = await _getSlots(session.data.stylist_id, session.data.service_id, day);

        if (!slots.length) {
          await sendWhatsAppText(user, "No hay horarios libres ese día. Probá otra fecha.");
          return res.sendStatus(200);
        }

        // Guardar y mostrar lista (con paginación)
        setStep(user, "picking_time", { day, slots, slotOffset: 0 });

        const rows = buildSlotRows(slots, day, 0); // usa tu helper (9 + "Ver más…")
        await sendList(user, {
          header: `Horarios ${day}`,
          body: "Elegí un horario:",
          buttonText: "Ver horarios",
          rows
        });
        return res.sendStatus(200);
      }


      // ======= MENSAJE GENÉRICO =======
      await sendWhatsAppText(user, "Escribí *hola* para empezar o *cancelar* para salir.");
      return res.sendStatus(200);
    }

    // === INTERACTIVE ===
    if (msg.type === "interactive") {
      const sel = msg.interactive?.list_reply || msg.interactive?.button_reply;
      const id = sel?.id || "";

      // ====== HOME: ver turnos / reservar nuevo ======
      if (session.step === "home_menu" && (id === "action_view" || id === "action_new")) {
        if (id === "action_view") {
          const myApts = await listUpcomingAppointmentsByPhone(user, { limit: 5 });
          const text = formatMyAppointments(myApts); // "No tenés turnos..." o listado formateado
          await sendWhatsAppText(user, text);
          // Ofrecé reservar después de mostrar los turnos
          await sendButtons(user, {
            header: "¿Algo más?",
            body: "Podés reservar un nuevo turno cuando quieras.",
            buttons: [{ id: "action_new", title: "Reservar nuevo" }]
          });
          return res.sendStatus(200);
        }
        if (id === "action_new") {
          const services = await _listServices();
          if (!services.length) {
            await sendWhatsAppText(user, "No hay servicios activos por ahora.");
            return res.sendStatus(200);
          }
          setStep(user, "picking_service", { services, svcOffset: 0 });
          const rows = buildServiceRows(services, 0);
          await sendList(user, {
            header: "Elegí un servicio",
            body: "Servicios disponibles:",
            buttonText: "Ver servicios",
            rows
          });
          return res.sendStatus(200);
        }
      }

      // ====== SERVICIOS: elección o "Ver más…" ======
      if (session.step === "picking_service" && (id.startsWith("svc_") || id === "svc_page_next")) {
        if (id === "svc_page_next") {
          const newOffset = (session.data.svcOffset || 0) + 9;
          setStep(user, "picking_service", { svcOffset: newOffset });
          const rows = buildServiceRows(session.data.services, newOffset);
          await sendList(user, {
            header: "Elegí un servicio",
            body: "Servicios disponibles:",
            buttonText: "Ver servicios",
            rows
          });
          return res.sendStatus(200);
        }

        const service_id = Number(id.slice(4));
        // Nombre de servicio guardado
        const svc = (session.data.services || []).find(s => s.id === service_id);
        const service_name = svc?.name || `Servicio ${service_id}`;

        const stylists = await _listStylists();
        if (!stylists.length) {
          await sendWhatsAppText(user, "No hay peluqueros activos en este momento.");
          return res.sendStatus(200);
        }

        setStep(user, "picking_staff", { service_id, service_name, stylists, stfOffset: 0 });

        const rows = buildStylistRows(stylists, 0);
        await sendList(user, {
          header: "Elegí peluquero",
          body: "Disponibles:",
          buttonText: "Ver peluqueros",
          rows
        });
        return res.sendStatus(200);
      }

      // ====== PELUQUEROS: elección o "Ver más…" ======
      if (session.step === "picking_staff" && (id.startsWith("stf_") || id === "stf_page_next")) {
        if (id === "stf_page_next") {
          const newOffset = (session.data.stfOffset || 0) + 9;
          setStep(user, "picking_staff", { stfOffset: newOffset });
          const rows = buildStylistRows(session.data.stylists, newOffset);
          await sendList(user, {
            header: "Elegí peluquero",
            body: "Disponibles:",
            buttonText: "Ver peluqueros",
            rows
          });
          return res.sendStatus(200);
        }

        const stylist_id = Number(id.slice(4));
        // Nombre del peluquero guardado
        const st = (session.data.stylists || []).find(x => x.id === stylist_id);
        const stylist_name = st?.name || `Peluquero ${stylist_id}`;

        setStep(user, "picking_day", { stylist_id, stylist_name });
        await sendWhatsAppText(user, "Decime la fecha: *hoy*, *mañana* o *DD/MM*");
        return res.sendStatus(200);
      }

      // ====== HORARIOS: elección o "Ver más…" ======
      if (session.step === "picking_time" && (id.startsWith("slot_") || id === "slot_page_next")) {
        if (id === "slot_page_next") {
          const newOffset = (session.data.slotOffset || 0) + 9;
          setStep(user, "picking_time", { slotOffset: newOffset });
          const rows = buildSlotRows(session.data.slots, session.data.day, newOffset);
          await sendList(user, {
            header: `Horarios ${session.data.day}`,
            body: "Elegí un horario:",
            buttonText: "Ver horarios",
            rows
          });
          return res.sendStatus(200);
        }

        const [, day, hhmm] = id.split("_"); // slot_YYYY-MM-DD_HH:mm
        setStep(user, "confirming", { hhmm });

        // Mostrar nombres en la confirmación
        const svcName = session.data.service_name || `Servicio ${session.data.service_id}`;
        const stName = session.data.stylist_name || `Peluquero ${session.data.stylist_id}`;

        await sendButtons(user, {
          header: "Confirmar turno",
          body: `Servicio: *${svcName}*\nPeluquero: *${stName}*\nDía/Hora: *${day} ${hhmm}*`,
          buttons: [
            { id: "confirm_yes", title: "Confirmar" },
            { id: "confirm_change", title: "Cambiar" }
          ]
        });
        return res.sendStatus(200);
      }

      // ====== CONFIRMACIÓN ======
      if (session.step === "confirming") {
        if (id === "confirm_change") {
          setStep(user, "picking_day");
          await sendWhatsAppText(user, "Ok, decime otra fecha.");
          return res.sendStatus(200);
        }
        if (id === "confirm_yes") {
          try {
            const iso = `${session.data.day}T${session.data.hhmm}:00-03:00`; // ajustar TZ si querés
            await _book(user, session.data.stylist_id, session.data.service_id, iso);
            reset(user);
            await sendWhatsAppText(user, "¡Listo! Turno reservado ✅");
          } catch (e) {
            const m = String(e?.message || "");
            if (m.includes("MAX_ACTIVE_APPOINTMENTS_REACHED")) {
              await sendWhatsAppText(
                user,
                "Tenés *2 turnos activos* ya reservados. Para sacar otro, primero *cancelá* uno de los existentes."
              );
            } else if (m.includes("SLOT")) {
              await sendWhatsAppText(user, "Uff, ese horario se acaba de ocupar. Probemos otro.");
            } else {
              await sendWhatsAppText(user, "No pude guardar el turno. Probá de nuevo.");
            }
          }
          return res.sendStatus(200);
        }
      }

      return res.sendStatus(200);
    }


    // otros tipos
    await sendWhatsAppText(user, "Mandame texto o usá las opciones 😉");
    return res.sendStatus(200);
  } catch (e) {
    console.error("[WA webhook] error:", e);
    return res.sendStatus(200);
  }
});


/* === adaptadores a tus rutas/servicios ya existentes ===
   Si tus funciones están exportadas distinto, ajustá acá
*/
async function _listServices() {
  // devuelve [{id,name,duration_min}]
  const { data } = await listServices._handler?.() ?? {};
  return data || await listServices(); // según cómo lo tengas exportado
}
async function _listStylists() {
  const { data } = await listStylists._handler?.() ?? {};
  return data || await listStylists();
}
async function _getSlots(stylistId, serviceId, date) {
  // espera {query: {stylistId, serviceId, date}}
  if (getFreeSlots._handler) {
    const resp = await getFreeSlots._handler({ query: { stylistId, serviceId, date } });
    return resp?.data?.slots?.map(s => s.slice(11, 16)) || []; // "YYYY-MM-DDTHH:mm..."
  }
  // o si exportaste helper puro:
  return await getFreeSlots({ stylistId, serviceId, date });
}
async function _book(customerPhoneE164, stylistId, serviceId, startsAtISO) {
  if (createAppointment._handler) {
    return createAppointment._handler({
      body: {
        customerPhone: customerPhoneE164,
        stylistId, serviceId,
        startsAt: startsAtISO
      }
    });
  }
  return createAppointment({
    customerPhone: customerPhoneE164,
    stylistId, serviceId,
    startsAt: startsAtISO
  });
}
