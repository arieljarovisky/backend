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
import { cfgNumber } from "../services/config.js"; // ✅ NUEVO: lee el porcentaje desde la config


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

        setStep(user, "picking_user", { service_id, service_name, stylists, stfOffset: 0 });

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
      if (session.step === "picking_user" && (id.startsWith("stf_") || id === "stf_page_next")) {
        if (id === "stf_page_next") {
          const newOffset = (session.data.stfOffset || 0) + 9;
          setStep(user, "picking_user", { stfOffset: newOffset });
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
            const { day } = session.data;
            const hhmm = session.data.hhmm;

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
            // Re-chequeo JIT: ¿sigue libre?
            const freshSlots = await _getSlots(session.data.stylist_id, session.data.service_id, day);
            if (!freshSlots.includes(hhmm)) {
              setStep(user, "picking_time", { day, slots: freshSlots, slotOffset: 0 });
              const rows = buildSlotRows(freshSlots, day, 0);
              await sendWhatsAppText(user, "Uff, ese horario se acaba de ocupar 😕. Elegí otro de la lista actualizada.");
              await sendList(user, {
                header: `Horarios ${day}`,
                body: "Elegí un horario:",
                buttonText: "Ver horarios",
                rows,
              });
              return res.sendStatus(200);
            }
            // 1) Traer precio del servicio y porcentaje de seña configurado
            const [[svc]] = await pool.query(
              "SELECT name, price_decimal FROM service WHERE id=? LIMIT 1",
              [session.data.service_id]
            );
            const serviceName = svc?.name || "Servicio";
            const servicePrice = Number(svc?.price_decimal || 0);

            // ✅ porcentaje desde configuración (p.ej. 80)
            const pct = await cfgNumber("deposit.percentage", 50);
            const deposit = Math.max(0, Number((servicePrice * (pct / 100)).toFixed(2)));

            console.log({
              user,
              stylistId: session.data.stylist_id,
              serviceId: session.data.service_id,
              startsAt: fullDateTime,
              pct,
              deposit
            });

            // 2) Crear el turno con la seña calculada por config
            console.log("[WA] creando turno con seña...");
            const bookResp = await _bookWithDeposit(
              user,
              session.data.stylist_id,
              session.data.service_id,
              fullDateTime,
              deposit
            );

            console.log("[WA] turno creado:", bookResp);

            // 3) Generar link de pago con el MONTO calculado
            let payLink = "";
            try {
              payLink = await promiseWithTimeout(
                createDepositPaymentLink({
                  amount: deposit,                         // ✅ usa el monto calculado
                  title: `Seña ${serviceName}`,
                  externalReference: String(bookResp?.id || ""),
                  notificationUrl: process.env.WH_URL_MP_WEBHOOK,
                  payer: { name: "", email: "", phone: user }
                }),
                8000
              );
              console.log("[WA] link de pago listo:", payLink);
            } catch (payErr) {
              console.warn("[PAY] No se pudo generar link de pago:", payErr?.message);
            }

            reset(user);

            // 4) Mensaje de confirmación + link (sin hardcodear 50%)
            const d = new Date(fullDateTime.replace(" ", "T"));
            const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
            const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
            const cuerpo =
              `¡Turno reservado! ✅\n` +
              `Servicio: *${serviceName}* ($${servicePrice.toFixed(2)})\n` +
              `Seña (${pct}%): *$${deposit.toFixed(2)}*\n` +   // ✅ muestra el % real
              `Fecha: *${fecha} ${hora}*\n\n` +
              (payLink
                ? `🔗 Pagá la seña acá:\n${payLink}\n\n` +
                `Tu turno queda confirmado. ¡Gracias!`
                : `No pude generar el link de pago ahora. Te enviamos uno a la brevedad.`);

            await sendWhatsAppText(user, cuerpo);
          } catch (e) {
            const raw = String(e?.message || "");
            const m = raw.toLowerCase();
            if (m.includes("duración del servicio")) {
              await sendWhatsAppText(user, "⚠️ Falta configurar la *duración* del servicio. Avisanos y lo corregimos enseguida.");
            } else if (m.includes("horarios definidos")) {
              await sendWhatsAppText(user, "⚠️ Ese peluquero no tiene *horarios cargados* ese día. Probá otro horario o peluquero.");
            } else if (m.includes("fuera del horario laboral")) {
              await sendWhatsAppText(user, "⚠️ Ese horario está *fuera del horario laboral*. Elegí otro.");
            } else if (m.includes("overlap") || m.includes("ocupado") || m.includes("ya existe")) {
              await sendWhatsAppText(user, "Uff, ese horario se acaba de ocupar 😕 Elegí otro.");
              const fresh = await _getSlots(session.data.stylist_id, session.data.service_id, session.data.day);
              setStep(user, "picking_time", { day: session.data.day, slots: fresh, slotOffset: 0 });
              const rows = buildSlotRows(fresh, session.data.day, 0);
              await sendList(user, {
                header: `Horarios ${session.data.day}`,
                body: "Elegí un horario:",
                buttonText: "Ver horarios",
                rows,
              });
            } else if (m.includes("pasado")) {
              await sendWhatsAppText(user, "⚠️ No podés agendar turnos en el pasado.\n\nEscribí *hola* para empezar de nuevo.");
            } else {
              console.error("[WA] Error inesperado al guardar el turno:", raw);
              await sendWhatsAppText(user, "No pude guardar el turno por un error inesperado. Probá de nuevo o elegí otro horario.");
            }
            reset(user);
          }
          return res.sendStatus(200);
        }
      }
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

