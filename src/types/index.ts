// ─── Domain Types ─────────────────────────────────────────────────────────────

export interface TicketPool {
  event_id: string;
  total: number;
  available: number;
}

export interface IssuedTicket {
  id: number;
  event_id: string;
  user_id: string;
  ticket_number: number;
  created_at: Date;
}

// ─── HTTP Contract Types ───────────────────────────────────────────────────────

export interface PurchaseRequest {
  userId: string;
  eventId: string;
  quantity: number;
}

export interface PurchaseResponse {
  success: boolean;
  tickets?: number[];
  error?: string;
}

// ─── Queue Job Types ───────────────────────────────────────────────────────────

export interface TicketPersistJob {
  userId: string;
  eventId: string;
  ticketNumbers: number[];
}