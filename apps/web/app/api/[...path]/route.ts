import type { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
async function proxy(request: NextRequest) {
  const upstream = process.env.API_INTERNAL_URL;
  const incoming = new URL(request.url);
  const isMediaContent =
    /^\/api\/organizations\/[^/]+\/clients\/[^/]+\/media\/[^/]+\/content$/.test(
      incoming.pathname,
    );
  const isBatchImport =
    /^\/api\/organizations\/[^/]+\/clients\/[^/]+\/batches\/[^/]+\/import$/.test(
      incoming.pathname,
    );
  const defaultCsp = isMediaContent
    ? "default-src 'none'; sandbox"
    : "default-src 'none'; frame-ancestors 'none'";

  if (!upstream)
    return Response.json(
      { message: "Serviço indisponível." },
      {
        status: 503,
        headers: {
          "content-security-policy": defaultCsp,
          "x-content-type-options": "nosniff",
        },
      },
    );
  const url = new URL(incoming.pathname + incoming.search, upstream);
  const headers = new Headers();
  for (const key of [
    "accept",
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
    const isMediaUpload = request.method === "PUT" && isMediaContent;
    const isCsvImport = request.method === "POST" && isBatchImport;
    const limit = isMediaUpload
      ? 10 * 1024 * 1024
      : isCsvImport
        ? 2 * 1024 * 1024
        : 16384;
    let body: Buffer | undefined;
    if (!["GET", "HEAD"].includes(request.method) && request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          return Response.json(
            { message: "Requisição muito grande." },
            {
              status: 413,
              headers: {
                "content-security-policy": defaultCsp,
                "x-content-type-options": "nosniff",
              },
            },
          );
        }
        chunks.push(value);
      }
      body = Buffer.concat(chunks);
    }
    const result = await fetch(url, {
      method: request.method,
      headers,
      body: body ? new Uint8Array(body).buffer : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(isMediaUpload || isCsvImport ? 60000 : 20000),
    });
    const outgoing = new Headers({
      "content-type": result.headers.get("content-type") ?? "application/json",
      "cache-control": result.headers.get("cache-control") ?? "no-store",
      "x-content-type-options": "nosniff",
    });
    if (result.headers.has("location")) {
      outgoing.set("location", result.headers.get("location")!);
    }
    const upstreamCsp = result.headers.get("content-security-policy");
    outgoing.set("content-security-policy", upstreamCsp ?? defaultCsp);
    for (const cookie of result.headers.getSetCookie())
      outgoing.append("set-cookie", cookie);
    return new Response(result.body, {
      status: result.status,
      headers: outgoing,
    });
  } catch {
    return Response.json(
      { message: "Serviço indisponível. Tente novamente." },
      {
        status: 503,
        headers: {
          "content-security-policy": defaultCsp,
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}
export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
