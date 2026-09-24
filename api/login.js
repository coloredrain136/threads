import { sign, safeEqual, send, body } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const pass = process.env.APP_PASSCODE;
  if (!pass) return send(res, 500, { error: 'APP_PASSCODE is not set. Add it in Vercel, then redeploy.' });
  const { passcode } = body(req);
  await new Promise((r) => setTimeout(r, 400)); // slows down guessing
  if (!passcode || !safeEqual(passcode, pass)) return send(res, 401, { error: 'Wrong passcode.' });
  try {
    send(res, 200, { token: sign({ kind: 'session', exp: Date.now() + 365 * 864e5 }) });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
}
