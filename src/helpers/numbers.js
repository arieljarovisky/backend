// helpers/numbers.js
export function toSandboxAllowed(e164) {
  // e164: "+54911XXXXXXXX" o "54911XXXXXXXX"
  const n = String(e164).replace(/\D/g, "");
  // Si empieza con 549 (Argentina móvil), quitamos el '9' después de 54
  if (n.startsWith("549")) return "54" + n.slice(3);
  return n; // otros países o ya sin 9
}
