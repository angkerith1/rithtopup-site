"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useCurrency } from "@/lib/currency";
import {
  Clock,
  CheckCircle2,
  Copy,
  Check,
  Smartphone,
  Loader2,
  AlertCircle,
  RefreshCw,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";

interface OrderPayment {
  orderNumber: string;
  status: string;
  gameName: string;
  gameSlug: string;
  productName: string;
  playerUid: string;
  serverId: string | null;
  amountUsd: number;
  amountKhr: number | null;
  paymentMethod: string;
  paymentRef: string | null;
  paymentUrl: string | null;
  qrString: string | null;
  paymentExpiresAt: string | null;
  createdAt: string;
  paidAt: string | null;
  khpayKey: string | null;
}

const TERMINAL = new Set(["DELIVERED", "FAILED", "REFUNDED", "CANCELLED"]);
const PAID_STATES = new Set(["PAID", "PROCESSING", "DELIVERED"]);
const KHPAY_URL_RE = /^https:\/\/khpay\.site\//i;

export default function CheckoutPage() {
  const params = useParams<{ orderNumber: string }>();
  const router = useRouter();
  const { format } = useCurrency();

  const orderNumber = (params?.orderNumber || "").toUpperCase();

  const [order, setOrder] = useState<OrderPayment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [creatingTxn, setCreatingTxn] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const txnCreatedRef = useRef(false);

  const fetchOrder = useCallback(async () => {
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderNumber)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Order not found");
      }
      const data: OrderPayment = await res.json();
      setOrder(data);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load order";
      setError(msg);
      return null;
    }
  }, [orderNumber]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchOrder().finally(() => setLoading(false));
  }, [fetchOrder]);

  // ─── Auto-redirect if order already has a KHPay payment URL ───
  useEffect(() => {
    if (
      order &&
      order.status === "PENDING" &&
      order.paymentUrl &&
      KHPAY_URL_RE.test(order.paymentUrl) &&
      !redirecting
    ) {
      setRedirecting(true);
      const t = setTimeout(() => {
        window.location.href = order.paymentUrl!;
      }, 400);
      return () => clearTimeout(t);
    }
  }, [order, redirecting]);

  // ─── Client-side KHPay transaction creation ───
  // When server-side failed (Cloudflare), create transaction from the browser
  useEffect(() => {
    if (
      !order ||
      order.status !== "PENDING" ||
      redirecting ||
      creatingTxn ||
      txnCreatedRef.current
    ) return;

    // Already has a KHPay URL or QR — no need to create client-side
    if (order.paymentUrl && KHPAY_URL_RE.test(order.paymentUrl)) return;
    if (order.qrString) return;
    if (order.paymentRef?.startsWith("SIM-")) return;

    const khpayKey = order.khpayKey;
    if (!khpayKey) return;

    txnCreatedRef.current = true;
    setCreatingTxn(true);

    (async () => {
      try {
        const origin = window.location.origin;
        const res = await fetch("https://khpay.site/api/v1/qr/generate", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${khpayKey}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify({
            amount: order.amountUsd.toFixed(2),
            currency: "USD",
            note: `RITHTOPUP Order ${order.orderNumber}`,
            success_url: `${origin}/order?number=${order.orderNumber}`,
            cancel_url: `${origin}/games/${order.gameSlug}`,
          }),
        });

        const json = await res.json();
        if (json.success && json.data?.payment_url) {
          // Save transaction info to our order
          await fetch(`/api/orders/${encodeURIComponent(order.orderNumber)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transactionId: json.data.transaction_id,
              paymentUrl: json.data.payment_url,
            }),
          });

          // Redirect to KHPay hosted payment page
          setRedirecting(true);
          window.location.href = json.data.payment_url;
        } else {
          console.error("[khpay] Client-side create failed:", json);
          setCreatingTxn(false);
        }
      } catch (err) {
        console.error("[khpay] Client-side create error:", err);
        setCreatingTxn(false);
      }
    })();
  }, [order, redirecting, creatingTxn]);

  // Polling while awaiting payment
  useEffect(() => {
    if (!order || redirecting || creatingTxn) return;
    if (TERMINAL.has(order.status) || PAID_STATES.has(order.status)) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (PAID_STATES.has(order.status)) {
        const t = setTimeout(() => {
          router.push(`/order?number=${order.orderNumber}`);
        }, 2000);
        return () => clearTimeout(t);
      }
      return;
    }

    pollRef.current = setInterval(() => {
      fetchOrder();
    }, 3000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [order, fetchOrder, router, redirecting, creatingTxn]);

  // Countdown tick
  useEffect(() => {
    if (!order?.paymentExpiresAt) {
      setRemainingMs(null);
      return;
    }
    const expiry = new Date(order.paymentExpiresAt).getTime();
    const tick = () => {
      const ms = expiry - Date.now();
      setRemainingMs(ms > 0 ? ms : 0);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [order?.paymentExpiresAt]);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* */ }
  }

  async function handleSimulate() {
    if (!order || simulating) return;
    setSimulating(true);
    try {
      await fetch(
        `/api/payment/simulate?order=${encodeURIComponent(order.orderNumber)}&ref=${encodeURIComponent(order.paymentRef ?? "")}`,
        { cache: "no-store" }
      );
      await fetchOrder();
    } finally {
      setSimulating(false);
    }
  }

  const isExpired = remainingMs !== null && remainingMs <= 0 && !PAID_STATES.has(order?.status ?? "");
  const isPaid = order ? PAID_STATES.has(order.status) : false;
  const isSimMode = order?.paymentRef?.startsWith("SIM-") ?? false;

  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8 sm:py-12 sm:px-6">
        {/* ── Redirecting / Creating txn ── */}
        {(redirecting || creatingTxn) && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-fox-primary/20 mb-4">
              <ExternalLink className="h-8 w-8 text-fox-primary animate-pulse" />
            </div>
            <h1 className="font-display text-xl font-bold mb-2">
              {redirecting ? "Redirecting to Payment..." : "Preparing Payment..."}
            </h1>
            <p className="text-fox-muted text-sm mb-4">
              {redirecting
                ? "Opening KHPay secure payment page."
                : "Setting up your payment, please wait..."}
            </p>
            <Loader2 className="h-5 w-5 animate-spin text-fox-primary" />
          </div>
        )}

        {!redirecting && !creatingTxn && loading && (
          <div className="flex items-center justify-center py-24 text-fox-muted">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            Loading payment...
          </div>
        )}

        {!redirecting && !creatingTxn && !loading && error && (
          <div className="rounded-xl border border-red-400/40 bg-red-400/10 p-6 text-center">
            <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-2" />
            <p className="text-red-300">{error}</p>
            <a href="/" className="inline-block mt-4 btn-primary">
              Back to home
            </a>
          </div>
        )}

        {!redirecting && !creatingTxn && !loading && order && (
          <>
            {/* Success state */}
            {isPaid && (
              <div className="rounded-2xl border border-green-400/40 bg-gradient-to-br from-green-500/10 to-emerald-500/5 p-8 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20 mb-4">
                  <CheckCircle2 className="h-10 w-10 text-green-400" />
                </div>
                <h1 className="font-display text-2xl font-bold mb-2">Payment Received!</h1>
                <p className="text-fox-muted text-sm mb-1">
                  Order <span className="font-mono text-fox-text">{order.orderNumber}</span>
                </p>
                <p className="text-fox-muted text-sm">Redirecting you to order tracker...</p>
                <Loader2 className="h-4 w-4 animate-spin mx-auto mt-4 text-fox-muted" />
              </div>
            )}

            {/* Expired state */}
            {!isPaid && isExpired && (
              <div className="rounded-2xl border border-red-400/40 bg-red-400/10 p-8 text-center">
                <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-3" />
                <h1 className="font-display text-xl font-bold mb-2">Payment Expired</h1>
                <p className="text-fox-muted text-sm mb-4">
                  This QR code has expired. Please start a new order.
                </p>
                <a href={`/games/${order.gameSlug}`} className="btn-primary">
                  Start new order
                </a>
              </div>
            )}

            {/* Active payment — fallback when client KHPay call failed */}
            {!isPaid && !isExpired && (
              <div className="space-y-6">
                <div className="text-center">
                  <h1 className="font-display text-2xl sm:text-3xl font-bold mb-1">
                    Complete Your Payment
                  </h1>
                  <p className="text-fox-muted text-sm">
                    Use any KHQR-compatible app: ABA Pay, ACLEDA, Wing, TrueMoney, Prince Bank...
                  </p>
                </div>

                <div className="grid md:grid-cols-[auto_1fr] gap-6 items-start">
                  {/* QR / redirect panel */}
                  <div className="mx-auto rounded-2xl border-2 border-fox-primary/30 bg-white p-4 shadow-xl shadow-fox-primary/20">
                    {order.qrString ? (
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=280x280&ecc=M&margin=2&data=${encodeURIComponent(order.qrString)}`}
                        alt="KHQR code"
                        width={280}
                        height={280}
                        className="block"
                      />
                    ) : (
                      <div className="flex h-[280px] w-[280px] flex-col items-center justify-center text-center text-gray-500">
                        {isSimMode ? (
                          <>
                            <Smartphone className="h-14 w-14 mb-3 text-gray-400" />
                            <p className="text-sm font-semibold text-gray-700">Simulation Mode</p>
                            <p className="text-xs px-4 mt-1">Click the button below to simulate payment.</p>
                          </>
                        ) : (
                          <>
                            <AlertCircle className="h-14 w-14 mb-3 text-yellow-500" />
                            <p className="text-sm font-semibold text-gray-700">
                              Could not connect to payment provider
                            </p>
                            <p className="text-xs px-4 mt-2 text-gray-500">
                              Please try creating a new order. If this persists, contact support.
                            </p>
                            <a
                              href={`/games/${order.gameSlug}`}
                              className="mt-3 rounded-lg bg-fox-primary px-4 py-2 text-xs font-bold text-black"
                            >
                              Try Again
                            </a>
                          </>
                        )}
                      </div>
                    )}
                    <div className="mt-3 text-center">
                      <div className="flex items-center justify-center gap-1 text-xs font-bold text-gray-900">
                        <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
                        KHQR
                      </div>
                    </div>
                  </div>

                  {/* Details panel */}
                  <div className="space-y-4">
                    <div className="rounded-xl border border-fox-border bg-fox-card p-4">
                      <div className="text-[10px] uppercase tracking-widest text-fox-muted mb-1">Amount due</div>
                      <div className="font-display text-3xl font-bold text-fox-primary">
                        {format(order.amountUsd)}
                      </div>
                      {order.amountKhr && (
                        <div className="text-sm text-fox-muted mt-0.5">
                          \u2248 {order.amountKhr.toLocaleString()} \u17DB
                        </div>
                      )}
                    </div>

                    {remainingMs !== null && (
                      <div className="rounded-xl border border-yellow-400/30 bg-yellow-400/5 p-4">
                        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-yellow-400/90 mb-1">
                          <Clock className="h-3 w-3" />
                          Time remaining
                        </div>
                        <div className="font-mono text-2xl font-bold text-yellow-300">
                          {formatCountdown(remainingMs)}
                        </div>
                      </div>
                    )}

                    <div className="rounded-xl border border-fox-border bg-fox-card p-4">
                      <div className="flex items-center gap-2 text-sm">
                        <Loader2 className="h-4 w-4 animate-spin text-fox-primary" />
                        <span className="text-fox-muted">Waiting for payment...</span>
                      </div>
                      <button
                        onClick={fetchOrder}
                        className="mt-2 text-xs text-fox-primary hover:underline inline-flex items-center gap-1"
                        type="button"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Check now
                      </button>
                    </div>

                    {isSimMode && (
                      <button
                        type="button"
                        onClick={handleSimulate}
                        disabled={simulating}
                        className="w-full rounded-xl border border-fox-accent/40 bg-fox-accent/10 text-fox-accent hover:bg-fox-accent/20 disabled:opacity-60 px-4 py-3 text-sm font-semibold transition"
                      >
                        {simulating ? "Processing..." : "\u25B6 Simulate Payment (dev mode)"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Order summary */}
                <div className="rounded-xl border border-fox-border bg-fox-card p-4">
                  <div className="text-[10px] uppercase tracking-widest text-fox-muted mb-3">Order details</div>
                  <div className="space-y-2 text-sm">
                    <Row label="Order #">
                      <button type="button" onClick={() => copy(order.orderNumber, "order")}
                        className="inline-flex items-center gap-1.5 font-mono hover:text-fox-primary">
                        {order.orderNumber}
                        {copied === "order" ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3 text-fox-muted" />}
                      </button>
                    </Row>
                    <Row label="Game">{order.gameName}</Row>
                    <Row label="Package">{order.productName}</Row>
                    <Row label="Player UID">
                      <span className="font-mono">{order.playerUid}</span>
                      {order.serverId && <span className="text-fox-muted"> ({order.serverId})</span>}
                    </Row>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-4">
      <span className="text-fox-muted text-xs">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
