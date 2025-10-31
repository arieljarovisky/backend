import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

import { health } from "./routes/health.js";
import { meta } from "./routes/meta.js";
import { appointments } from "./routes/appointments.js";
import { availability } from "./routes/availability.js";
import { waTest } from "./routes/wa-test.js";
import { whatsapp } from "./routes/whatsapp.js";
import { waTemplates } from "./routes/waTemplates.js";
import { customers } from "./routes/customers.js";
import { adminDashboard } from "./routes/adminDashboard.js";
import { customersAdmin } from "./routes/customersAdmin.js";
import { admin as adminRouter } from "./routes/admin.js";
import { mpWebhook } from "./routes/mpWebhook.js";
import { calendar } from "./routes/calendar.js";
import { payments } from "./routes/payments.js";
import { auth } from "./routes/auth.js";
import { config } from "./routes/config.js";
import { stylistCommission } from "./routes/stylistCommission.js";
import { stylistStats } from "./routes/stylistStats.js";
import { notifications } from "./routes/notifications.js";
import { workingHours } from "./routes/workingHours.js";
import depositsAdmin from "./routes/depositsAdmin.js"; // ✅ Importar depósitos

import { requireAuth, requireRole } from "./auth/middlewares.js";
import { daysOff } from "./routes/daysOff.js";

dotenv.config();
const app = express();

// ────── Middlewares globales ──────

const ALLOWED_ORIGINS = [
    process.env.CORS_ORIGIN,
    "http://localhost:5173",
].filter(Boolean);

app.use(cors({
    origin(origin, cb) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.set("trust proxy", 1); // necesario en Render para que secure funcione
app.use(express.json());
app.use(cookieParser());


// ────── API públicas ──────
app.use("/api/mp-webhook", mpWebhook);
app.use("/auth", auth);
app.use("/api/health", health);
app.use("/api", meta);  // Sirve /services y /stylists
app.use("/api", availability);  // Sirve /availability
app.use("/", whatsapp);
app.use("/api/whatsapp", whatsapp);

// ────── API protegidas (JWT requerido) ──────
app.use("/api/appointments", requireAuth, appointments);
app.use("/api/calendar", requireAuth, calendar);
app.use("/api/customers", requireAuth, requireRole("admin", "user"), customers);
app.use("/api/payments", requireAuth, requireRole("admin", "user"), payments);
app.use("/api/config", config);
app.use("/api/commissions", stylistCommission);
app.use("/api/stats", stylistStats);
app.use("/api", requireAuth, notifications);
app.use("/api/working-hours", workingHours);
app.use("/api/days-off", daysOff); 


// ────── API Admin (ORDEN CORREGIDO) ──────
// ✅ IMPORTANTE: Rutas más específicas PRIMERO, genéricas después

// 1. Deposits admin (ruta específica) ✅ NUEVO
app.use(
    "/api/admin/deposits",
    requireAuth,
    requireRole("admin", "user"),
    depositsAdmin
);

// 2. Customers admin (ruta específica)
app.use(
    "/api/admin/customers",
    requireAuth,
    requireRole("admin", "user"),
    customersAdmin
);

// 3. Métricas, charts y agenda (adminRouter tiene /metrics, /charts/*, /agenda/*)
app.use(
    "/api/admin",
    requireAuth,
    requireRole("admin", "user"),
    adminRouter
);

// 4. Dashboard principal (adminDashboard tiene GET /)
app.use(
    "/api/admin",
    requireAuth,
    requireRole("admin", "user"),
    adminDashboard
);

const port = process.env.PORT || 4000;
app.listen(port, () =>
    console.log(`✅ API segura lista en http://localhost:${port}`)
);