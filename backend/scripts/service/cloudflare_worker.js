/**
 * This file implements a Cloudflare Worker that acts as a reverse proxy to the GKE backend,
 * allowing frontend to make cross-origin requests to the backend without running into CORS issues
 */

const ALLOWED_ORIGIN = "https://kseto06.github.io";

const ALLOWED_METHODS =
  "GET, POST, PUT, PATCH, DELETE, OPTIONS";

const ALLOWED_HEADERS =
  "Content-Type, Authorization";

function getCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env) {
    const browserOrigin = request.headers.get("Origin");

    /*
     * Allow browser requests only from the gh-pages origin
     */
    if (browserOrigin && browserOrigin !== ALLOWED_ORIGIN) {
      return new Response("Origin not allowed", {
        status: 403,
      });
    }

    // Handle browser CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(ALLOWED_ORIGIN),
      });
    }

    if (!env.GKE_ORIGIN) {
      return Response.json(
        { error: "GKE_ORIGIN is not configured" },
        { status: 500 },
      );
    }

    const incomingUrl = new URL(request.url);

    // Preserve the path and query string requested by the website
    const upstreamUrl = new URL(
      incomingUrl.pathname + incomingUrl.search,
      env.GKE_ORIGIN,
    );

    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.delete("host");

    /*
     * Prevent the GKE backend's own browser-CORS middleware from
     * treating this as a direct cross-origin browser request
     */
    upstreamHeaders.set(
      "Origin",
      new URL(env.GKE_ORIGIN).origin,
    );

    // protection between Cloudflare and GKE:
    if (env.PROXY_SECRET) {
      upstreamHeaders.set(
        "X-Proxy-Secret",
        env.PROXY_SECRET,
      );
    }

    const requestInit = {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      requestInit.body = request.body;
    }

    try {
      const upstreamResponse = await fetch(
        upstreamUrl,
        requestInit,
      );

      const responseHeaders =
        new Headers(upstreamResponse.headers);

      const corsHeaders = getCorsHeaders(ALLOWED_ORIGIN);

      for (const [name, value] of Object.entries(corsHeaders)) {
        responseHeaders.set(name, value);
      }

      // keep backend redirects on the HTTPS Worker origin. 
      // otherwise a FastAPI slash redirect can expose the HTTP LoadBalancer URL 
      // to the browser and be blocked as mixed content.
      const location = responseHeaders.get("Location");
      if (location) {
        const redirectUrl = new URL(location, env.GKE_ORIGIN);
        if (redirectUrl.origin === new URL(env.GKE_ORIGIN).origin) {
          responseHeaders.set(
            "Location",
            new URL(
              redirectUrl.pathname + redirectUrl.search + redirectUrl.hash,
              incomingUrl.origin,
            ).toString(),
          );
        }
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error("GKE request failed", error);

      return Response.json(
        { error: "GKE backend unavailable" },
        {
          status: 502,
          headers: getCorsHeaders(ALLOWED_ORIGIN),
        },
      );
    }
  },
};
