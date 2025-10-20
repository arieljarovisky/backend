// src/routes/waTest.js
import { Router } from "express";
import { sendWhatsAppText as waSendText } from "../whatsapp.js";

export const waTest = Router();

waTest.post("/api/whatsapp/send-test", async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text)
    return res.status(400).json({ ok: false, error: "to y text requeridos" });
  try {
    await waSendText(to, text);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
