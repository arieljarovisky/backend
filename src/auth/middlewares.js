// src/auth/middlewares.js
import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  console.log("🔐 [requireAuth] Method:", req.method, "URL:", req.originalUrl);

  // permitir preflight OPTIONS
  if (req.method === "OPTIONS") {
    console.log("🟡 [requireAuth] OPTIONS request — skipping auth");
    return next();
  }

  const auth = req.headers.authorization || "";
  console.log("📦 [requireAuth] Headers Authorization:", auth || "(none)");

  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    console.log("❌ [requireAuth] Falta token");
    return res.status(401).json({ ok: false, error: "Falta token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    console.log("✅ [requireAuth] Token válido para:", payload.email, "Role:", payload.role);
    req.user = { id: payload.sub, role: payload.role, email: payload.email };
    next();
  } catch (err) {
    console.error("❌ [requireAuth] Token inválido o expirado:", err.message);
    return res.status(401).json({ ok: false, error: "Token inválido o expirado" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    console.log("🔎 [requireRole] URL:", req.originalUrl, "Roles permitidos:", roles, "User:", req.user?.role);
    if (!req.user) {
      console.log("❌ [requireRole] No hay usuario autenticado");
      return res.status(401).json({ ok: false, error: "No auth" });
    }
    if (!roles.includes(req.user.role)) {
      console.log("🚫 [requireRole] Rol no autorizado:", req.user.role);
      return res.status(403).json({ ok: false, error: "Sin permisos" });
    }
    console.log("✅ [requireRole] Acceso permitido");
    next();
  };
}

/** Requiere rol ADMIN */
export function requireAdmin(req, res, next) {
  console.log("🔎 [requireAdmin] Usuario:", req.user?.email, "Rol:", req.user?.role);
  if (!req.user || (req.user.role !== "admin" && req.user.role !== "ADMIN")) {
    console.log("🚫 [requireAdmin] Solo admin autorizado");
    return res.status(403).json({ ok: false, error: "Solo admin autorizado" });
  }
  console.log("✅ [requireAdmin] Admin autorizado");
  next();
}
