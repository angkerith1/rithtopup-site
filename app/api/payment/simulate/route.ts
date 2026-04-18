import { prisma } from "@/lib/prisma";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

// Simulation: pretends payment succeeded and marks order PAID, then DELIVERED.
// Only active when PAYMENT_SIMULATION_MODE=true or no real credentials set.
export async function GET(req: NextRequest) {
  if (process.env.PAYMENT_SIMULATION_MODE !== "true") {
    return NextResponse.json({ error: "Simulation is disabled" }, { status: 404 });
  }

  const orderNumber = req.nextUrl.searchParams.get("order");
  const ref = req.nextUrl.searchParams.get("ref");

  if (!orderNumber) {
    return NextResponse.json({ error: "Missing order" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({ where: { orderNumber } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  // Mark as paid
  if (order.status === "PENDING") {
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: "PAID",
        paymentRef: ref ?? order.paymentRef,
        paidAt: new Date(),
      },
    });

    // In real life you'd trigger fulfillment here (queue job).
    // For simulation, mark DELIVERED right away:
    setTimeout(async () => {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: "DELIVERED", deliveredAt: new Date() },
      });
    }, 100);
  }

  // Render a simple "payment complete" page that redirects to order tracker.
  const isPublicHttpUrl = (value?: string | null): value is string => {
    if (!value) return false;
    if (!/^https?:\/\//i.test(value)) return false;
    return !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(value);
  };
  const requestOrigin = req.nextUrl.origin;
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  const baseUrl = (isPublicHttpUrl(envBase) ? envBase : requestOrigin).replace(/\/$/, "");
  const html = `<!doctype html>
<html>
<head>
<title>Payment Simulated â€” RITHTOPUP</title>
<meta http-equiv="refresh" content="3;url=${baseUrl}/order?number=${orderNumber}">
<style>
  body { font-family: system-ui; background: #0A0A0F; color: #F5F5F7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { text-align: center; padding: 2rem; border: 1px solid #24243A; border-radius: 16px; background: #12121A; max-width: 400px; }
  h1 { color: #FF6B1A; margin: 0 0 1rem; }
  .check { font-size: 3rem; margin-bottom: 1rem; }
  code { background: #24243A; padding: 2px 8px; border-radius: 4px; color: #FFB800; }
  a { color: #FF6B1A; }
</style>
</head>
<body>
  <div class="box">
    <div class="check">âœ…</div>
    <h1>Payment Simulated</h1>
    <p>Order <code>${orderNumber}</code> is being processed.</p>
    <p style="color:#8B8B9E;font-size:0.875rem">Simulation mode is active â€” in production this would be your real ABA Pay or Binance Pay confirmation.</p>
    <p>Redirecting to order tracker in 3s...</p>
    <p><a href="${baseUrl}/order?number=${orderNumber}">Continue now â†’</a></p>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html" },
  });
}
