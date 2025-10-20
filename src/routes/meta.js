// src/routes/meta.js
import { Router } from "express";
import { pool } from "../db.js";

export const meta = Router();

/** Lista de servicios activos */
export async function listServices() {
  const [rows] = await pool.query(
    `SELECT id, name, duration_min, price_decimal, is_active
       FROM service
      WHERE is_active = 1
      ORDER BY name ASC`
  );
  return rows;
}

/** Lista de peluqueros activos */
export async function listStylists() {
  const [rows] = await pool.query(
    `SELECT id, name, color_hex, is_active
       FROM stylist
      WHERE is_active = 1
      ORDER BY name ASC`
  );
  return rows;
}

/** GET /api/services */
meta.get("/services", async (_req, res) => {
  try {
    const data = await listServices();
    res.json({ ok: true, data });
  } catch (e) {
    console.error("[GET /api/services] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/stylists */
meta.get("/stylists", async (_req, res) => {
  try {
    const data = await listStylists();
    res.json({ ok: true, data });
  } catch (e) {
    console.error("[GET /api/stylists] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
