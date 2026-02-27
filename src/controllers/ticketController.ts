import { Request, Response } from "express";
import { ticketService } from "../services/ticketService";
import { PurchaseResponse, PurchaseRequest } from "../types";
import { validatePurchaseRequest } from "../validators/purchaseValidator";


export class TicketController {
  /**
   * POST /purchase
   * Validates input, delegates to service, returns HTTP response.
   * No business logic here — the controller only speaks HTTP.
   */
  async purchase(
    req: Request<Record<string, never>, PurchaseResponse, PurchaseRequest>,
    res: Response<PurchaseResponse>
  ): Promise<void> {
    // ── 1. Validate ──────────────────────────────────────────────────────────
    const validation = validatePurchaseRequest(req.body);
    if (!validation.valid) {
      res.status(400).json({ success: false, error: validation.error });
      return;
    }

    const { userId, eventId, quantity } = req.body;

    // ── 2. Delegate to service ────────────────────────────────────────────────
    try {
      const tickets = await ticketService.purchaseTickets(userId, eventId, quantity);
      res.status(200).json({ success: true, tickets });
    } catch (err) {
      const error = err as Error;

      // Known domain errors → 400 Bad Request
      if (
        error.message === "Event not found" ||
        error.message === "Not enough tickets available"
      ) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }

      // Unknown errors → 500 Internal Server Error
      console.error("[Controller] Unexpected error in /purchase:", error.message);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
}

export const ticketController = new TicketController();