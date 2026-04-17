import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || undefined;
  const q = searchParams.get("q")?.trim();
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const perPage = Math.min(100, parseInt(searchParams.get("perPage") || "25"));

  const where: any = {};
  if (status && status !== "ALL") where.status = status;
  if (q) {
    where.OR = [
      { orderNumber: { contains: q.toUpperCase(), mode: "insensitive" as const } },
      { playerUid: { contains: q, mode: "insensitive" as const } },
      { customerEmail: { contains: q, mode: "insensitive" as const } },
    ];
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        game: { select: { name: true, slug: true } },
        product: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.order.count({ where }),
  ]);

  return NextResponse.json({
    orders,
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
}
