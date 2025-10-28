// src/auth/tokens.js
import jwt from "jsonwebtoken";
import crypto from "crypto";

const sign = (payload, secret, expiresIn) =>
  jwt.sign(payload, secret, { expiresIn });

export function signAccessToken(user) {
  // info mínima
  return sign(
    { sub: user.id, role: user.role, email: user.email },
    process.env.JWT_ACCESS_SECRET,
    process.env.JWT_ACCESS_EXPIRES || "15m"
  );
}

export function signRefreshToken(user, jti) {
  return sign(
    { sub: user.id, jti },
    process.env.JWT_REFRESH_SECRET,
    process.env.JWT_REFRESH_EXPIRES || "30d"
  );
}

export function generateTokenId() {
  return crypto.randomBytes(32).toString("hex"); // para almacenar en DB (no el JWT)
}
