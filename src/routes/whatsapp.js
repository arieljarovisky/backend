// src/routes/whatsapp.js
import { Router } from "express";
import { sendWhatsAppText } from "../whatsapp.js";
import { toSandboxAllowed } from "../helpers/numbers.js";
import { getSession, setStep, reset } from "../helpers/session.js";
import { sendList, sendButtons } from "../whatsapp-ui.js";
import { listServices, listStylists } from "../routes/meta.js";
import { getFreeSlots } from "../routes/availability.js";
import { createAppointment } from "../routes/appointments.js";
import { parseDay } from "../helpers/parseDay.js";
import { listUpcomingAppointmentsByPhone } from "../routes/appointments.js";
import { getCustomerByPhone, upsertCustomerNameByPhone } from "../routes/customers.js";
import { validateAppointmentDate, isPastDateTime } from "../helpers/dateValidation.js";

export const whatsapp = Router();

// ==== Helpers de paginación (servicios / estilistas / horarios) ====
function formatMyAppointments(list) {
  if (!list?.length) return "No tenés turnos próximos.";
  const lines = list.map((a) => {
    const d = new Date(a.starts_at);
    const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
    const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    return `• ${fecha} ${hora} — ${a.service_name} con ${a.stylist_name}`;
  });
  return `Estos son tus próximos turnos:\n${lines.join("\n")}`;
}

function buildServiceRows(services, offset = 0) {
  const page = services.slice(offset, offset + 9).map((s) => ({
    id: `svc_${s.id}`,
    title: s.name,
    description: `${s.duration_min} min`,
  }));
  if (offset + 9 < services.length) {
    page.push({ id: "svc_page_next", title: "Ver más…", description: "Más servicios" });
  }
  return page;
}

function buildStylistRows(stylists, offset = 0) {
  const page = stylists.slice(offset, offset + 9).map((st) => ({
    id: `stf_${st.id}`,
    title: st.name,
  }));
  if (offset + 9 < stylists.length) {
    page.push({ id: "stf_page_next", title: "Ver más…", description: "Más peluqueros" });
  }
  return page;
}

function buildSlotRows(slots, day, offset = 0) {
  const now = new Date();

  // ✅ Filtrar slots pasados
  const validSlots = slots.filter((h) => {
    const slotTime = new Date(`${day}T${h}:00`);
    return slotTime > now;
  });

  const page = validSlots.slice(offset, offset + 9).map((h) => ({
    id: `slot_${day}_${h}`,
    title: h,
  }));

  if (offset + 9 < validSlots.length) {
    page.push({ id: "slot_page_next", title: "Ver más…", description: "Más horarios" });
  }

  return page;
}

function extractNameFromText(txt) {
  let t = (txt || "").trim();
  t = t
    .replace(/^soy\s+/i, "")
    .replace(/^me llamo\s+/i, "")
    .replace(/^mi nombre es\s+/i, "");

  return t
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 80);
}

