/**
 * server.js — раздаёт статическую папку html/ (лендинг + веб-версия клиента).
 * Запуск: npm start   (локально http://localhost:3000)
 * На Render: Web Service (Node) либо Static Site — см. README.
 *
 * Админ-эндпоинтов нет. Если они появятся, подключайте их только через requireRole():
 */
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'html');

app.disable('x-powered-by');

// Заголовки безопасности. connect-src разрешает только loopback (API статистики ядра) и себя.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self' http://127.0.0.1:9090; media-src 'self'; frame-ancestors 'none'");
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(express.static(ROOT, { extensions: ['html'], maxAge: '1h' }));

/* ---- шаблон защиты будущих админ-маршрутов ----
function requireRole(role) {
  return (req, res, next) => {
    const user = req.user;                       // заполняется вашей аутентификацией
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (user.role !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
// app.use('/admin', requireRole('admin'), adminRouter);
*/

app.listen(PORT, () => console.log(`NeonGate web: http://localhost:${PORT}`));
