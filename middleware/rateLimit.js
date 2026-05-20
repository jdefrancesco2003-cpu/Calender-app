/**
 * In-process rate limiter middleware factory.
 * Usage: app.use('/api/events/parse', rateLimit({ max: 20, windowMs: 60000 }))
 */
function rateLimit({ max = 20, windowMs = 60000, message = 'Too many requests' } = {}) {
  const store = new Map();

  // Clean up expired entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.expiresAt) store.delete(key);
    }
  }, 300000);

  return function rateLimitMiddleware(req, res, next) {
    const key = req.user?.userId || req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now > entry.expiresAt) {
      store.set(key, { count: 1, expiresAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      return res.status(429).json({ error: message });
    }
    entry.count++;
    next();
  };
}

module.exports = { rateLimit };
