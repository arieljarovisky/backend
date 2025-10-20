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
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", customers);
app.use("/api", health);
app.use("/api", meta);
app.use("/api", appointments);
app.use("/api", availability);
app.use("/", waTest);
app.use("/", whatsapp);
app.use(waTemplates);

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API ready on http://localhost:${port}`));


