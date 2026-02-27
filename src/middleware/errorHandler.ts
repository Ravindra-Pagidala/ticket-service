import { Request, Response, NextFunction } from "express";

/**
 * Global error handler — catches anything that slips past route handlers.
 * Must have exactly 4 parameters for Express to recognise it as an error handler.
 */
export function globalErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("[GlobalErrorHandler]", err.stack ?? err.message);
  res.status(500).json({ success: false, error: "Internal server error" });
}

/**
 * 404 handler — catches requests to undefined routes.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
}