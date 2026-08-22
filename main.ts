// main.ts
// Trust Social - Deno eSIM API Proxy (fixed)

const PDSBOOST_URL =
  Deno.env.get("PDSBOOST_API_URL") ||
  "https://pdsboost.com/api/store-v2";

const PDSBOOST_KEY =
  Deno.env.get("PDSBOOST_API_KEY") ||
  Deno.env.get("PDSBOOST_PRIVATE_API_KEY") ||
  "";

const PORT = Number(Deno.env.get("PORT") || 8000);

// --------------------------------------------------
// CORS + JSON helpers
// --------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    "Content-Type": "application/json",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(),
  });
}

function errorResponse(message: string, status = 400, extra: unknown = null) {
  return json(
    {
      success: false,
      error: message,
      ...(extra ? { details: extra } : {}),
    },
    status,
  );
}

// --------------------------------------------------
// Call Pdsboost
// --------------------------------------------------

async function pdsboostRequest(
  action: string,
  extra: Record<string, unknown> = {},
) {
  if (!PDSBOOST_KEY) {
    throw new Error(
      "PDSBOOST_API_KEY is not set in Deno Deploy environment variables.",
    );
  }

  const body = {
    key: PDSBOOST_KEY,
    action,
    ...extra,
  };

  const response = await fetch(PDSBOOST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // Provider returned non-JSON
    throw new Error(
      `Provider returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }

  // Many Nigerian APIs return HTTP 200 even on logical errors
  if (data?.success === false || data?.status === false || data?.error) {
    throw new Error(
      data.error || data.message || data.msg || "Provider returned an error",
    );
  }

  return data;
}

// --------------------------------------------------
// Extract arrays safely
// --------------------------------------------------

function extractArray(data: any, keys: string[]) {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

// --------------------------------------------------
// Routes
// --------------------------------------------------

async function getCountries() {
  const data = await pdsboostRequest("esim_countries");

  const countries = extractArray(data, [
    "countries",
    "data",
    "results",
    "items",
    "list",
  ]);

  return json({
    success: true,
    countries,
    data: countries,
  });
}

async function getPlans(request: Request) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const country =
    body.country || body.countryCode || body.code || body.country_code || "";

  if (!country) {
    return errorResponse("Country is required.");
  }

  const data = await pdsboostRequest("esim_plans", { country });

  const plans = extractArray(data, [
    "plans",
    "data",
    "results",
    "items",
    "list",
  ]);

  return json({
    success: true,
    country,
    plans,
    data: plans,
  });
}

// Poll status until QR / LPA / ICCID appear (or timeout)
async function pollOrder(orderId: string, maxAttempts = 12) {
  for (let i = 0; i < maxAttempts; i++) {
    const statusData = await pdsboostRequest("status", { order: orderId });

    const qr =
      statusData.qr ||
      statusData.qr_code ||
      statusData.qrcode ||
      statusData.qrCode ||
      "";
    const lpa =
      statusData.lpa ||
      statusData.LPA ||
      statusData.activation_code ||
      statusData.activationCode ||
      "";
    const iccid = statusData.iccid || statusData.ICCID || "";

    if (qr || lpa || iccid) {
      return { ...statusData, qr, lpa, iccid, order: orderId };
    }

    // wait 2 seconds before next poll
    await new Promise((r) => setTimeout(r, 2000));
  }

  // return whatever we have after timeout
  return await pdsboostRequest("status", { order: orderId });
}

async function buyEsim(request: Request) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body.");
  }

  const packageId =
    body.package ||
    body.packageId ||
    body.plan ||
    body.planId ||
    body.code ||
    "";

  if (!packageId) {
    return errorResponse("eSIM package is required.");
  }

  // 1. Place the order
  const buyData = await pdsboostRequest("esim_buy", {
    package: packageId,
  });

  const orderId =
    buyData.order ||
    buyData.order_id ||
    buyData.orderId ||
    buyData.id ||
    "";

  if (!orderId) {
    // Some providers return everything immediately
    return json({
      success: true,
      order: "",
      order_id: "",
      qr: buyData.qr || buyData.qr_code || "",
      lpa: buyData.lpa || buyData.LPA || "",
      iccid: buyData.iccid || "",
      package: packageId,
      message: buyData.message || "eSIM purchase completed.",
      provider: buyData,
    });
  }

  // 2. Poll until delivery details appear
  const finalData = await pollOrder(String(orderId));

  return json({
    success: true,
    order: orderId,
    order_id: orderId,
    qr:
      finalData.qr ||
      finalData.qr_code ||
      finalData.qrcode ||
      finalData.qrCode ||
      "",
    lpa:
      finalData.lpa ||
      finalData.LPA ||
      finalData.activation_code ||
      "",
    iccid: finalData.iccid || finalData.ICCID || "",
    package: packageId,
    message: finalData.message || "eSIM purchase completed.",
    provider: finalData,
  });
}

function healthCheck() {
  return json({
    success: true,
    service: "Trust Social eSIM API",
    status: "online",
    hasKey: Boolean(PDSBOOST_KEY),
    routes: [
      "GET  /",
      "POST /esim/countries",
      "POST /esim/plans",
      "POST /esim/buy",
    ],
  });
}

// --------------------------------------------------
// Server
// --------------------------------------------------

Deno.serve({ port: PORT }, async (request) => {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  try {
    if (request.method === "GET" && url.pathname === "/") {
      return healthCheck();
    }

    if (request.method === "POST" && url.pathname === "/esim/countries") {
      return await getCountries();
    }

    if (request.method === "POST" && url.pathname === "/esim/plans") {
      return await getPlans(request);
    }

    if (request.method === "POST" && url.pathname === "/esim/buy") {
      return await buyEsim(request);
    }

    return errorResponse("Route not found.", 404);
  } catch (error) {
    console.error("Server error:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      502,
    );
  }
});
