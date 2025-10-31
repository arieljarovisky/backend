// src/routes/customers.js
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";
export const customers = Router();
customers.use(requireAuth, requireRole("admin", "user"));
/** Trae un cliente por teléfono (solo dígitos) */
export async function getCustomerByPhone(phone_e164) {
  const phone = String(phone_e164 || "").replace(/\D/g, "");
  const [rows] = await pool.query(
    `SELECT id, name, phone_e164 FROM customer WHERE phone_e164 = ?`,
    [phone]
  );
  return rows[0] || null;
}

/** Crea si no existe y/o actualiza el nombre */
export async function upsertCustomerNameByPhone(phone_e164, name) {
  const phone = String(phone_e164 || "").replace(/\D/g, "");
  const cleanName = (name || "").trim().slice(0, 80);
  await pool.query(
    `INSERT INTO customer (name, phone_e164) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)`,
    [cleanName || null, phone]
  );
  return getCustomerByPhone(phone);
}

/* Opcional: endpoint REST para panel/admin */
customers.put("/customers/:phone/name", async (req, res) => {
  try {
    const phone = req.params.phone;
    const { name } = req.body || {};
    const c = await upsertCustomerNameByPhone(phone, name);
    res.json({ ok: true, data: c });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
