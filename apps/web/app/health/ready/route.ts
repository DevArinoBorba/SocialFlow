export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const res = await fetch(`${process.env.API_INTERNAL_URL}/health/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
    });
    return Response.json(
      { status: res.ok ? "ready" : "unavailable" },
      { status: res.ok ? 200 : 503 },
    );
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
