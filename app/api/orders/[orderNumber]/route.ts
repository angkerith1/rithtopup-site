import { prisma } from "@/lib/prisma";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { fetchKhpayStatus } from "@/lib/payment";
import { z } from "zod";

export async function GET(
  _req: NextRequest,
  { params }: { params: { orderNumber: string } }
) {
  let order = await prisma.order.findUnique({
    where: { orderNumber: params.orderNumber.toUpperCase() },
    include: {
      game: { select: { name: true, slug: true } },
      product: { select: { name: true } },
    },
  });

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  // Sync payment status from KHPay when webhook isn't reachable (localhost dev).
  // Only poll while the order is still PENDING and we have a transaction id.
  if (order.status === "PENDING" && order.paymentRef && !order.paymentRef.startsWith("SIM-")) {
    try {
      const remote = await fetchKhpayStatus(order.paymentRef);
      const isPaid = remote?.paid === true || remote?.status === "paid";
      if (isPaid) {
        order = await prisma.order.update({
          where: { id: order.id },
          data: { status: "PAID", paidAt: new Date() },
          include: {
            game: { select: { name: true, slug: true } },
            product: { select: { name: true } },
          },
        });
      } else if (remote?.status === "expired" || remote?.status === "failed") {
        order = await prisma.order.update({
          where: { id: order.id },
          data: {
            status: remote.status === "expired" ? "CANCELLED" : "FAILED",
            failureReason: `KHPay ${remote.status}`,
          },
          include: {
            game: { select: { name: true, slug: true } },
            product: { select: { name: true } },
          },
        });
      }
    } catch {
      // Silently ignore poll errors â€” we'll retry on the next request.
    }
  }

  return NextResponse.json({
    orderNumber: order.orderNumber,
    status: order.status,
    gameName: order.game.name,
    gameSlug: order.game.slug,
    productName: order.product.name,
    playerUid: order.playerUid,
    serverId: order.serverId,
    amountUsd: order.amountUsd,
    amountKhr: order.amountKhr,
    paymentMethod: order.paymentMethod,
    paymentRef: order.paymentRef,
    paymentUrl: order.paymentUrl,
    qrString: order.qrString,
    paymentExpiresAt: order.paymentExpiresAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    // Expose KHPay key for client-side widget when server-side QR failed
    khpayKey:
      order.status === "PENDING" && !order.qrString
        ? (process.env.KHPAY_API_KEY || "").trim() || null
        : null,
  });
}

// ─── PATCH: save widget payment result ────────────────────────────────
const patchSchema = z.object({
  transactionId: z.string().min(1).max(100),
  paymentUrl: z.string().url().max(500).optional(),
  status: z.enum(["paid"]).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { orderNumber: string } }
) {
  try {
    const body = await req.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const order = await prisma.order.findUnique({
      where: { orderNumber: params.orderNumber.toUpperCase() },
    });

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (order.status !== "PENDING") {
      return NextResponse.json({ ok: true, skipped: true });
    }

    const data: Record<string, unknown> = {
      paymentRef: parsed.data.transactionId,
      paymentExpiresAt: new Date(Date.now() + 180 * 1000),
    };
    if (parsed.data.paymentUrl) {
      data.paymentUrl = parsed.data.paymentUrl;
    }

    // Client confirmed payment → mark PAID
    if (parsed.data.status === "paid") {
      data.status = "PAID";
      data.paidAt = new Date();
    }

    await prisma.order.update({ where: { id: order.id }, data });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Order PATCH error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