whatsapp.post("/reprogram", async (req, res) => {
  try {
    const { appointmentId, customText, autoCancel } = req.body || {};
    if (!appointmentId) {
      return res.status(400).json({ ok: false, error: "Falta appointmentId" });
    }

    const [[a]] = await pool.query(
      `SELECT a.id, a.starts_at, a.status,
              s.name AS service_name, st.name AS stylist_name,
              c.name AS customer_name, c.phone_e164
         FROM appointment a
         JOIN customer c ON c.id=a.customer_id
         JOIN service  s ON s.id=a.service_id
         JOIN stylist st ON st.id=a.stylist_id
        WHERE a.id=? LIMIT 1`,
      [appointmentId]
    );
    if (!a) return res.status(404).json({ ok: false, error: "Turno no encontrado" });
    if (!a.phone_e164) return res.status(400).json({ ok: false, error: "El cliente no tiene WhatsApp registrado" });

    const d = new Date(a.starts_at);
    const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
    const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

    const msg =
      customText ||
      `Hola ${a.customer_name || ""}! 💈\n` +
      `Desde la peluquería necesitamos *reprogramar tu turno* de:\n` +
      `• Servicio: *${a.service_name}*\n` +
      `• Peluquero: *${a.stylist_name}*\n` +
      `• Fecha: *${fecha} ${hora}*\n\n` +
      `Por favor, respondé este mensaje para coordinar una nueva fecha. ¡Gracias! 🙏`;

    await sendWhatsAppText(a.phone_e164, msg);

    // ✅ Cancela el turno viejo para liberar el hueco (y ocultarlo del calendario)
    if (autoCancel === true) {
      await pool.query(
        `UPDATE appointment
            SET status='cancelled'
          WHERE id=?`,
        [appointmentId]
      );
    }

    res.json({ ok: true, cancelled: autoCancel === true });
  } catch (e) {
    console.error("[/api/whatsapp/reprogram] error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
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
  // 1) Slots base (según tu availability/working_hours)
  const res = await getFreeSlots({
    stylistId: Number(stylistId),
    serviceId: Number(serviceId),
    date
  });
  let baseSlots = Array.isArray(res) ? res : (res?.slots ?? res?.data?.slots ?? []);
  baseSlots = baseSlots.map((s) => String(s).slice(0, 5)); // "HH:mm"

  // 2) Duración del servicio
  const [[svc]] = await pool.query(
    "SELECT duration_min FROM service WHERE id=? LIMIT 1",
    [Number(serviceId)]
  );
  const durMin = Number(svc?.duration_min || 0);
  if (!durMin) return [];

  // 3) Turnos ya reservados (busy por appointments)
  const [aptRows] = await pool.query(
    `
      SELECT TIME(starts_at) AS s, TIME(ends_at) AS e
      FROM appointment
      WHERE stylist_id=?
        AND DATE(starts_at)=?
        AND status IN ('scheduled','confirmed','deposit_paid','pending_deposit')
    `,
    [Number(stylistId), date]
  );
  const appts = aptRows.map((r) => ({
    start: new Date(`${date}T${String(r.s).slice(0, 5)}:00`),
    end:   new Date(`${date}T${String(r.e).slice(0, 5)}:00`),
  }));

  // 4) Bloqueos (busy por time_off) — contempla bloqueos que cruzan medianoche
  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd   = new Date(`${date}T23:59:59`);
  const [offRows] = await pool.query(
    `
      SELECT starts_at AS s, ends_at AS e
      FROM time_off
      WHERE stylist_id=?
        AND starts_at < DATE_ADD(?, INTERVAL 1 DAY)
        AND ends_at   > ?
    `,
    [Number(stylistId), date, date]
  );
  const offs = offRows.map((r) => {
    const s = new Date(r.s);
    const e = new Date(r.e);
    // Recortar al día consultado por si el bloqueo abarca varios días
    const start = s < dayStart ? dayStart : s;
    const end   = e > dayEnd   ? dayEnd   : e;
    return { start, end };
  });

  // 5) Helper de solapamiento
  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

  // 6) Filtrado final: quita slots que pisen turnos o bloqueos
  const free = [];
  for (const hhmm of baseSlots) {
    const start = new Date(`${date}T${hhmm}:00`);
    const end   = new Date(start.getTime() + durMin * 60000);

    const busyAppt = appts.some(({ start: s, end: e }) => overlaps(start, end, s, e));
    if (busyAppt) continue;

    const busyOff = offs.some(({ start: s, end: e }) => overlaps(start, end, s, e));
    if (busyOff) continue;

    free.push(hhmm);
  }

  return free;
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