import express from "express";
import cors from "cors";
import dotenv from "dotenv";
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


dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ────── API públicas ──────
app.use("/api", customers);
app.use("/api", health);
app.use("/api", meta);
app.use("/api", availability);
app.use("/api/appointments", appointments);
app.use("/api/calendar", calendar);
app.use("/api/mp-webhook", mpWebhook);
app.use("/api/whatsapp", whatsapp);
app.use("/", waTest);
app.use("/", whatsapp);
app.use(waTemplates);

// ────── API Admin ──────
app.use("/api/admin", adminDashboard);   // ← Dashboard y KPIs
app.use("/api/admin/customers", customersAdmin);
app.use("/api/admin", adminRouter);
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API ready on http://localhost:${port}`));


