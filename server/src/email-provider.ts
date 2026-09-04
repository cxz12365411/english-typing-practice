import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import type { AppEnvironment, EmailDeliveryConfig } from "./config.js";

export type EmailCodePurpose = "register" | "login" | "reset_password" | "bind_email";

export interface VerificationEmail {
  to: string;
  code: string;
  purpose: EmailCodePurpose;
  expiresAt: number;
}

export interface EmailProvider {
  readonly enabled: boolean;
  readonly kind: "disabled" | "smtp" | "test";
  sendVerificationCode(message: VerificationEmail): Promise<void>;
  close?(): Promise<void>;
}

export class DisabledEmailProvider implements EmailProvider {
  readonly enabled = false;
  readonly kind = "disabled" as const;

  async sendVerificationCode(): Promise<void> {
    throw new Error("Email delivery is disabled");
  }
}

function purposeCopy(purpose: EmailCodePurpose): string {
  switch (purpose) {
    case "register": return "注册账号";
    case "login": return "登录账号";
    case "reset_password": return "重置密码";
    case "bind_email": return "绑定邮箱";
  }
}

export class SmtpEmailProvider implements EmailProvider {
  readonly enabled = true;
  readonly kind = "smtp" as const;
  private readonly transporter: Transporter;

  constructor(private readonly config: Extract<EmailDeliveryConfig, { mode: "smtp" }>) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: 465,
      secure: true,
      auth: { user: config.username, pass: config.password },
      tls: { minVersion: "TLSv1.2", servername: config.host },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true
    });
  }

  async sendVerificationCode(message: VerificationEmail): Promise<void> {
    const action = purposeCopy(message.purpose);
    const expiresMinutes = Math.max(1, Math.round((message.expiresAt - Date.now()) / 60_000));
    await this.transporter.sendMail({
      from: { name: this.config.fromName, address: this.config.fromAddress },
      to: message.to,
      subject: `英语打字练习：${action}验证码`,
      text: `你正在${action}。验证码：${message.code}\n\n验证码将在 ${expiresMinutes} 分钟后失效，请勿转发给他人。若非本人操作，请忽略本邮件。`,
      html: [
        "<p>你正在" + action + "。</p>",
        '<p style="font-size:28px;font-weight:700;letter-spacing:6px">' + message.code + "</p>",
        `<p>验证码将在 ${expiresMinutes} 分钟后失效，请勿转发给他人。</p>`,
        "<p>若非本人操作，请忽略本邮件。</p>"
      ].join("")
    });
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

export class FileTestEmailProvider implements EmailProvider {
  readonly enabled = true;
  readonly kind = "test" as const;

  constructor(private readonly outboxFile: string) {}

  async sendVerificationCode(message: VerificationEmail): Promise<void> {
    mkdirSync(dirname(this.outboxFile), { recursive: true, mode: 0o700 });
    appendFileSync(this.outboxFile, `${JSON.stringify({ ...message, capturedAt: Date.now() })}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    chmodSync(this.outboxFile, 0o600);
  }
}

export function createEmailProvider(config: EmailDeliveryConfig, environment: AppEnvironment): EmailProvider {
  if (config.mode === "disabled") return new DisabledEmailProvider();
  if (config.mode === "smtp") return new SmtpEmailProvider(config);
  if (environment !== "test") throw new Error("The test email provider is permitted only when NODE_ENV=test");
  return new FileTestEmailProvider(config.outboxFile);
}
