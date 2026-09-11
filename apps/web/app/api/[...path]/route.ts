import type { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
async function proxy(request: NextRequest) {
  const upstream = process.env.API_INTERNAL_URL;
  if (!upstream)
    return Response.json({ message: "Serviço indisponível." }, { status: 503 });
  const incoming = new URL(request.url);
  const url = new URL(incoming.pathname + incoming.search, upstream);
  const headers = new Headers();
  for (const key of [
    "content-type",
    "cookie",
    "origin",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
  ]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  try {
    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await request.text();
    if (body && Buffer.byteLength(body) > 16384)
      return Response.json(
        { message: "Requisição muito grande." },
        { status: 413 },
      );
    const result = await fetch(url, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const outgoing = new Headers({
      "content-type": result.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
    for (const cookie of result.headers.getSetCookie())
      outgoing.append("set-cookie", cookie);
    return new Response(result.body, {
      status: result.status,
      headers: outgoing,
    });
  } catch {
    return Response.json(
      { message: "Serviço indisponível. Tente novamente." },
      { status: 503 },
    );
  }
}
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
