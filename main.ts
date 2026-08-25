// main.ts
// Trust Social - Full Deno API (eSIM + Proxies + ClubKonnect)

const PDSBOOST_URL =
  Deno.env.get("PDSBOOST_API_URL") ||
  "https://pdsboost.com/api/store-v2";

const PDSBOOST_KEY =
  Deno.env.get("PDSBOOST_API_KEY") ||
  Deno.env.get("PDSBOOST_PRIVATE_API_KEY") ||
  "";

const CLUBKONNECT_USER_ID = Deno.env.get("CLUBKONNECT_USER_ID") || "";
const CLUBKONNECT_API_KEY = Deno.env.get("CLUBKONNECT_API_KEY") || "";

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
    throw new Error("PDSBOOST_API_KEY is not set in Deno environment variables.");
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
    throw new Error(
      `Provider returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
    );
  }

  if (data?.success === false || data?.status === false || data?.error) {
    throw new Error(
      data.error || data.message || data.msg || "Provider returned an error",
    );
  }

  return data;
}

function extractArray(data: any, keys: string[]) {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

// --------------------------------------------------
// eSIM
// --------------------------------------------------

async function getCountries() {
  const data = await pdsboostRequest("esim_countries");
  const countries = extractArray(data, ["countries", "data", "results", "items", "list"]);
  return json({ success: true, countries, data: countries });
}

async function getPlans(request: Request) {
  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }

  const country = body.country || body.countryCode || body.code || body.country_code || "";
  if (!country) return errorResponse("Country is required.");

  const data = await pdsboostRequest("esim_plans", { country });
  const plans = extractArray(data, ["plans", "data", "results", "items", "list"]);
  return json({ success: true, country, plans, data: plans });
}

async function pollOrder(orderId: string, maxAttempts = 12) {
  for (let i = 0; i < maxAttempts; i++) {
    const statusData = await pdsboostRequest("status", { order: orderId });
    const qr = statusData.qr || statusData.qr_code || statusData.qrcode || statusData.qrCode || "";
    const lpa = statusData.lpa || statusData.LPA || statusData.activation_code || statusData.activationCode || "";
    const iccid = statusData.iccid || statusData.ICCID || "";
    if (qr || lpa || iccid) return { ...statusData, qr, lpa, iccid, order: orderId };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return await pdsboostRequest("status", { order: orderId });
}

async function buyEsim(request: Request) {
  let body: any = {};
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body."); }

  const packageId = body.package || body.packageId || body.plan || body.planId || body.code || "";
  if (!packageId) return errorResponse("eSIM package is required.");

  const buyData = await pdsboostRequest("esim_buy", { package: packageId });
  const orderId = buyData.order || buyData.order_id || buyData.orderId || buyData.id || "";

  if (!orderId) {
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

  const finalData = await pollOrder(String(orderId));
  return json({
    success: true,
    order: orderId,
    order_id: orderId,
    qr: finalData.qr || finalData.qr_code || finalData.qrcode || finalData.qrCode || "",
    lpa: finalData.lpa || finalData.LPA || finalData.activation_code || "",
    iccid: finalData.iccid || finalData.ICCID || "",
    package: packageId,
    message: finalData.message || "eSIM purchase completed.",
    provider: finalData,
  });
}

// --------------------------------------------------
// PROXIES
// --------------------------------------------------

async function getProxyList() {
  const data = await pdsboostRequest("proxy_list");
  const products = extractArray(data, ["products", "data", "list", "items", "proxies"]);
  return json({ success: true, products, data: products, provider: data });
}

async function buyProxy(request: Request) {
  let body: any = {};
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body."); }

  const product = body.product || body.productId || "";
  const plan = body.plan || body.planId || "";
  const location = body.location || body.country || body.loc || "";
  const quantity = Number(body.quantity || body.qty || 1);

  if (!product) return errorResponse("Product is required.");
  if (!plan) return errorResponse("Plan is required.");
  if (!location) return errorResponse("Location is required.");
  if (quantity < 1) return errorResponse("Quantity must be at least 1.");

  const data = await pdsboostRequest("proxy_buy", { product, plan, location, quantity });

  return json({
    success: true,
    order: data.order || data.order_id || data.orderId || "",
    order_id: data.order_id || data.orderId || data.order || "",
    proxies: data.proxies || data.proxy || data.list || data.data || [],
    message: data.message || "Proxy purchase completed.",
    provider: data,
  });
}

// --------------------------------------------------
// CLUBKONNECT HELPERS
// --------------------------------------------------

function checkClubKonnect() {
  if (!CLUBKONNECT_USER_ID || !CLUBKONNECT_API_KEY) {
    throw new Error("ClubKonnect credentials not configured");
  }
}

// --------------------------------------------------
// AIRTIME
// --------------------------------------------------

async function clubkonnectAirtime(request: Request) {
  checkClubKonnect();

  let body: any = {};
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body."); }

  const { MobileNetwork, Amount, MobileNumber, RequestID } = body;

  if (!MobileNetwork || !Amount || !MobileNumber) {
    return errorResponse("MobileNetwork, Amount and MobileNumber are required");
  }

  const url =
    `https://www.nellobytesystems.com/APIAirtimeV1.asp` +
    `?UserID=${encodeURIComponent(CLUBKONNECT_USER_ID)}` +
    `&APIKey=${encodeURIComponent(CLUBKONNECT_API_KEY)}` +
    `&MobileNetwork=${encodeURIComponent(MobileNetwork)}` +
    `&Amount=${encodeURIComponent(Amount)}` +
    `&MobileNumber=${encodeURIComponent(MobileNumber)}` +
    `&RequestID=${encodeURIComponent(RequestID || Date.now())}`;

  const response = await fetch(url);
  const text = await response.text();

  try {
    return json(JSON.parse(text));
  } catch {
    return errorResponse("Invalid response from ClubKonnect", 502, { raw: text.slice(0, 300) });
  }
}

