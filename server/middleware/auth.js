const { verify } = require('../lib/jwt');
const { query } = require('../lib/db');

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ error: 'Необходима авторизация' });

    const decoded = verify(token);

    const { rows } = await query(
      `SELECT u.id, u.email, u.name,
              p.salon_name, p.has_access, p.is_admin, p.onboarding
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
    }
    return res.status(401).json({ error: 'Ошибка авторизации' });
  }
}

module.exports = { requireAuth };
