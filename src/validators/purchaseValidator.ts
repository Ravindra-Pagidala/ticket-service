import { PurchaseRequest } from "../types";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates all fields of a purchase request before it reaches service logic.
 * Keeps validation concerns out of the controller and service layers.
 */
export function validatePurchaseRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }

  const req = body as Partial<PurchaseRequest>;

  if (!req.userId || typeof req.userId !== "string" || req.userId.trim() === "") {
    return { valid: false, error: "userId is required and must be a non-empty string" };
  }

  if (!req.eventId || typeof req.eventId !== "string" || req.eventId.trim() === "") {
    return { valid: false, error: "eventId is required and must be a non-empty string" };
  }

  if (req.quantity === undefined || req.quantity === null) {
    return { valid: false, error: "quantity is required" };
  }

  if (typeof req.quantity !== "number" || !Number.isInteger(req.quantity)) {
    return { valid: false, error: "quantity must be an integer" };
  }

  if (req.quantity <= 0) {
    return { valid: false, error: "quantity must be greater than 0" };
  }

  if (req.quantity % 8 !== 0) {
    return { valid: false, error: "quantity must be a multiple of 8" };
  }

  return { valid: true };
}