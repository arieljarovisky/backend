import { Router } from "express";
import { sendWhatsAppTemplate } from "../whatsapp.js";

const router = Router();

router.post("/api/whatsapp/send-template", async (req, res) => {
  const { to, templateName, vars, lang } = req.body || {};
  if (!to || !templateName) {
    return res.status(400).json({ ok: false, error: "to y templateName son requeridos" });
  }
  try {
    await sendWhatsAppTemplate(to, templateName, Array.isArray(vars) ? vars : [], lang || "es");
    res.json({ ok: true });
  } catch (e) {
    console.error("WA error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export const waTemplates = router;   // 👈 export con nombre
