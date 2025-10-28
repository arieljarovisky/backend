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
import { auth } from "./routes/auth.js"; // 🆕 rutas JWT login/register/refresh
import { requireAuth, requireRole } from "./auth/middlewares.js"; // 🧱 seguridad

dotenv.config();
const app = express();

// ────── Middlewares globales ──────

const ALLOWED_ORIGINS = [
    process.env.CORS_ORIGIN,          
    "http://localhost:5173",
].filter(Boolean);

app.use(cors({
    origin(origin, cb) {
        // permitir herramientas sin Origin (curl, Postman) y los orígenes listados
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());
app.use(cookieParser());


// ────── API públicas ──────
// ⚠️ NO requieren token JWT
app.use("/api/mp-webhook", mpWebhook);
app.use("/auth", auth);
app.use("/api/health", health);
app.use("/api/meta", meta);
app.use("/api", availability);
app.use("/", whatsapp);
app.use("/api/whatsapp", whatsapp);

// ────── API protegidas (JWT requerido) ──────
// A partir de acá TODO requiere login válido
app.use("/api/appointments", requireAuth, appointments);
app.use("/api/calendar", requireAuth, calendar);
app.use("/api/customers", requireAuth, requireRole("admin", "staff"), customers);
app.use("/api/payments", requireAuth, requireRole("admin", "staff"), payments);

// ────── API Admin ──────
app.use(
    "/api/admin",
    requireAuth,
    requireRole("admin", "staff"),
    adminDashboard
); // KPIs
app.use(
    "/api/admin/customers",
    requireAuth,
    requireRole("admin", "staff"),
    customersAdmin
);
app.use("/api/admin", requireAuth, requireRole("admin", "staff"), adminRouter);

const port = process.env.PORT || 4000;
app.listen(port, () =>
    console.log(`✅ API segura lista en http://localhost:${port}`)
);
