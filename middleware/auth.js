const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

/**
 * Middleware: verify JWT from Authorization header.
 * Attaches req.user = { userId, email } on success.
 * In development (no JWT_SECRET set), attaches a default dev user.
 */
function requireAuth(req, res, next) {
  if (!process.env.JWT_SECRET) {
    // Dev mode: single-user, no auth required
    req.user = { userId: 'dev-user', email: 'dev@local' };
    return next();
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { userId: payload.sub, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function signToken(userId, email) {
  return jwt.sign({ sub: userId, email }, JWT_SECRET, { expiresIn: '30d' });
}

module.exports = { requireAuth, signToken };
