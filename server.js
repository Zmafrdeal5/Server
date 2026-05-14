const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors()); // Accept all frontend origins
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Config ───────────────────────────────────────────────────────────────────
const GENESYSPAY_PRIVATE_KEY = process.env.GENESYSPAY_PRIVATE_KEY || "sk_3nNRNAFg81nR61tHAag58eLDWaBEbfX6OraZ2c1isQspx5uwcbuD4WOHEJdvynNe";
const GENESYSPAY_BASE_URL = "https://genesyspay.com/api/v2";
const CALLBACK_URL = process.env.CALLBACK_URL || "https://yourserver.com/webhook";

// ─── Country / Method Map ─────────────────────────────────────────────────────
const COUNTRY_CONFIG = {
  ZM: {
    name: "Zambia",
    currency: "ZMW",
    channel: "mobile_money",
    methods: {
      airtel: "Airtel",
      mtn: "MTN",
      zamtel: "Zamtel",
    },
  },
  CD: {
    name: "Democratic Republic of Congo",
    currency: "CDF",
    channel: "mobile_money",
    methods: {
      mpesa: "M-Pesa",
      airtel: "Airtel",
      orange: "Orange",
      afrimoney: "Afrimoney",
    },
  },
};

// ─── Phone number format hints per country ────────────────────────────────────
const PHONE_HINTS = {
  ZM: "Zambian numbers should start with 260 followed by 9 digits (e.g. 260773317519).",
  CD: "DRC numbers should start with 243 followed by 9 digits (e.g. 243971234567).",
};

// ─── In-memory receipt store ──────────────────────────────────────────────────
// In production, replace with a persistent database
const receipts = {};

// ─── Helper: Build receipt object ─────────────────────────────────────────────
function buildReceipt({
  tx_ref,
  transaction_id,
  status,
  amount,
  fee,
  total_amount,
  currency,
  country,
  method,
  phone_number,
  beneficiary_name,
  beneficiary_email,
  message,
  error_code,
  failure_reason,
  account_balance,
  timestamp,
}) {
  return {
    receipt: {
      tx_ref,
      transaction_id: transaction_id || null,
      status,
      amount,
      fee: fee || null,
      total_amount: total_amount || null,
      currency,
      country,
      method,
      phone_number,
      beneficiary_name,
      beneficiary_email: beneficiary_email || null,
      message,
      error_code: error_code || null,
      failure_reason: failure_reason || null,
      account_balance: account_balance || null,
      timestamp: timestamp || new Date().toISOString(),
    },
  };
}

// ─── Helper: Map API error codes to user-friendly messages ───────────────────
function friendlyError(errorCode, httpStatus, apiMessage) {
  const map = {
    VALIDATION_ERROR:      "The request was invalid. Please check your inputs and try again.",
    INVALID_CURRENCY:      "The currency is not supported for this country.",
    INVALID_COUNTRY:       "The country code is not supported.",
    METHOD_NOT_AVAILABLE:  "The selected payment method is not available for this country or currency.",
    AMOUNT_OUT_OF_LIMITS:  "The amount is outside the allowed limits for this payment method.",
    INVALID_ARGUMENT:      "A duplicate transaction reference was detected or the request data is invalid.",
    PAYMENT_FAILED:        "The payout failed. This is usually due to insufficient funds in the merchant wallet or a provider error.",
    PROVIDER_ERROR:        "The payment provider returned an error. Please try again shortly.",
    INTERNAL_ERROR:        "An internal error occurred on the payment gateway. Please try again later.",
    MISSING_TOKEN:         "Payment service authentication failed. Please contact support.",
    INVALID_TOKEN:         "Payment service authentication failed. Please contact support.",
    IP_NOT_ALLOWED:        "This server is not authorised to process payouts. Please contact support.",
    RATE_LIMITED:          "Too many requests. Please wait a moment and try again.",
  };
  return map[errorCode] || apiMessage || "An unexpected error occurred. Please try again.";
}

