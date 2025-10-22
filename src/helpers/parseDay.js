// src/helpers/parseDay.js

export function parseDay(txt) {
  const t = (txt || "").trim().toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Hoy
  if (t === "hoy") return today.toISOString().slice(0, 10);

  // Mañana
  if (t === "mañana" || t === "manana") {
    const d = new Date(today.getTime() + 86400000);
    return d.toISOString().slice(0, 10);
  }

  // DD/MM
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return null;

  const [_, dd, MM] = m;
  const y = today.getFullYear();
  const month = String(MM).padStart(2, "0");
  const day = String(dd).padStart(2, "0");

  // ✅ Si el mes/día ya pasó este año, asumir año siguiente
  const parsed = new Date(`${y}-${month}-${day}T00:00:00`);
  if (parsed < today) {
    return `${y + 1}-${month}-${day}`;
  }

  return `${y}-${month}-${day}`;
}