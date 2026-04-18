import crypto from "crypto";

// KHPay supports a single unified KHQR code that is scannable by any
// Cambodian bank app (ABA Pay, ACLEDA Pay, Wing, TrueMoney, Sathapana,
// Prince Bank, etc.). We only keep MANUAL as an admin override method.
export type PaymentMethod = "KHPAY" | "MANUAL";

export interface InitiatePaymentArgs {
  orderNumber: string;
  amountUsd: number;
  method: PaymentMethod;
  returnUrl: string;
  cancelUrl: string;
  callbackUrl: string;
  note?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}

export interface PaymentInitResult {
  paymentRef: string;
  redirectUrl: string;
  qrString?: string;
  expiresAt: Date;
}

const KHPAY_BASE = process.env.KHPAY_BASE_URL || "https://khpay.site/api/v1";
const KHPAY_KEY = process.env.KHPAY_API_KEY || "";
const SIM_MODE = process.env.PAYMENT_SIMULATION_MODE === "true";

export async function initiatePayment(
  args: InitiatePaymentArgs
): Promise<PaymentInitResult> {
  if (SIM_MODE) return simulatePayment(args);
  if (!KHPAY_KEY) {
    throw new Error("KHPAY_API_KEY is not configured");
  }
  if (args.method === "KHPAY") return initiateKhpay(args);
  throw new Error(`Unsupported payment method: ${args.method}`);
}

function simulatePayment(args: InitiatePaymentArgs): PaymentInitResult {
  const ref = `SIM-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  const isPublicHttpUrl = (value?: string): value is string =>
    !!value &&
    /^https?:\/\//i.test(value) &&
    !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(value);

  const returnOrigin = (() => {
    try {
      return new URL(args.returnUrl).origin;
    } catch {
      return "";
    }
  })();
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  const base = (isPublicHttpUrl(envBase) ? envBase : returnOrigin).replace(/\/$/, "");

  return {
    paymentRef: ref,
    redirectUrl: `${base || ""}/api/payment/simulate?order=${args.orderNumber}&ref=${ref}&method=${args.method}`,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  };
}

/**
 * KHPay KHQR integration.
 * Docs: https://khpay.site/api-documentation
 * Endpoint: POST /api/v1/qr/generate
 * Auth: Authorization: Bearer ak_xxx
 */
async function initiateKhpay(args: InitiatePaymentArgs): Promise<PaymentInitResult> {
  // KHPay rejects private/internal URLs. Omit them entirely when they point
  // at localhost — the docs confirm all three URLs are optional. Payment
  // status is resolved via polling GET /qr/check/{id} instead.
  const isPublicUrl = (u?: string) =>
    !!u &&
    /^https?:\/\//i.test(u) &&
    !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u);

  const body: Record<string, unknown> = {
    amount: args.amountUsd.toFixed(2),
    currency: "USD",
    note: args.note || `RITHTOPUP Order ${args.orderNumber}`,
    metadata: {
      order_number: args.orderNumber,
      ...(args.customerEmail ? { email: args.customerEmail } : {}),
      ...(args.metadata || {}),
    },
  };
  if (isPublicUrl(args.returnUrl)) body.success_url = args.returnUrl;
  if (isPublicUrl(args.cancelUrl)) body.cancel_url = args.cancelUrl;
  if (isPublicUrl(args.callbackUrl)) body.callback_url = args.callbackUrl;

  const res = await fetch(`${KHPAY_BASE}/qr/generate`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KHPAY_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const msg =
      json?.error ||
      json?.message ||
      (json ? JSON.stringify(json).slice(0, 300) : `HTTP ${res.status}`);
    throw new Error(`KHPay: ${msg}`);
  }

  const data = json.data;
  if (!data?.qr_string) {
    throw new Error("KHPay: response did not include qr_string");
  }
  return {
    paymentRef: data.transaction_id,
    redirectUrl: data.payment_url || `/checkout/${args.orderNumber}`,
    qrString: data.qr_string,
    expiresAt: new Date(Date.now() + (Number(data.expires_in) || 180) * 1000),
  };
}

/**
 * Poll a KHPay transaction status. Fallback to the webhook.
 */
export async function fetchKhpayStatus(transactionId: string): Promise<{
  status: string;
  paid: boolean;
  amount?: string;
  currency?: string;
} | null> {
  if (SIM_MODE || !KHPAY_KEY) return null;
  const res = await fetch(`${KHPAY_BASE}/qr/check/${transactionId}`, {
    headers: { "Authorization": `Bearer ${KHPAY_KEY}` },
    cache: "no-store",
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    console.warn(`[khpay] check ${transactionId} failed:`, res.status, json);
    return null;
  }
  console.log(`[khpay] check ${transactionId}:`, JSON.stringify(json.data));
  return {
    status: String(json.data.status || "pending"),
    paid: Boolean(json.data.paid),
    amount: json.data.amount,
    currency: json.data.currency,
  };
}

/**
 * Verify a KHPay webhook signature.
 * Header: X-Webhook-Signature: sha256=<hex>
 */
export function verifyWebhook(
  _method: PaymentMethod,
  rawBody: string,
  headers: Record<string, string>
): boolean {
  if (SIM_MODE) return true;

  const secret = process.env.KHPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook] KHPAY_WEBHOOK_SECRET not set â€” rejecting.");
    return false;
  }

  const received = headers["x-webhook-signature"] || "";
  if (!received.startsWith("sha256=")) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

