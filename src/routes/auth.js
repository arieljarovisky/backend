// src/routes/auth.js
import { Router } from "express";
import { body, validationResult } from "express-validator";
import { pool } from "../db.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { signAccessToken, signRefreshToken, generateTokenId } from "../auth/tokens.js";
import cookieParser from "cookie-parser";
import { requireAuth } from "../auth/middlewares.js";
import jwt from "jsonwebtoken";

export const auth = Router();

// Si no lo tenés ya en app.js/server.js
auth.use(cookieParser());

// (Opcional) Registro — restringilo a admin en producción
auth.post(
    "/register",
    body("email").isEmail(),
    body("password").isLength({ min: 6 }),
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

        const { email, password, full_name, role = "user" } = req.body;

        const [[dup]] = await pool.query("SELECT id FROM users WHERE email=?", [email]);
        if (dup) return res.status(409).json({ ok: false, error: "Email en uso" });

        const password_hash = await hashPassword(password);
        const [result] = await pool.query(
            "INSERT INTO users (email, password_hash, full_name, role) VALUES (?,?,?,?)",
            [email, password_hash, full_name || null, role]
        );
        return res.json({ ok: true, id: result.insertId });
    }
);

// Login
auth.post(
    "/login",
    body("email").isEmail(),
    body("password").notEmpty(),
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");
        const [[user]] = await pool.query(
            "SELECT id, email, password_hash, role, is_active FROM users WHERE email=?",
            [email]
        );
        if (!user || !user.is_active) {
            console.warn("[LOGIN] user not found/inactive:", email);
            return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
        }

        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) {
            console.warn("[LOGIN] bad password:", email);
            return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
        }

        // generar tokens
        const jti = generateTokenId();
        const accessToken = signAccessToken(user);
        const refreshToken = signRefreshToken(user, jti);

        // guardamos el jti (hash) en DB para poder revocar/rotar
        const expiresAt = new Date(Date.now() + parseExpiryMs(process.env.JWT_REFRESH_EXPIRES || "30d"));
        await pool.query(
            "INSERT INTO refresh_tokens (user_id, token, expires_at, ip, user_agent) VALUES (?,?,?,?,?)",
            [user.id, jti, expiresAt, req.ip, req.headers['user-agent'] || null]
        );
        const COOKIE_SECURE = true;         // ngrok es HTTPS
        const COOKIE_SAMESITE = "none";     // cross-site requiere None
        // cookie httpOnly con el refresh JWT
        res.cookie("rt", newRefresh, {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/auth",
            maxAge: expiresAt.getTime() - Date.now(),
        });

        // actualizar last_login
        await pool.query("UPDATE users SET last_login=NOW() WHERE id=?", [user.id]);

        return res.json({ ok: true, accessToken, user: { id: user.id, email: user.email, role: user.role } });
    }
);

// Refresh (rotación)
auth.post("/refresh", async (req, res) => {
    const token = req.cookies?.rt;
    if (!token) return res.status(401).json({ ok: false, error: "Sin refresh" });

    try {
        const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
        const jti = payload.jti;
        const userId = payload.sub;

        const [[row]] = await pool.query(
            "SELECT id, revoked, expires_at FROM refresh_tokens WHERE token=? AND user_id=?",
            [jti, userId]
        );
        if (!row || row.revoked || new Date(row.expires_at) < new Date()) {
            return res.status(401).json({ ok: false, error: "Refresh inválido" });
        }

        // rotamos: marcamos revocado el viejo y emitimos uno nuevo
        await pool.query("UPDATE refresh_tokens SET revoked=1 WHERE id=?", [row.id]);

        const [[user]] = await pool.query(
            "SELECT id, email, role FROM users WHERE id=? AND is_active=1",
            [userId]
        );
        if (!user) return res.status(401).json({ ok: false, error: "Usuario no válido" });

        const newJti = generateTokenId();
        const newAccess = signAccessToken(user);
        const newRefresh = signRefreshToken(user, newJti);
        const expiresAt = new Date(Date.now() + parseExpiryMs(process.env.JWT_REFRESH_EXPIRES || "30d"));

        await pool.query(
            "INSERT INTO refresh_tokens (user_id, token, expires_at, ip, user_agent) VALUES (?,?,?,?,?)",
            [user.id, newJti, expiresAt, req.ip, req.headers['user-agent'] || null]
        );

        res.cookie("rt", newRefresh, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            path: "/auth",
            maxAge: expiresAt.getTime() - Date.now()
        });

        return res.json({ ok: true, accessToken: newAccess });
    } catch {
        return res.status(401).json({ ok: false, error: "Refresh inválido/expirado" });
    }
});

// Logout (revoca refresh actual)
auth.post("/logout", async (req, res) => {
    const token = req.cookies?.rt;
    if (token) {
        try {
            const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
            await pool.query("UPDATE refresh_tokens SET revoked=1 WHERE token=?", [payload.jti]);
        } catch { }
    }
    res.clearCookie("rt", { path: "/auth" });
    return res.json({ ok: true });
});

// Perfil (protegido)
auth.get("/me", requireAuth, async (req, res) => {
    const [[user]] = await pool.query(
        "SELECT id, email, full_name, role, last_login FROM users WHERE id=?",
        [req.user.id]
    );
    res.json({ ok: true, user });
});

// util: parsear "30d", "15m"
function parseExpiryMs(str) {
    const m = /^(\d+)([smhd])$/.exec(str);
    const n = Number(m?.[1] || 0);
    const unit = m?.[2] || "d";
    const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return n * mult;
}
