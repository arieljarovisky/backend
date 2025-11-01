// src/routes/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

export const auth = Router();

function signAccessToken({ userId, tenantId, role, email }) {
  return jwt.sign(
    { userId, tenantId, role, email },
    process.env.JWT_SECRET,
    { expiresIn: "15m" }
  );
}

function signRefreshToken({ userId, tenantId }) {
  return jwt.sign(
    { userId, tenantId, t: "refresh" },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

// Login
auth.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok:false, error:"Email y password requeridos" });
    }
    if (!req.tenant?.id) {
      return res.status(400).json({ ok:false, error:"Tenant no identificado" });
    }

    const [[user]] = await pool.query(
      "SELECT id, email, password_hash, role, is_active FROM users WHERE tenant_id=? AND email=? LIMIT 1",
      [req.tenant.id, email]
    );
    if (!user || !user.is_active) {
      return res.status(401).json({ ok:false, error:"Credenciales inválidas" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ ok:false, error:"Credenciales inválidas" });
    }

    const access = signAccessToken({
      userId: user.id,
      tenantId: req.tenant.id,
      role: user.role,
      email: user.email
    });
    const refresh = signRefreshToken({
      userId: user.id,
      tenantId: req.tenant.id
    });

    // persistir refresh
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token, created_at)
       VALUES (?,?,?,NOW())`,
      [user.id, req.tenant.id, refresh]
    );

    // cookie httpOnly (o devolver en body si preferís)
    res.cookie("rt", refresh, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30
    });

    return res.json({ ok:true, access });
  } catch (e) {
    console.error("[/auth/login] error:", e);
    return res.status(500).json({ ok:false, error:"Error de servidor" });
  }
});

// Refresh
auth.post("/refresh", async (req, res) => {
  try {
    const token = req.cookies?.rt || null;
    if (!token) return res.status(401).json({ ok:false, error:"Sin refresh" });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.t !== "refresh") throw new Error("Tipo token inválido");
    } catch {
      return res.status(401).json({ ok:false, error:"Refresh inválido" });
    }

    // validar existencia en DB y match con tenant actual
    const [[row]] = await pool.query(
      "SELECT user_id, tenant_id FROM refresh_tokens WHERE token=? LIMIT 1",
      [token]
    );
    if (!row) return res.status(401).json({ ok:false, error:"Refresh desconocido" });
    if (!req.tenant?.id || row.tenant_id !== req.tenant.id) {
      return res.status(403).json({ ok:false, error:"Tenant inválido para este token" });
    }

    // reemitir access
    const [[user]] = await pool.query(
      "SELECT id, email, role, is_active FROM users WHERE id=? AND tenant_id=? LIMIT 1",
      [row.user_id, row.tenant_id]
    );
    if (!user || !user.is_active) {
      return res.status(401).json({ ok:false, error:"Usuario inactivo" });
    }

    const access = jwt.sign(
      { userId: user.id, tenantId: row.tenant_id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    return res.json({ ok:true, access });
  } catch (e) {
    console.error("[/auth/refresh] error:", e);
    return res.status(500).json({ ok:false, error:"Error de servidor" });
  }
});

// Logout
auth.post("/logout", async (req, res) => {
  try {
    const token = req.cookies?.rt || null;
    if (token) {
      await pool.query("DELETE FROM refresh_tokens WHERE token=?", [token]);
    }
    res.clearCookie("rt");
    return res.json({ ok:true });
  } catch (e) {
    return res.json({ ok:true }); // fail-closed
  }
});
