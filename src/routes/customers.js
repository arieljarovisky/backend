// src/routes/customers.js — MULTI-TENANT
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireRole } from "../auth/middlewares.js";

export const customers = Router();
customers.use(requireAuth, requireRole("admin", "user"));

/** Normaliza teléfono a solo dígitos */
function normPhone(p) {
  return String(p || "").replace(/\D/g, "");
}

/** Trae un cliente por teléfono dentro del tenant */
export async function getCustomerByPhone(phone_e164, tenantId) {
  const phone = normPhone(phone_e164);
  const [rows] = await pool.query(
    `SELECT id, name, phone_e164 
       FROM customer 
      WHERE tenant_id = ? AND phone_e164 = ? 
      LIMIT 1`,
    [tenantId, phone]
  );
  return rows[0] || null;
}

/** Crea si no existe y/o actualiza el nombre (scoped por tenant) */
export async function upsertCustomerNameByPhone(phone_e164, name, tenantId) {
  const phone = normPhone(phone_e164);
  const cleanName = (name || "").trim().slice(0, 80) || null;

  // Requiere UNIQUE (tenant_id, phone_e164)
  await pool.query(
    `INSERT INTO customer (tenant_id, name, phone_e164)
         VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE 
         name = COALESCE(VALUES(name), name)`,
    [tenantId, cleanName, phone]
  );

  return getCustomerByPhone(phone, tenantId);
}

/* ===== Endpoints ===== */

/** PUT /api/customers/:phone/name  Body: { name } */
customers.put("/customers/:phone/name", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const phone = req.params.phone;
    const { name } = req.body || {};
    if (!phone) return res.status(400).json({ ok:false, error:"Falta phone" });

    const c = await upsertCustomerNameByPhone(phone, name, tenantId);
    res.json({ ok: true, data: c });
  } catch (e) {
    console.error("[PUT /customers/:phone/name] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/customers/by-phone/:phone */
customers.get("/customers/by-phone/:phone", async (req, res) => {
  try {
    const tenantId = req.tenant.id;
    const phone = req.params.phone;
    const c = await getCustomerByPhone(phone, tenantId);
    if (!c) return res.status(404).json({ ok:false, error:"Cliente no encontrado" });
    res.json({ ok:true, data:c });
  } catch (e) {
    console.error("[GET /customers/by-phone/:phone] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});
