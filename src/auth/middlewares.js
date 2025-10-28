// src/auth/middlewares.js
import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok:false, error:"Falta token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = { id: payload.sub, role: payload.role, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ ok:false, error:"Token inválido o expirado" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok:false, error:"No auth" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ ok:false, error:"Sin permisos" });
    next();
  };
}