// --------------------------------------------------
// DATA
// --------------------------------------------------

async function clubkonnectData(request: Request) {
  checkClubKonnect();

  let body: any = {};
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body."); }

  const { MobileNetwork, DataPlan, MobileNumber, RequestID } = body;

  if (!MobileNetwork || !DataPlan || !MobileNumber) {
    return errorResponse("MobileNetwork, DataPlan and MobileNumber are required");
  }

  const url =
    `https://www.nellobytesystems.com/APIDatabundleV1.asp` +
    `?UserID=${encodeURIComponent(CLUBKONNECT_USER_ID)}` +
    `&APIKey=${encodeURIComponent(CLUBKONNECT_API_KEY)}` +
    `&MobileNetwork=${encodeURIComponent(MobileNetwork)}` +
    `&DataPlan=${encodeURIComponent(DataPlan)}` +
    `&MobileNumber=${encodeURIComponent(MobileNumber)}` +
    `&RequestID=${encodeURIComponent(RequestID || Date.now())}`;

  const response = await fetch(url);
  const text = await response.text();

  try {
    return json(JSON.parse(text));
  } catch {
    return errorResponse("Invalid response from ClubKonnect", 502, { raw: text.slice(0, 300) });
  }
}

// --------------------------------------------------
// DATA PLANS
// --------------------------------------------------

async function clubkonnectDataPlans() {
  checkClubKonnect();

  const url =
    `https://www.nellobytesystems.com/APIDatabundlePlansV2.asp` +
    `?UserID=${encodeURIComponent(CLUBKONNECT_USER_ID)}` +
    `&APIKey=${encodeURIComponent(CLUBKONNECT_API_KEY)}`;

  const response = await fetch(url);
  const text = await response.text();

  try {
    return json(JSON.parse(text));
  } catch {
    return errorResponse("Invalid response from ClubKonnect", 502, { raw: text.slice(0, 500) });
  }
}

// --------------------------------------------------
// ELECTRICITY
// --------------------------------------------------

