import { createPrivateKey, createPublicKey } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { AlipaySdk } from "alipay-sdk";
import type { AppEnvironment } from "./config.js";
import type { PaymentConfig } from "./payment-config.js";

export const ALIPAY_NOTIFY_PATH = "/api/payments/alipay/notify";
export type PaymentMode = "disabled" | "sandbox" | "live" | "test";
export interface PaymentOrderInput { id: string; amountFen: number; expiresAt: number }
export interface VerifiedPayment {
  appId: string; sellerId: string; orderId: string; tradeNo: string;
  amountFen: number; status: "pending" | "paid" | "closed";
}
export interface PaymentProvider {
  readonly kind: "alipay" | "disabled" | "test";
  readonly mode: PaymentMode;
  readonly appId: string;
  readonly sellerId: string;
  paymentUrl(order: PaymentOrderInput): string;
  verifyNotification(fields: Record<string, string>): VerifiedPayment | null;
  query(orderId: string): Promise<VerifiedPayment | null>;
}

export function amountToFen(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function status(value: unknown): VerifiedPayment["status"] | null {
  if (value === "TRADE_SUCCESS" || value === "TRADE_FINISHED") return "paid";
  if (value === "WAIT_BUYER_PAY") return "pending";
  if (value === "TRADE_CLOSED") return "closed";
  return null;
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Empty Alipay response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 131_072) { await reader.cancel(); throw new Error("Alipay response is too large"); }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

function keyFile(file: string, privateKey: boolean, environment: AppEnvironment): string {
  if (environment === "production") {
    const protectedRoot = "/etc/english-typing-practice";
    if (!path.resolve(file).startsWith(`${protectedRoot}/`) || realpathSync(file) !== path.resolve(file)) {
      throw new Error("Production Alipay keys must reside directly within the protected /etc/english-typing-practice directory tree");
    }
    // A root-owned file inside a writable directory could still be replaced.
    for (let directory = path.dirname(file); directory.startsWith(protectedRoot); directory = path.dirname(directory)) {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        throw new Error("Production Alipay key directories must be root-owned and not writable by group or others");
      }
    }
  }
  const info = lstatSync(file);
  const forbiddenMode = privateKey ? 0o027 : 0o022;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768 || (info.mode & forbiddenMode) !== 0
    || (environment === "production" && info.uid !== 0)) {
    throw new Error("Alipay key must be a regular protected PEM file");
  }
  const pem = readFileSync(file, "utf8");
  const parsed = privateKey ? createPrivateKey(pem) : createPublicKey(pem);
  if (parsed.asymmetricKeyType !== "rsa" || (parsed.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error("Alipay RSA2 requires RSA keys of at least 2048 bits");
  }
  return pem;
}

/** Direct merchant, public-key mode. Secrets never enter URLs returned by this app. */
export function createPaymentProvider(config: PaymentConfig, appOrigin: string, environment: AppEnvironment): PaymentProvider {
  if (config.mode === "disabled") return {
    kind: "disabled", mode: "disabled", appId: "", sellerId: "",
    paymentUrl() { throw new Error("Payments disabled"); },
    verifyNotification() { return null; },
    async query() { return null; }
  };
  if (config.mode === "sandbox" && environment === "production") throw new Error("Sandbox payments are not allowed in production");
  if (config.mode === "live" && environment !== "production") throw new Error("Live payments require production environment");
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.origin !== appOrigin) throw new Error("Alipay requires a bare HTTPS app origin");
  const privateKey = keyFile(config.privateKeyPath, true, environment);
  const alipayPublicKey = keyFile(config.alipayPublicKeyPath, false, environment);
  const gateway = config.mode === "live" ? "https://openapi.alipay.com/gateway.do" : "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
  const sdk = new AlipaySdk({
    appId: config.appId, privateKey, alipayPublicKey, signType: "RSA2",
    keyType: privateKey.includes("BEGIN RSA PRIVATE KEY") ? "PKCS1" : "PKCS8",
    gateway, camelcase: false, timeout: 8_000
  });
  return {
    kind: "alipay", mode: config.mode, appId: config.appId, sellerId: config.sellerId,
    paymentUrl(order) {
      const remainingMinutes = Math.max(1, Math.ceil((order.expiresAt - Date.now()) / 60_000));
      return sdk.pageExec("alipay.trade.page.pay", "GET", {
        notifyUrl: `${appOrigin}${ALIPAY_NOTIFY_PATH}`,
        returnUrl: `${appOrigin}/membership?order=${encodeURIComponent(order.id)}`,
        bizContent: {
          outTradeNo: order.id, productCode: "FAST_INSTANT_TRADE_PAY",
          totalAmount: (order.amountFen / 100).toFixed(2), sellerId: config.sellerId,
          subject: "英语打字练习会员 · 30 天", timeoutExpress: `${remainingMinutes}m`
        }
      });
    },
    verifyNotification(fields) {
      if (fields.sign_type !== "RSA2" || fields.app_id !== config.appId || fields.seller_id !== config.sellerId) return null;
      if (fields.currency !== undefined && fields.currency !== "CNY") return null;
      if (fields.notify_type !== "trade_status_sync") return null;
      try { if (!sdk.checkNotifySignV2(fields)) return null; } catch { return null; }
      const amountFen = amountToFen(fields.total_amount);
      const tradeStatus = status(fields.trade_status);
      if (amountFen === null || !tradeStatus || !fields.out_trade_no || !/^\d{10,64}$/.test(fields.trade_no ?? "")) return null;
      return { appId: config.appId, sellerId: config.sellerId, orderId: fields.out_trade_no,
        tradeNo: fields.trade_no!, amountFen, status: tradeStatus };
    },
    async query(orderId) {
      // Keep official SDK signing/verification while using a transport that refuses
      // redirects. SDK 4.14's urllib transport follows them by default (GHSA-hq3h-
      // g68c-hp78), and offers no per-exec override for followRedirect.
      const signed = new URL(sdk.pageExec("alipay.trade.query", "GET", { bizContent: { outTradeNo: orderId } }));
      const response = await fetch(gateway, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(8_000),
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", accept: "application/json" },
        body: signed.searchParams
      });
      if (!response.ok) throw new Error("Alipay query transport unavailable");
      const raw = await boundedResponseText(response);
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      const responseKey = "alipay_trade_query_response";
      if (typeof envelope.sign !== "string" || !envelope[responseKey] || typeof envelope[responseKey] !== "object") {
        throw new Error("Unsigned or malformed Alipay query response");
      }
      sdk.checkResponseSign(raw, responseKey, envelope.sign, "");
      const result = envelope[responseKey] as Record<string, unknown>;
      if (result.code === "40004" && result.sub_code === "ACQ.TRADE_NOT_EXIST") return null;
      if (result.code !== "10000") throw new Error("Alipay query unavailable");
      const amountFen = amountToFen(result.total_amount);
      const tradeStatus = status(result.trade_status);
      if (result.out_trade_no !== orderId || amountFen === null || !tradeStatus || !/^\d{10,64}$/.test(String(result.trade_no ?? ""))) {
        throw new Error("Alipay query response mismatch");
      }
      // Query results do not always contain merchant identifiers. The authenticated,
      // signed direct-merchant query is bound to this app; no delegated token is used.
      if ((result.app_id && result.app_id !== config.appId) || (result.seller_id && result.seller_id !== config.sellerId)
        || (result.currency && result.currency !== "CNY")) throw new Error("Alipay merchant mismatch");
      return { appId: config.appId, sellerId: config.sellerId, orderId,
        tradeNo: String(result.trade_no), amountFen, status: tradeStatus };
    }
  };
}
