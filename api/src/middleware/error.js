export function notFound(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error("[api:error]", err.message);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? "Internal server error" : err.message,
  });
}
