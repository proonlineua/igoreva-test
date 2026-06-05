const { verify } = require('../lib/jwt');
const { query } = require('../lib/db');

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ error: 'Необходима авторизация' });

    const decoded = verify(token);

    const { rows } = await query(
      `SELECT u.id, u.email, u.name,
              p.salon_name, p.has_access, p.is_admin, p.onboarding,
              p.access_expires_at
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });

    const u = rows[0];
    // Access is valid only if has_access=true AND not expired (null = no expiry set yet)
    const accessValid = u.has_access &&
      (!u.access_expires_at || new Date(u.access_expires_at) > new Date());

    req.user = { ...u, has_access: accessValid };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
    }
    return res.status(401).json({ error: 'Ошибка авторизации' });
  }
}

async function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'Доступ запрещён' });
    next();
  });
}

module.exports = { requireAuth, requireAdmin };
