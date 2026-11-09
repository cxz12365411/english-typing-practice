import type { AppEnvironment } from "./config.js";
import path from "node:path";

export type PaymentConfig = { mode: "disabled" } | {
  mode: "sandbox" | "live";
  appId: string;
  sellerId: string;
  privateKeyPath: string;
  alipayPublicKeyPath: string;
};

export function loadPaymentConfig(env: NodeJS.ProcessEnv, environment: AppEnvironment): PaymentConfig {
  const mode = env.PAYMENT_MODE?.trim() || "disabled";
  if (mode === "disabled") return { mode };
  if (mode !== "sandbox" && mode !== "live") throw new Error("PAYMENT_MODE must be disabled, sandbox, or live");
  if (mode === "sandbox" && environment === "production") throw new Error("Sandbox payments are not allowed in production");
  if (mode === "live" && environment !== "production") throw new Error("Live payments require NODE_ENV=production");
  const appId = env.ALIPAY_APP_ID?.trim() || "";
  const sellerId = env.ALIPAY_SELLER_ID?.trim() || "";
  if (!/^\d{16}$/.test(appId) || !/^\d{16}$/.test(sellerId)) throw new Error("ALIPAY_APP_ID and ALIPAY_SELLER_ID must be 16 digits");
  const privateKeyPath = env.ALIPAY_PRIVATE_KEY_PATH?.trim() || "";
  const alipayPublicKeyPath = env.ALIPAY_PUBLIC_KEY_PATH?.trim() || "";
  if (!path.isAbsolute(privateKeyPath) || !path.isAbsolute(alipayPublicKeyPath)) {
    throw new Error("Alipay key paths must be absolute paths outside the public website");
  }
  return { mode, appId, sellerId, privateKeyPath, alipayPublicKeyPath };
}
