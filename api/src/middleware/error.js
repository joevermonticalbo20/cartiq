export function notFound(req, res) {
  res.status(404).json({
    error: `Not found: ${req.method} ${req.originalUrl}`,
    correlationId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const correlationId =
    req.correlationId ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  console.error(
    `[api:error] id=${correlationId} ${req.method} ${req.originalUrl} ::`,
    err.message
  );

  // Prisma known-request errors -> actionable client responses.
  if (err.code === "P2002") {
    return res.status(409).json({
      error: "Duplicate record (already exists).",
      correlationId,
    });
  }
  if (err.code === "P2025") {
    return res.status(404).json({
      error: "Record not found.",
      correlationId,
    });
  }

  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? "Internal server error" : err.message,
    correlationId,
  });
}
