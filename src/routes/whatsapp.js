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
import { addHours } from "date-fns";
import { pool } from "../db.js";
import { createDepositPaymentLink } from "../payments.js";

export const whatsapp = Router();

const TZ_OFFSET = -3; // Argentina UTC-3
const LEAD_MIN = Number(process.env.BOT_LEAD_MIN || 30); // minutos de anticipación mínima

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

  const validSlots = slots.filter((h) => {
    // Convierte el horario local a UTC para comparar correctamente
    const slotLocal = new Date(`${day}T${h}:00`);
    const slotUtc = addHours(slotLocal, -TZ_OFFSET); // ajusta por zona horaria
    const diffMin = (slotUtc.getTime() - now.getTime()) / 60000;
    return diffMin >= LEAD_MIN; // descarta turnos pasados o con poca anticipación
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

            // Validaciones (ya las tenés)
            try {
              validateAppointmentDate(fullDateTime);
            } catch (validationError) {
              await sendWhatsAppText(user, `⚠️ ${validationError.message}\n\nEscribí *hola* para empezar de nuevo.`);
              reset(user);
              return res.sendStatus(200);
            }
            if (isPastDateTime(fullDateTime)) {
              await sendWhatsAppText(user, "⚠️ Ese horario ya pasó.\n\nEscribí *hola* para empezar de nuevo.");
              reset(user);
              return res.sendStatus(200);
            }

            // 1) Traer precio del servicio para calcular seña (50%)
            const [[svc]] = await pool.query(
              "SELECT name, price_decimal FROM service WHERE id=? LIMIT 1",
              [session.data.service_id]
            );
            const serviceName = svc?.name || "Servicio";
            const servicePrice = Number(svc?.price_decimal || 0);
            const deposit = Math.max(0, Number((servicePrice / 2).toFixed(2)));
            console.log({
              user,
              stylistId: session.data.stylist_id,
              serviceId: session.data.service_id,
              startsAt: fullDateTime,
              deposit
            });
            // 2) Crear el turno con la seña en 0 o con el 50% (recomendado guardar el 50%)
            console.log("[WA] creando turno con seña...");
            const bookResp = await _bookWithDeposit(user, session.data.stylist_id, session.data.service_id, fullDateTime, deposit);

            console.log("[WA] turno creado:", bookResp);

            // 3) Generar link de pago (Mercado Pago o fallback)
            let payLink = "";
            try {
              payLink = await promiseWithTimeout(
                createDepositPaymentLink({
                  amount: deposit,
                  title: `Seña ${serviceName}`,
                  externalReference: String(bookResp?.id || ""),
                  // sin success/failure: usa wa.me
                  notificationUrl: process.env.WH_URL_MP_WEBHOOK,
                  payer: { name: "", email: "", phone: user }
                }),
                8000 // 8 segundos máx
              );
              console.log("[WA] link de pago listo:", payLink);
            } catch (payErr) {
              console.warn("[PAY] No se pudo generar link de pago:", payErr?.message);
            }

            reset(user);

            // 4) Mensaje de confirmación + link
            const d = new Date(fullDateTime.replace(" ", "T"));
            const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
            const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
            const cuerpo =
              `¡Turno reservado! ✅\n` +
              `Servicio: *${serviceName}* ($${servicePrice.toFixed(2)})\n` +
              `Seña (50%): *$${deposit.toFixed(2)}*\n` +
              `Fecha: *${fecha} ${hora}*\n\n` +
              (payLink
                ? `🔗 Pagá la seña acá:\n${payLink}\n\n` +
                `Tu turno queda confirmado. ¡Gracias!`
                : `No pude generar el link de pago ahora. Te enviamos uno a la brevedad.`);

            await sendWhatsAppText(user, cuerpo);
          } catch (e) {
            const m = String(e?.message || "").toLowerCase();
            if (m.includes("duración del servicio")) {
              await sendWhatsAppText(user, "⚠️ Falta configurar la *duración* del servicio. Avisanos y lo corregimos enseguida.");
            } else if (m.includes("horarios definidos")) {
              await sendWhatsAppText(user, "⚠️ Ese peluquero no tiene *horarios cargados* ese día. Probá otro horario o peluquero.");
            } else if (m.includes("fuera del horario laboral")) {
              await sendWhatsAppText(user, "⚠️ Ese horario está *fuera del horario laboral*. Elegí otro.");
            } else if (m.includes("overlap")) {
              await sendWhatsAppText(user, "Uff, ese horario se acaba de ocupar 😕 Elegí otro.");
            } else if (m.includes("pasado")) {
              await sendWhatsAppText(user, "⚠️ No podés agendar turnos en el pasado.\n\nEscribí *hola* para empezar de nuevo.");
            } else {
              await sendWhatsAppText(user, "No pude guardar el turno.\n\nProbá de nuevo escribiendo *hola*.");
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
    console.error("[WA confirm_yes] error:", e?.message, e); // 👈 agrega esto
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
  // fuerza números por las dudas
  const res = await getFreeSlots({
    stylistId: Number(stylistId),
    serviceId: Number(serviceId),
    date
  });

  // normalizamos todas las formas posibles de respuesta
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.slots)) return res.slots;
  if (Array.isArray(res?.data?.slots)) return res.data.slots;

  // debug opcional
  console.log("[BOT] getFreeSlots() respuesta inesperada:", res);
  return [];
}

async function _book(customerPhoneE164, stylistId, serviceId, startsAtLocal) {
  return createAppointment({
    customerPhone: customerPhoneE164,
    stylistId,
    serviceId,
    startsAt: startsAtLocal, // "YYYY-MM-DD HH:MM:SS"
  });
}

async function _bookWithDeposit(customerPhoneE164, stylistId, serviceId, startsAtLocal, depositDecimal) {
  return createAppointment({
    customerPhone: customerPhoneE164,
    stylistId,
    serviceId,
    startsAt: startsAtLocal,
    depositDecimal: Number(depositDecimal || 0),
    status: "pending_deposit",         // 👈 clave
    markDepositAsPaid: false
  });
}

function promiseWithTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}