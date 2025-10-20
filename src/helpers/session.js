// src/helpers/session.js
const sessions = new Map(); // en prod: Redis

export function getSession(userId) {
  let s = sessions.get(userId);
  if (!s) {
    s = { step: "idle", data: {} };
    sessions.set(userId, s);
  }
  return s;
}
export function setStep(userId, step, patch = {}) {
  const s = getSession(userId);
  s.step = step;
  s.data = { ...s.data, ...patch };
}
export function reset(userId) {
  sessions.delete(userId);
}