// ─── GET /api/countries ───────────────────────────────────────────────────────
// Returns supported countries and their payout methods
app.get("/api/countries", (req, res) => {
  const result = Object.entries(COUNTRY_CONFIG).map(([code, cfg]) => ({
    code,
    name: cfg.name,
    currency: cfg.currency,
    phone_hint: PHONE_HINTS[code] || "",
    methods: Object.entries(cfg.methods).map(([slug, label]) => ({ slug, label })),
  }));
  res.json({ status: "success", data: result });
});

// ─── POST /api/payout ─────────────────────────────────────────────────────────
// Initiates a payout (sends money to a mobile money wallet)
app.post("/api/payout", async (req, res) => {
  const {
    country,
    method,
    phone_number,
    amount,
    beneficiary_name,
    beneficiary_email,
  } = req.body;

  // ── Validate inputs ──
  const validationErrors = {};

  if (!country) {
    validationErrors.country = "Country is required.";
  }
  if (!method) {
    validationErrors.method = "Payment method is required.";
  }
  if (!phone_number || String(phone_number).trim() === "") {
    validationErrors.phone_number = "Phone number is required.";
  }
  if (!amount || isNaN(amount) || Number(amount) < 0.01) {
    validationErrors.amount = "A valid amount of at least 0.01 is required.";
  }
  if (!beneficiary_name || String(beneficiary_name).trim() === "") {
    validationErrors.beneficiary_name = "Beneficiary name is required.";
  }
  if (beneficiary_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(beneficiary_email)) {
    validationErrors.beneficiary_email = "Beneficiary email is not a valid email address.";
  }

  const config = COUNTRY_CONFIG[country];
  if (country && !config) {
    validationErrors.country = `Unsupported country code: ${country}. Supported: ${Object.keys(COUNTRY_CONFIG).join(", ")}.`;
  }
  if (config && method && !config.methods[method]) {
    validationErrors.method = `Unsupported method '${method}' for ${config.name}. Supported: ${Object.keys(config.methods).join(", ")}.`;
  }

  if (Object.keys(validationErrors).length > 0) {
    return res.status(422).json({
      status: "error",
      message: "Validation failed. Please correct the errors below.",
      errors: validationErrors,
    });
  }

  // ── Build unique transaction reference ──
  const tx_ref = `PO-${country}-${Date.now()}-${uuidv4().split("-")[0].toUpperCase()}`;

  // ── Call GenesysPay Payout API ──
  try {
    const payload = {
      amount: Number(amount),
      currency: config.currency,
      country,
      channel: config.channel,
      method,
      phone_number: String(phone_number).trim(),
      beneficiary_name: String(beneficiary_name).trim(),
      tx_ref,
      callback_url: CALLBACK_URL,
    };

    if (beneficiary_email) {
      payload.beneficiary_email = String(beneficiary_email).trim();
    }

    const response = await axios.post(`${GENESYSPAY_BASE_URL}/payouts`, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GENESYSPAY_PRIVATE_KEY}`,
      },
      timeout: 30000,
    });

    const apiData = response.data?.data || {};

    // ── Store a submitted receipt ──
    const receipt = buildReceipt({
      tx_ref,
      transaction_id: apiData.transaction_id || null,
      status: "submitted",
      amount: apiData.amount || String(amount),
      fee: apiData.fee || null,
      total_amount: apiData.total_amount || null,
      currency: apiData.currency || config.currency,
      country: config.name,
      method: config.methods[method],
      phone_number: String(phone_number).trim(),
      beneficiary_name: String(beneficiary_name).trim(),
      beneficiary_email: beneficiary_email || null,
      message: apiData.summary || "Payout submitted. Funds will be sent to the beneficiary shortly.",
      account_balance: apiData.account_balance || null,
      timestamp: apiData.created_at || new Date().toISOString(),
    });

    receipts[tx_ref] = receipt.receipt;

    return res.status(200).json({
      status: "success",
      message: "Payout initiated successfully. The funds are being sent to the beneficiary.",
      api_status: apiData.status || "SUBMITTED",
      ...receipt,
    });

  } catch (err) {
    const apiError = err.response?.data;
    const httpStatus = err.response?.status || 500;

    let errorCode = apiError?.error_code || err.code || "SERVER_ERROR";
    if (httpStatus === 429) errorCode = "RATE_LIMITED";

    const userMessage = friendlyError(errorCode, httpStatus, apiError?.message);

    const receipt = buildReceipt({
      tx_ref,
      transaction_id: null,
      status: "failed",
      amount,
      currency: config?.currency || "N/A",
      country: config?.name || country,
      method: config?.methods?.[method] || method,
      phone_number: String(phone_number).trim(),
      beneficiary_name: String(beneficiary_name || "").trim(),
      beneficiary_email: beneficiary_email || null,
      message: userMessage,
      error_code: errorCode,
      timestamp: new Date().toISOString(),
    });

    receipts[tx_ref] = receipt.receipt;

    return res.status(httpStatus < 500 ? httpStatus : 502).json({
      status: "error",
      message: userMessage,
      error_code: errorCode,
      errors: apiError?.errors || null,
      note: "If this error persists, please contact support with the tx_ref below.",
      ...receipt,
    });
  }
});

// ─── GET /api/payout/:identifier ─────────────────────────────────────────────
// Fetch live payout status from GenesysPay by transaction_id
app.get("/api/payout/:identifier", async (req, res) => {
  const { identifier } = req.params;

  try {
    const response = await axios.get(`${GENESYSPAY_BASE_URL}/payouts/${encodeURIComponent(identifier)}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GENESYSPAY_PRIVATE_KEY}`,
      },
      timeout: 15000,
    });

    const apiData = response.data?.data || {};

    // ── Sync local receipt if we have it ──
    const tx_ref = apiData.tx_ref;
    if (tx_ref && receipts[tx_ref]) {
      receipts[tx_ref].status = mapApiStatus(apiData.status);
      receipts[tx_ref].transaction_id = apiData.transaction_id || receipts[tx_ref].transaction_id;
      receipts[tx_ref].fee = apiData.fee || receipts[tx_ref].fee;
      receipts[tx_ref].total_amount = apiData.total_amount || receipts[tx_ref].total_amount;
      receipts[tx_ref].failure_reason = apiData.failure_reason || null;
      receipts[tx_ref].message = summariseStatus(apiData.status, apiData.summary);
    }

    return res.json({
      status: "success",
      data: apiData,
      local_receipt: tx_ref ? receipts[tx_ref] || null : null,
    });

  } catch (err) {
    const apiError = err.response?.data;
    return res.status(err.response?.status || 500).json({
      status: "error",
      message: apiError?.message || "Failed to fetch payout transaction.",
      error_code: apiError?.error_code || "FETCH_FAILED",
      note: "Verify the transaction ID is correct and the API key is valid.",
    });
  }
});

// ─── GET /api/payout/ref/:txRef ───────────────────────────────────────────────
// Fetch live payout status from GenesysPay by your tx_ref
app.get("/api/payout/ref/:txRef", async (req, res) => {
  const { txRef } = req.params;

  try {
    const response = await axios.get(`${GENESYSPAY_BASE_URL}/payouts/status/${encodeURIComponent(txRef)}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GENESYSPAY_PRIVATE_KEY}`,
      },
      timeout: 15000,
    });

    const apiData = response.data?.data || {};

    // ── Sync local receipt if we have it ──
    if (txRef && receipts[txRef]) {
      receipts[txRef].status = mapApiStatus(apiData.status);
      receipts[txRef].transaction_id = apiData.transaction_id || receipts[txRef].transaction_id;
      receipts[txRef].fee = apiData.fee || receipts[txRef].fee;
      receipts[txRef].total_amount = apiData.total_amount || receipts[txRef].total_amount;
      receipts[txRef].failure_reason = apiData.failure_reason || null;
      receipts[txRef].message = summariseStatus(apiData.status, apiData.summary);
    }

    return res.json({
      status: "success",
      data: apiData,
      local_receipt: receipts[txRef] || null,
    });

  } catch (err) {
    const apiError = err.response?.data;
    return res.status(err.response?.status || 500).json({
      status: "error",
      message: apiError?.message || "Failed to fetch payout by reference.",
      error_code: apiError?.error_code || "FETCH_FAILED",
      note: "Verify the tx_ref is correct and belongs to this API key.",
    });
  }
});

// ─── GET /api/payouts ─────────────────────────────────────────────────────────
// List payout transactions from GenesysPay with optional filters
app.get("/api/payouts", async (req, res) => {
  const { status, per_page = 20, page = 1 } = req.query;

  const validStatuses = ["PENDING", "SUBMITTED", "SUCCESS", "FAILED", "CANCELLED"];
  if (status && !validStatuses.includes(status.toUpperCase())) {
    return res.status(422).json({
      status: "error",
      message: `Invalid status filter '${status}'. Valid values: ${validStatuses.join(", ")}.`,
      error_code: "VALIDATION_ERROR",
    });
  }

  const perPageNum = Math.min(Math.max(parseInt(per_page) || 20, 1), 100);
  const pageNum = Math.max(parseInt(page) || 1, 1);

  try {
    const params = new URLSearchParams({ per_page: perPageNum, page: pageNum });
    if (status) params.set("status", status.toUpperCase());

    const response = await axios.get(`${GENESYSPAY_BASE_URL}/payouts?${params.toString()}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GENESYSPAY_PRIVATE_KEY}`,
      },
      timeout: 15000,
    });

    return res.json({
      status: "success",
      data: response.data?.data || [],
      meta: response.data?.meta || null,
    });

  } catch (err) {
    const apiError = err.response?.data;
    return res.status(err.response?.status || 500).json({
      status: "error",
      message: apiError?.message || "Failed to retrieve payout list.",
      error_code: apiError?.error_code || "LIST_FAILED",
    });
  }
});

// ─── GET /api/receipt/:tx_ref ─────────────────────────────────────────────────
// Fetch a locally stored receipt by tx_ref (fast, no API call)
app.get("/api/receipt/:tx_ref", (req, res) => {
  const { tx_ref } = req.params;
  const receipt = receipts[tx_ref];

  if (!receipt) {
    return res.status(404).json({
      status: "error",
      message: `No receipt found for transaction reference: ${tx_ref}`,
      error_code: "RECEIPT_NOT_FOUND",
      note: "Receipts are stored in memory for this server session only. If the server restarted, use /api/payout/ref/:txRef to query GenesysPay directly.",
    });
  }

  return res.json({ status: "success", receipt });
});

// ─── POST /webhook ────────────────────────────────────────────────────────────
// Receives final payout status from GenesysPay
// Respond with HTTP 200 within 10 seconds to prevent retries
app.post("/webhook", (req, res) => {
  const payload = req.body;

  console.log("[Webhook] Received event:", payload?.event);
  console.log("[Webhook] Payload:", JSON.stringify(payload, null, 2));

  const event = payload?.event;
  const data = payload?.data || {};
  const tx_ref = data?.tx_ref;
  const transaction_id = data?.transaction_id;
  const apiStatus = data?.status;
  const failureReason = data?.failure_reason || null;
  const summary = data?.summary || null;

  if (tx_ref && receipts[tx_ref]) {
    switch (event) {
      case "payout.successful":
        receipts[tx_ref].status = "success";
        receipts[tx_ref].message = summary || "Payout completed successfully. Funds have been sent to the beneficiary.";
        receipts[tx_ref].failure_reason = null;
        break;
      case "payout.failed":
        receipts[tx_ref].status = "failed";
        receipts[tx_ref].message = failureReason
          ? `Payout failed: ${failureReason}`
          : "Payout failed. Please check the failure reason and try again.";
        receipts[tx_ref].failure_reason = failureReason;
        break;
      default:
        receipts[tx_ref].status = mapApiStatus(apiStatus);
        receipts[tx_ref].message = summary || summariseStatus(apiStatus);
    }

    receipts[tx_ref].transaction_id = transaction_id || receipts[tx_ref].transaction_id;
    receipts[tx_ref].fee = data?.fee || receipts[tx_ref].fee;
    receipts[tx_ref].total_amount = data?.total_amount || receipts[tx_ref].total_amount;
    receipts[tx_ref].account_balance = data?.account_balance || receipts[tx_ref].account_balance;

    console.log(`[Webhook] Receipt updated: tx_ref=${tx_ref} → status=${receipts[tx_ref].status}`);
  } else {
    console.warn(`[Webhook] No local receipt for tx_ref=${tx_ref}. Ignoring.`);
  }

  // Always acknowledge immediately with 200
  res.status(200).json({ status: "success", message: "Webhook received." });
});

// ─── Helper: Map GenesysPay status to local status ───────────────────────────
function mapApiStatus(apiStatus) {
  switch ((apiStatus || "").toUpperCase()) {
    case "SUCCESS":    return "success";
    case "FAILED":     return "failed";
    case "CANCELLED":  return "cancelled";
    case "SUBMITTED":  return "submitted";
    case "PENDING":
    default:           return "pending";
  }
}

// ─── Helper: Human-readable status message ────────────────────────────────────
function summariseStatus(apiStatus, summary) {
  if (summary) return summary;
  switch ((apiStatus || "").toUpperCase()) {
    case "SUCCESS":   return "Payout completed successfully. Funds have been sent.";
    case "FAILED":    return "Payout failed. Please check the failure reason.";
    case "CANCELLED": return "Payout was cancelled.";
    case "SUBMITTED": return "Payout submitted to provider. Awaiting confirmation.";
    case "PENDING":
    default:          return "Payout is pending processing.";
  }
}

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: `Route ${req.method} ${req.path} not found.`,
    error_code: "ROUTE_NOT_FOUND",
    available_endpoints: [
      "GET  /api/countries                — list supported countries and methods",
      "POST /api/payout                   — initiate a payout",
      "GET  /api/payout/:identifier       — get payout by transaction_id",
      "GET  /api/payout/ref/:txRef        — get payout by tx_ref",
      "GET  /api/payouts                  — list payouts (query: status, per_page, page)",
      "GET  /api/receipt/:tx_ref          — fetch locally stored receipt",
      "POST /webhook                      — GenesysPay webhook callback",
    ],
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[Server Error]", err);
  res.status(500).json({
    status: "error",
    message: "An internal server error occurred.",
    error_code: "INTERNAL_ERROR",
    note: "Please try again. If the problem persists, contact support.",
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nGenesysPay Payout Server running on port ${PORT}`);
  console.log(`Supported countries: Zambia (ZM/ZMW), DR Congo (CD/CDF)`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /api/countries                — list supported countries and methods`);
  console.log(`  POST /api/payout                   — initiate a payout`);
  console.log(`  GET  /api/payout/:identifier       — get payout by transaction_id`);
  console.log(`  GET  /api/payout/ref/:txRef        — get payout by tx_ref`);
  console.log(`  GET  /api/payouts                  — list payouts (?status=&per_page=&page=)`);
  console.log(`  GET  /api/receipt/:tx_ref          — fetch locally stored receipt`);
  console.log(`  POST /webhook                      — GenesysPay webhook receiver\n`);
});