// ============================================
// GET verify
// ============================================
whatsapp.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ============================================
// POST inbound
// ============================================
whatsapp.post("/webhooks/whatsapp", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    // ✅ Normalizar número (solo en desarrollo/sandbox si es necesario)
    const user = process.env.NODE_ENV === "development"
      ? toSandboxAllowed(msg.from)
      : msg.from;

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
            { id: "action_new", title: "Reservar nuevo" },
          ],
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
            { id: "action_new", title: "Reservar nuevo" },
          ],
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

        // ✅ Validar que no sea fecha pasada
        const selectedDate = new Date(day + "T00:00:00");
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (selectedDate < today) {
          await sendWhatsAppText(
            user,
            "⚠️ No podés reservar turnos para fechas pasadas.\n\n" +
            "Decime *hoy*, *mañana* o una fecha futura (ej: 25/12)"
          );
          return res.sendStatus(200);
        }

        // ✅ Validar que esté dentro del rango (ej: máx 90 días)
        const maxDate = new Date(today);
        maxDate.setDate(maxDate.getDate() + 90);

        if (selectedDate > maxDate) {
          await sendWhatsAppText(
            user,
            "⚠️ Solo podés reservar turnos hasta dentro de 90 días.\n\n" +
            "Elegí una fecha más cercana."
          );
          return res.sendStatus(200);
        }

        // ✅ Validar día hábil (opcional - ajustá según tu negocio)
        const dayOfWeek = selectedDate.getDay();
        if (dayOfWeek === 0) {
          // 0 = Domingo
          await sendWhatsAppText(
            user,
            "⚠️ No trabajamos los domingos.\n\n" +
            "Elegí otro día de la semana."
          );
          return res.sendStatus(200);
        }

        // Traer horarios libres
        const slots = await _getSlots(session.data.stylist_id, session.data.service_id, day);

        if (!slots.length) {
          await sendWhatsAppText(
            user,
            "No hay horarios libres ese día 😕\n\n" +
            "Probá con otra fecha."
          );
          return res.sendStatus(200);
        }

        // Guardar y mostrar lista (con paginación)
        setStep(user, "picking_time", { day, slots, slotOffset: 0 });

        const rows = buildSlotRows(slots, day, 0);
        await sendList(user, {
          header: `Horarios ${day}`,
          body: "Elegí un horario:",
          buttonText: "Ver horarios",
          rows,
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
          const text = formatMyAppointments(myApts);
          await sendWhatsAppText(user, text);

          // Ofrecé reservar después de mostrar los turnos
          await sendButtons(user, {
            header: "¿Algo más?",
            body: "Podés reservar un nuevo turno cuando quieras.",
            buttons: [{ id: "action_new", title: "Reservar nuevo" }],
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
            rows,
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
            rows,
          });
          return res.sendStatus(200);
        }

        const service_id = Number(id.slice(4));
        const svc = (session.data.services || []).find((s) => s.id === service_id);
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
          rows,
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
            rows,
          });
          return res.sendStatus(200);
        }

        const stylist_id = Number(id.slice(4));
        const st = (session.data.stylists || []).find((x) => x.id === stylist_id);
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
            rows,
          });
          return res.sendStatus(200);
        }

        const [, day, hhmm] = id.split("_"); // slot_YYYY-MM-DD_HH:mm

        // ✅ Validar que el horario no haya pasado mientras el usuario elegía
        const slotDateTime = `${day} ${hhmm}:00`;
        if (isPastDateTime(slotDateTime)) {
          await sendWhatsAppText(
            user,
            "⚠️ Ups, ese horario ya pasó mientras elegías.\n\n" +
            "Elegí otro horario o escribí *hola* para empezar de nuevo."
          );
          return res.sendStatus(200);
        }

        setStep(user, "confirming", { hhmm });

        const svcName = session.data.service_name || `Servicio ${session.data.service_id}`;
        const stName = session.data.stylist_name || `Peluquero ${session.data.stylist_id}`;

        await sendButtons(user, {
          header: "Confirmar turno",
          body: `Servicio: *${svcName}*\nPeluquero: *${stName}*\nDía/Hora: *${day} ${hhmm}*`,
          buttons: [
            { id: "confirm_yes", title: "Confirmar" },
            { id: "confirm_change", title: "Cambiar" },
          ],
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
            const fullDateTime = `${session.data.day} ${session.data.hhmm}:00`;

            // ✅ Validación completa antes de crear el turno
            try {
              validateAppointmentDate(fullDateTime);
            } catch (validationError) {
              await sendWhatsAppText(
                user,
                `⚠️ ${validationError.message}\n\n` +
                "Escribí *hola* para empezar de nuevo."
              );
              reset(user);
              return res.sendStatus(200);
            }

            // ✅ Doble check que no sea pasado (por si acaso)
            if (isPastDateTime(fullDateTime)) {
              await sendWhatsAppText(
                user,
                "⚠️ Ese horario ya pasó mientras elegías.\n\n" +
                "Escribí *hola* para empezar de nuevo."
              );
              reset(user);
              return res.sendStatus(200);
            }

            await _book(user, session.data.stylist_id, session.data.service_id, fullDateTime);
            reset(user);
            await sendWhatsAppText(user, "¡Listo! Turno reservado ✅");
          } catch (e) {
            const m = String(e?.message || "");
            if (m.includes("pasado")) {
              await sendWhatsAppText(
                user,
                "⚠️ No podés agendar turnos en el pasado.\n\n" +
                "Escribí *hola* para empezar de nuevo."
              );
            } else if (m.includes("MAX_ACTIVE_APPOINTMENTS")) {
              await sendWhatsAppText(
                user,
                "Tenés *2 turnos activos* ya reservados.\n\n" +
                "Para sacar otro, primero *cancelá* uno de los existentes."
              );
            } else if (m.includes("SLOT")) {
              await sendWhatsAppText(
                user,
                "Uff, ese horario se acaba de ocupar 😕\n\n" +
                "Escribí *hola* para elegir otro."
              );
            } else {
              await sendWhatsAppText(
                user,
                "No pude guardar el turno.\n\n" +
                "Probá de nuevo escribiendo *hola*."
              );
            }
            reset(user);
          }
          return res.sendStatus(200);
        }
      }

      return res.sendStatus(200);
    }

    // Otros tipos de mensaje
    await sendWhatsAppText(user, "Mandame texto o usá las opciones 😉");
    return res.sendStatus(200);
  } catch (e) {
    console.error("[WA webhook] error:", e);
    return res.sendStatus(200);
  }
});

// ============================================
// Adaptadores a servicios existentes
// ============================================
async function _listServices() {
  const data = await listServices();
  return Array.isArray(data) ? data : data?.data || [];
}

async function _listStylists() {
  const data = await listStylists();
  return Array.isArray(data) ? data : data?.data || [];
}

async function _getSlots(stylistId, serviceId, date) {
  const slots = await getFreeSlots({ stylistId, serviceId, date });
  return Array.isArray(slots) ? slots : slots?.data?.slots || [];
}

async function _book(customerPhoneE164, stylistId, serviceId, startsAtLocal) {
  return createAppointment({
    customerPhone: customerPhoneE164,
    stylistId,
    serviceId,
    startsAt: startsAtLocal, // "YYYY-MM-DD HH:MM:SS"
  });
}