async function clubkonnectElectricity(request: Request) {
  checkClubKonnect();

  let body: any = {};
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body."); }

  const { ElectricCompany, MeterNo, MeterType, Amount, RequestID } = body;

  if (!ElectricCompany || !MeterNo || !MeterType || !Amount) {
    return errorResponse("ElectricCompany, MeterNo, MeterType and Amount are required");
  }

  const url =
    `https://www.nellobytesystems.com/APIElectricityV1.asp` +
    `?UserID=${encodeURIComponent(CLUBKONNECT_USER_ID)}` +
    `&APIKey=${encodeURIComponent(CLUBKONNECT_API_KEY)}` +
    `&ElectricCompany=${encodeURIComponent(ElectricCompany)}` +
    `&MeterNo=${encodeURIComponent(MeterNo)}` +
    `&MeterType=${encodeURIComponent(MeterType)}` +
    `&Amount=${encodeURIComponent(Amount)}` +
    `&RequestID=${encodeURIComponent(RequestID || Date.now())}`;

  const response = await fetch(url);
  const text = await response.text();

  try {
    return json(JSON.parse(text));
  } catch {
    return errorResponse("Invalid response from ClubKonnect", 502, { raw: text.slice(0, 300) });
  }
}

// --------------------------------------------------
// BETTING
// --------------------------------------------------

async function clubkonnectBetting(request: Request) {
  checkClubKonnect();

  let body: any = {};
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body."); }

  const { BettingCompany, CustomerID, Amount, RequestID } = body;

  if (!BettingCompany || !CustomerID || !Amount || !RequestID) {
    return errorResponse("Missing required fields");
  }

  const url =
    `https://www.nellobytesystems.com/APIBettingV1.asp` +
    `?UserID=${encodeURIComponent(CLUBKONNECT_USER_ID)}` +
    `&APIKey=${encodeURIComponent(CLUBKONNECT_API_KEY)}` +
    `&BettingCompany=${encodeURIComponent(BettingCompany)}` +
    `&CustomerID=${encodeURIComponent(CustomerID)}` +
    `&Amount=${encodeURIComponent(Amount)}` +
    `&RequestID=${encodeURIComponent(RequestID)}`;

  const response = await fetch(url);
  const text = await response.text();

  try {
    return json(JSON.parse(text));
  } catch {
    return errorResponse("Invalid response from ClubKonnect", 502, { raw: text.slice(0, 500) });
  }
}

// --------------------------------------------------
// CABLE PACKAGES
// --------------------------------------------------

async function clubkonnectCablePackages(request: Request) {
  checkClubKonnect();

  const urlObj = new URL(request.url);
  const provider = String(urlObj.searchParams.get("provider") || "").toLowerCase();

  if (!provider) {
    return errorResponse("Provider is required");
  }

  const url =
    `https://www.nellobytesystems.com/APICableTVPackagesV2.asp` +
    `?UserID=${encodeURIComponent(CLUBKONNECT_USER_ID)}` +
    `&APIKey=${encodeURIComponent(CLUBKONNECT_API_KEY)}`;

  const response = await fetch(url);
  const text = await response.text();

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return errorResponse("Invalid response from ClubKonnect", 502, { raw: text.slice(0, 500) });
  }

  const providerKeyMap: Record<string, string> = {
    dstv: "DStv",
    gotv: "GOtv",
    startimes: "Startimes",
    startime: "Startimes",
  };

  const key = providerKeyMap[provider] || provider;
  let packages: any[] = [];

  if (data?.TV_ID?.[key] && Array.isArray(data.TV_ID[key])) {
    packages = data.TV_ID[key][0]?.PRODUCT || [];
  }

  const normalized = packages
    .map((pkg) => ({
      code: pkg.PACKAGE_ID || "",
      name: pkg.PACKAGE_NAME || "Unknown Package",
      amount: Number(pkg.PACKAGE_AMOUNT || 0),
    }))
    .filter((pkg) => pkg.code && pkg.amount > 0);

  return json({ packages: normalized });
}

// --------------------------------------------------
// CABLE VERIFY
// --------------------------------------------------

async function clubkonnectCableVerify(request: Request) {
  checkClubKonnect();

  let body: any = {};
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body."); }

  const { CableTV, SmartCardNo } = body;

  if (!CableTV || !SmartCardNo) {
    return errorResponse("CableTV and SmartCardNo are required");
  }

  const url =
    `https://www.nellobytesystems.com/APIVerifyCableTVV1.asp` +
    `?UserID=${encodeURIComponent(CLUBKONNECT_USER_ID)}` +
    `&APIKey=${encodeURIComponent(CLUBKONNECT_API_KEY)}` +
    `&CableTV=${encodeURIComponent(CableTV)}` +
    `&SmartCardNo=${encodeURIComponent(SmartCardNo)}`;

  const response = await fetch(url);
  const text = await response.text();

  try {
    return json(JSON.parse(text));
  } catch {
    return errorResponse("Invalid response from ClubKonnect", 502, {
      customer_name: "INVALID_SMARTCARDNO",
      raw: text.slice(0, 500),
    });
  }
}

