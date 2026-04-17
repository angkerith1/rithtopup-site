import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || undefined;
  const q = searchParams.get("q")?.trim();

  const where: Record<string, unknown> = {};
  if (status && status !== "ALL") where.status = status;
  if (q) {
    where.OR = [
      { orderNumber: { contains: q.toUpperCase(), mode: "insensitive" as const } },
      { playerUid: { contains: q, mode: "insensitive" as const } },
      { customerEmail: { contains: q, mode: "insensitive" as const } },
      { customerPhone: { contains: q, mode: "insensitive" as const } },
    ];
  }

  const orders = await prisma.order.findMany({
    where,
    include: {
      game: { select: { name: true } },
      product: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const header = [
    "Order #",
    "Status",
    "Game",
    "Product",
    "Player UID",
    "Server",
    "Amount USD",
    "Amount KHR",
    "Email",
    "Phone",
    "Payment Method",
    "Payment Ref",
    "Created",
    "Paid",
    "Delivered",
  ];

  const rows = orders.map((o) =>
    [
      o.orderNumber,
      o.status,
      o.game?.name,
      o.product?.name,
      o.playerUid,
      o.serverId,
      o.amountUsd.toFixed(2),
      o.amountKhr,
      o.customerEmail,
      o.customerPhone,
      o.paymentMethod,
      o.paymentRef,
      o.createdAt.toISOString(),
      o.paidAt?.toISOString() ?? "",
      o.deliveredAt?.toISOString() ?? "",
    ]
      .map(csvCell)
      .join(",")
  );

  const csv = [header.map(csvCell).join(","), ...rows].join("\n");
  const filename = `orders-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
