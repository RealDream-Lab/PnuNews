export function createRateLimiter({ limit = 90, windowMs = 60_000, clock = Date.now, maxKeys = 20_000 } = {}) {
  const buckets = new Map();

  return function rateLimit(request, response, next) {
    const now = clock();
    const key = request.ip || request.socket?.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.delete(key);
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value);
    response.setHeader('RateLimit-Limit', String(limit));
    response.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    response.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > limit) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return response.status(429).json({ error: 'تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.' });
    }
    return next();
  };
}