// --------------------------------------------------
// CABLE PURCHASE
// --------------------------------------------------

async function clubkonnectCableBuy(request: Request) {
  checkClubKonnect();

  let body: any = {};
  try { body = await request.json(); } catch { return errorResponse("Invalid JSON body."); }

  const { CableTV, Package, SmartCardNo, PhoneNo, RequestID } = body;

  if (!CableTV || !Package || !SmartCardNo || !PhoneNo || !RequestID) {
    return errorResponse("Missing required fields");
  }

  const url =
    `https://www.nellobytesystems.com/APICableTVV1.asp` +
    `?UserID=${encodeURIComponent(CLUBKONNECT_USER_ID)}` +
    `&APIKey=${encodeURIComponent(CLUBKONNECT_API_KEY)}` +
    `&CableTV=${encodeURIComponent(CableTV)}` +
    `&Package=${encodeURIComponent(Package)}` +
    `&SmartCardNo=${encodeURIComponent(SmartCardNo)}` +
    `&PhoneNo=${encodeURIComponent(PhoneNo)}` +
    `&RequestID=${encodeURIComponent(RequestID)}`;

  const response = await fetch(url);
  const text = await response.text();

  try {
    return json(JSON.parse(text));
  } catch {
    return errorResponse("Invalid response from ClubKonnect", 502, { raw: text.slice(0, 500) });
  }
}

// --------------------------------------------------
// HEALTH
// --------------------------------------------------

function healthCheck() {
  return json({
    success: true,
    service: "Trust Social API",
    status: "online",
    hasPdsboostKey: Boolean(PDSBOOST_KEY),
    hasClubKonnect: Boolean(CLUBKONNECT_USER_ID && CLUBKONNECT_API_KEY),
    routes: [
      "GET  /",
      "POST /esim/countries",
      "POST /esim/plans",
      "POST /esim/buy",
      "POST /proxies/list",
      "POST /proxies/buy",
      "POST /airtime",
      "POST /data",
      "GET  /data-plans",
      "POST /electricity",
      "POST /betting",
      "GET  /cable-packages",
      "POST /cable-verify",
      "POST /cable-buy",
    ],
  });
}

// --------------------------------------------------
// SERVER
// --------------------------------------------------

Deno.serve({ port: PORT }, async (request) => {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (request.method === "GET" && url.pathname === "/") {
      return healthCheck();
    }

    // eSIM
    if (request.method === "POST" && url.pathname === "/esim/countries") return await getCountries();
    if (request.method === "POST" && url.pathname === "/esim/plans") return await getPlans(request);
    if (request.method === "POST" && url.pathname === "/esim/buy") return await buyEsim(request);

    // Proxies
    if (request.method === "POST" && url.pathname === "/proxies/list") return await getProxyList();
    if (request.method === "POST" && url.pathname === "/proxies/buy") return await buyProxy(request);

    // ClubKonnect
    if (request.method === "POST" && url.pathname === "/airtime") return await clubkonnectAirtime(request);
    if (request.method === "POST" && url.pathname === "/data") return await clubkonnectData(request);
    if (request.method === "GET"  && url.pathname === "/data-plans") return await clubkonnectDataPlans();
    if (request.method === "POST" && url.pathname === "/electricity") return await clubkonnectElectricity(request);
    if (request.method === "POST" && url.pathname === "/betting") return await clubkonnectBetting(request);
    if (request.method === "GET"  && url.pathname === "/cable-packages") return await clubkonnectCablePackages(request);
    if (request.method === "POST" && url.pathname === "/cable-verify") return await clubkonnectCableVerify(request);
    if (request.method === "POST" && url.pathname === "/cable-buy") return await clubkonnectCableBuy(request);

    return errorResponse("Route not found.", 404);
  } catch (error) {
    console.error("Server error:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      502,
    );
  }
});
