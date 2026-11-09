import { api } from "./api";
import { accountMarkup, bindAccountSecurity } from "./account-security";
import type { MembershipResponse, PageContext, PaymentOrder, PaymentResponse } from "./types";
import { errorMarkup, mustElement, setBusy } from "./ui";
import { escapeHtml, getErrorMessage } from "./utils";

let generation = 0;
let pollTimer: number | undefined;
let account: ReturnType<typeof bindAccountSecurity> | null = null;
export function disposeMembership(): void {
  generation += 1;
  window.clearTimeout(pollTimer);
  pollTimer = undefined;
  account?.destroy();
  account = null;
}
export function membershipLabel(member: MembershipResponse): string {
  if (!member.enabled) return "当前免费开放";
  return { disabled: "当前免费开放", admin: "管理员 · 无需购买", legacy_free: "原有账号 · 持续免费", trial: "24 小时试用中", active: "会员有效", expired: "试用或会员已到期" }[member.access.status];
}
export function displayDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}
/** Only official checkout hosts are permitted; a return URL never grants access. */
export function safePaymentUrl(value: string | null, mode: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const allowed = mode === "live" ? ["openapi.alipay.com"] : mode === "sandbox" ? ["openapi-sandbox.dl.alipaydev.com", "openapi.alipaydev.com"] : [];
    return url.protocol === "https:" && !url.username && !url.password && allowed.includes(url.hostname) && url.port === "" ? url.href : null;
  } catch { return null; }
}
function statusLabel(order: PaymentOrder): string {
  return { pending: "等待付款", paid: "支付成功", closed: "订单已关闭", expired: "支付链接已过期" }[order.status];
}
function historyMarkup(raw: Record<string, unknown>): string {
  const totals = raw.totals as Record<string, unknown> | undefined;
  const count = (key: string) => typeof totals?.[key] === "number" ? Number(totals[key]) : 0;
  const recent = Array.isArray(raw.recentSessions) ? raw.recentSessions as Array<Record<string, unknown>> : [];
  return `<section class="panel"><div class="panel-body"><h2>学习记录</h2><p class="muted">账号和已同步的学习记录会一直保留。</p>
    <div class="membership-stats"><div><strong>${count("sessions")}</strong><span>练习轮次</span></div><div><strong>${count("attempts")}</strong><span>累计答题</span></div><div><strong>${count("correct")}</strong><span>正确答题</span></div><div><strong>${count("mistakes")}</strong><span>错题数量</span></div></div>
    ${recent.length ? `<details><summary>最近练习</summary><ul class="membership-history">${recent.map(row => `<li><span>${escapeHtml(displayDate(typeof row.startedAt === "string" ? row.startedAt : null))}</span><span>${Number(row.totalAttempts) || 0} 次答题</span></li>`).join("")}</ul></details>` : '<p class="helper">还没有练习记录。</p>'}</div></section>`;
}
export async function renderMembership(context: PageContext): Promise<void> {
  disposeMembership();
  const seq = generation;
  const active = () => generation === seq;
  context.renderShell('<section class="panel"><div class="panel-body"><h1>会员与记录</h1><p>正在读取账号状态…</p></div></section>', "/membership");
  try {
    const [member, summary] = await Promise.all([api.membership(), api.summary()]);
    if (!active()) return;
    let currentMember = member;
    let creating = false;
    let orderResponse: PaymentResponse | null = null;
    let orderId = new URLSearchParams(location.search).get("order");
    if (orderId && !/^[a-zA-Z0-9_-]{1,100}$/.test(orderId)) orderId = null;
    const canBuy = () => currentMember.enabled && currentMember.paymentEnabled && !["admin", "legacy_free", "disabled"].includes(currentMember.access.status);
    context.renderShell(`<main class="membership-page"><div class="page-title"><div><h1>会员与记录</h1><p>${member.enabled ? "一次开通 30 天，自主续费，不自动扣款。" : "查看账号状态和学习记录。"}</p></div></div>
      <section class="panel"><div class="panel-body form-stack"><div><span class="eyebrow">当前账号</span><h2 id="membershipStatus"></h2><p class="muted" id="membershipExpiry"></p></div>
        <div id="membershipOffer"></div><div class="button-row"><button class="btn primary" id="createMembershipOrder" type="button">支付宝开通 · 1 元／30 天</button><button class="btn" id="membershipPractice" type="button">返回练习</button><button class="btn" id="membershipRefresh" type="button">刷新状态</button></div>
        <div id="membershipMessage" class="message info" role="status" aria-live="polite" hidden></div><div id="paymentOrder" class="membership-order" hidden></div>
      </div></section>
      ${historyMarkup(summary)}
      <section class="panel"><div class="panel-body"><h2>购买记录</h2><div id="membershipOrders" class="membership-history">正在读取…</div></div></section>
      ${accountMarkup(context.user, context.capabilities.emailAuthEnabled)}
    </main>`, "/membership");
    account = bindAccountSecurity(context);
    const create = mustElement<HTMLButtonElement>("#createMembershipOrder");
    const message = mustElement<HTMLElement>("#membershipMessage");
    const paintMember = () => {
      mustElement("#membershipStatus").textContent = membershipLabel(currentMember);
      mustElement("#membershipExpiry").textContent = currentMember.enabled && currentMember.access.expiresAt ? `有效期至 ${displayDate(currentMember.access.expiresAt)}` : "";
      const exempt = ["legacy_free", "admin"].includes(currentMember.access.status);
      mustElement("#membershipOffer").innerHTML = !currentMember.enabled ? '<p class="muted">当前练习免费开放，无需购买。</p>' : exempt ? '<p class="muted">这个账号可以继续免费练习。</p>' : `${currentMember.paymentMode === "sandbox" || currentMember.paymentMode === "test" ? '<div class="message warning">测试支付环境，请勿使用真实资金。</div>' : ''}<p>1 元开通 30 天。提前续费会保留剩余有效期，到期后可再次购买。</p>${!currentMember.paymentEnabled ? '<div class="message info">支付宝支付暂未开放，当前无法购买会员。</div>' : '<p class="helper">生成订单后前往支付宝收银台扫码支付，到账后自动开通。</p>'}`;
      create.hidden = !currentMember.enabled || exempt;
      create.disabled = creating || !canBuy();
      mustElement<HTMLButtonElement>("#membershipPractice").hidden = !currentMember.access.canPractice;
    };
    const say = (text: string, error = false) => { message.textContent = text; message.className = `message ${error ? "error" : "info"}`; message.hidden = false; };
    const loadOrders = async () => {
      try {
        const result = await api.paymentOrders();
        if (!active()) return;
        mustElement("#membershipOrders").innerHTML = result.orders.length ? result.orders.map(order => `<div class="membership-history-row"><span>${escapeHtml(displayDate(order.createdAt))}</span><span>¥${(order.amountFen / 100).toFixed(2)} · ${escapeHtml(statusLabel(order))}</span></div>`).join("") : '<p class="helper">还没有购买记录。</p>';
      } catch { if (active()) mustElement("#membershipOrders").textContent = "购买记录暂不可用，请稍后刷新。"; }
    };
    const paintOrder = (result: PaymentResponse) => {
      orderResponse = result;
      const panel = mustElement<HTMLElement>("#paymentOrder");
      const href = safePaymentUrl(result.paymentUrl, result.paymentMode);
      panel.hidden = false;
      panel.innerHTML = `<h3>${escapeHtml(statusLabel(result.order))}</h3><p class="helper">订单：${escapeHtml(result.order.id)}</p>${result.order.status === "paid" ? `<p>已开通至 ${escapeHtml(displayDate(result.order.creditedUntil))}</p>` : result.order.status === "pending" ? `<p>订单金额 ¥${(result.order.amountFen / 100).toFixed(2)}，请在 ${escapeHtml(displayDate(result.order.expiresAt))} 前付款。</p>${href ? `<a class="btn primary" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">前往支付宝扫码支付</a>` : '<p class="message warning">未获得可用的支付宝支付链接，请稍后重试。</p>'}<p class="helper">付款后本页会自动核实结果。关闭收银台不会自动开通会员。</p>` : '<p>可以重新生成订单；若已扣款，请刷新状态核实，避免重复付款。</p>'}`;
    };
    let checking = false;
    const schedulePoll = () => {
      if (!active() || orderResponse?.order.status !== "pending") return;
      pollTimer = window.setTimeout(() => {
        if (!active()) return;
        if (document.visibilityState === "hidden") schedulePoll();
        else void refresh();
      }, Math.max(5, orderResponse.retryAfterSeconds || 5) * 1000);
    };
    const refresh = async () => {
      if (!active() || checking) return;
      checking = true;
      window.clearTimeout(pollTimer);
      try {
        if (orderId) {
          const requestedOrderId = orderId;
          const result = await api.paymentOrder(requestedOrderId);
          if (!active() || requestedOrderId !== orderId) return;
          paintOrder(result);
        }
        const updated = await api.membership();
        if (!active()) return;
        currentMember = updated; paintMember();
        if (orderResponse?.order.status === "paid") { say("支付宝付款已核实，会员已开通。"); void loadOrders(); }
      } catch (error) {
        if (!active() || context.handleAuthError(error)) return;
        say(getErrorMessage(error, "状态查询失败，请点击刷新状态重试。"), true);
      } finally {
        checking = false;
        schedulePoll();
      }
    };
    paintMember(); void loadOrders();
    mustElement("#membershipPractice").addEventListener("click", () => context.navigate("/practice"));
    mustElement("#membershipRefresh").addEventListener("click", () => { void refresh(); void loadOrders(); });
    create.addEventListener("click", async () => {
      if (creating || create.disabled || !canBuy()) return;
      creating = true;
      setBusy(create, true, "正在生成订单…");
      try {
        const result = await api.createPaymentOrder();
        if (!active()) return;
        orderId = result.order.id;
        history.replaceState({}, "", `/membership?order=${encodeURIComponent(orderId)}`);
        paintOrder(result); say("订单已生成，请前往支付宝收银台付款。");
        void refresh(); void loadOrders();
      } catch (error) { if (active() && !context.handleAuthError(error)) say(getErrorMessage(error, "订单创建失败"), true); }
      finally { creating = false; if (active()) { setBusy(create, false); create.disabled = !canBuy(); } }
    });
    if (orderId) void refresh();
  } catch (error) {
    if (!active() || context.handleAuthError(error)) return;
    context.renderShell(errorMarkup("会员信息暂不可用", getErrorMessage(error)), "/membership");
    mustElement("#retryButton").addEventListener("click", () => void renderMembership(context));
  }
}
