import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  contributionLimit, qualifiesAsHDHP, eligibilityIssues, excessContribution,
  testingPeriodOutcome, substantiate, type Member, type Plan, type Tier,
} from "./domain/hsa.js";
import { migrate, seed, loadPlanYear, loadPlanYears, loadCategories, loadTransactions, pool } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "web", "base.css"), "utf8");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const pct = (n: number) => (n * 100).toFixed(1) + "%";

const DEFAULT_COVERAGE = "000000sssfff"; // s = self, f = family, 0 = not eligible

function parseCoverage(s: string): Tier[] {
  const chars = (s.length === 12 ? s : DEFAULT_COVERAGE).split("");
  return chars.map((c) => (c === "s" ? "self" : c === "f" ? "family" : null));
}
const serializeCoverage = (c: Tier[]) => c.map((t) => (t === "self" ? "s" : t === "family" ? "f" : "0")).join("");

const FLAGS: Array<[keyof Member, string]> = [
  ["medicareEnrolled", "Medicare enrolled"],
  ["otherHealthCoverage", "Other health coverage"],
  ["spouseGeneralFSA", "Spouse's general-purpose FSA"],
  ["claimedAsDependent", "Claimed as dependent"],
  ["testingPeriodFailed", "Testing period failed"],
];

async function main() {
  await migrate();
  await seed();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/up") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    try {
      const q = url.searchParams;
      const years = await loadPlanYears();
      const year = Number(q.get("year") ?? years[0] ?? 2026);
      const py = (await loadPlanYear(year)) ?? (await loadPlanYear(years[0]!))!;

      const coverage = parseCoverage(q.get("coverage") ?? DEFAULT_COVERAGE);
      const member: Member = {
        name: "Priyanka Raghunathan",
        age: Number(q.get("age") ?? 57),
        medicareEnrolled: q.get("medicareEnrolled") === "1",
        otherHealthCoverage: q.get("otherHealthCoverage") === "1",
        spouseGeneralFSA: q.get("spouseGeneralFSA") === "1",
        claimedAsDependent: q.get("claimedAsDependent") === "1",
        testingPeriodFailed: q.get("testingPeriodFailed") === "1",
        monthlyCoverage: coverage,
      };
      const plan: Plan = {
        coverage: (q.get("tier") as "self" | "family") ?? "family",
        deductible: Number(q.get("deductible") ?? 3600),
        outOfPocketMax: Number(q.get("oop") ?? 9200),
        coversPreDeductibleNonPreventive: q.get("preDeductible") === "1",
      };
      const contributed = Number(q.get("contributed") ?? 6200);

      const limit = contributionLimit(member, py);
      const noLmr = contributionLimit(member, py, { useLastMonthRule: false });
      const excess = excessContribution(contributed, limit.limit);
      const hdhp = qualifiesAsHDHP(plan, py);
      const issues = eligibilityIssues(member);
      const testing = testingPeriodOutcome(member, py, contributed);
      const eligible = hdhp.qualifies && issues.length === 0;

      const categories = await loadCategories();
      const txns = await loadTransactions();

      if (url.pathname === "/api/limit") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          planYear: py, eligible, limit, prorated: noLmr.limit, contributed, excess, testingPeriod: testing,
          hdhp: { qualifies: hdhp.qualifies, failures: hdhp.failures },
          disqualifyingCoverage: issues,
        }, null, 2));
        return;
      }
      if (url.pathname === "/api/substantiate") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(
          txns.map((t) => {
            const r = substantiate(t, categories);
            return { id: t.id, merchant: t.merchant, mcc: t.mcc, amount: t.amountCents / 100, outcome: r.outcome, rule: r.rule.id, why: r.rule.why };
          }), null, 2));
        return;
      }
      if (url.pathname !== "/") {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }

      const link = (over: Record<string, string>) => {
        const p = new URLSearchParams({
          year: String(year), age: String(member.age), coverage: serializeCoverage(coverage),
          tier: plan.coverage, deductible: String(plan.deductible), oop: String(plan.outOfPocketMax),
          contributed: String(contributed),
        });
        for (const [k] of FLAGS) if ((member as any)[k]) p.set(k as string, "1");
        if (plan.coversPreDeductibleNonPreventive) p.set("preDeductible", "1");
        for (const [k, v] of Object.entries(over)) v === "" ? p.delete(k) : p.set(k, v);
        return "/?" + p.toString();
      };

      const cycleMonth = (i: number) => {
        const next = [...coverage];
        next[i] = coverage[i] === null ? "self" : coverage[i] === "self" ? "family" : null;
        return link({ coverage: serializeCoverage(next) });
      };
      const toggleFlag = (k: string) => link({ [k]: (member as any)[k] ? "" : "1" });

      const tiles = [
        { k: "Eligible", v: eligible ? "Yes" : "No", sub: eligible ? `${limit.eligibleMonths} qualifying months` : `${hdhp.failures.length + issues.length} blocker(s)`, cls: eligible ? "good" : "bad" },
        { k: "Contribution limit", v: money0(limit.limit), sub: limit.usedLastMonthRule ? "via last-month rule" : `prorated, ${limit.eligibleMonths}/12 months`, cls: "" },
        { k: "Contributed", v: money0(contributed), sub: `${((contributed / Math.max(limit.limit, 1)) * 100).toFixed(0)}% of limit`, cls: excess.overLimit ? "bad" : "good" },
        { k: "Remaining room", v: money0(Math.max(0, limit.limit - contributed)), sub: excess.overLimit ? `${money0(excess.excess)} over` : "available", cls: excess.overLimit ? "bad" : "" },
        { k: "Catch-up", v: limit.catchUpEligible ? money0(limit.catchUp) : "—", sub: limit.catchUpEligible ? `age ${member.age}, 55+` : `age ${member.age}, under 55`, cls: "" },
        { k: "Excise exposure", v: excess.overLimit ? money0(excess.exciseTax) : "$0", sub: "6% per year on excess", cls: excess.overLimit ? "bad" : "good" },
      ];

      const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Twelfths — HSA eligibility, limits and substantiation</title>
<meta name="description" content="An HSA administration engine on Node, TypeScript and PostgreSQL: month-by-month eligibility, prorated limits, the last-month rule and its testing period, excise exposure, and IRC 213(d) card substantiation.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🧮</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;550;650&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
<style>${css}</style></head><body>
<header class="top"><div class="top-inner">
  <div class="brand"><h1>Twelfths</h1><span class="tag">HSA administration</span></div>
  <div class="top-spacer"></div>
  <nav class="nav"><a href="/">Calculator</a><a href="/api/limit" target="_blank" rel="noopener">API</a>
  <a href="/api/substantiate" target="_blank" rel="noopener">Substantiation API</a></nav>
  <div class="clockline">${esc(member.name)} · plan year ${year}</div>
</div></header>
<div class="wrap">
<p class="lede">Health savings accounts look like a savings product and behave like a tax instrument.
Eligibility is tested on the first day of every month, so the annual limit is a sum of twelfths at whichever
tier applied in each month, and the last-month rule can lift it to the full annual figure in exchange for a
testing period that claws the difference back a year later.</p>

<div class="metrics">${tiles.map((t) => `<div class="metric ${t.cls}"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="sub">${t.sub}</div></div>`).join("")}</div>

<div class="cols">
 <div>
  <div class="panel"><h2>Monthly coverage</h2><div class="pad">
    <div class="mgrid">${coverage.map((t, i) => {
      const bg = t === "family" ? "var(--accent-dim)" : t === "self" ? "#2c5f52" : "var(--bg-2)";
      const bc = t ? "var(--accent)" : "var(--line)";
      return `<a href="${esc(cycleMonth(i))}" title="${MONTHS[i]}: ${t ?? "not eligible"}">
        <div style="padding:9px 0;background:${bg};border:1px solid ${bc};border-radius:5px;font-size:10px;
             font-family:var(--mono);text-align:center;color:var(--ink)">${MONTHS[i]}<br>
          <span style="font-size:9px;opacity:.75">${t === "family" ? "FAM" : t === "self" ? "SELF" : "—"}</span></div></a>`;
    }).join("")}</div>
    <div class="note" style="margin-top:9px">Click a month to cycle it between not eligible, self-only and family.
    Eligibility is tested on the first day of each month, so the limit is the sum of twelfths at each month's own
    tier, not the annual figure for whatever tier the member holds in December.</div>
  </div></div>

  <div class="panel"><h2>Limit derivation</h2><div class="pad">
    <table class="tbl"><tbody>
      <tr><td style="color:var(--ink-2)">Statutory annual, ${limit.decemberTier ?? "self"} tier</td><td class="num">${money(limit.decemberTier === "family" ? py.family : py.selfOnly)}</td></tr>
      <tr><td style="color:var(--ink-2)">Catch-up (age ${member.age})</td><td class="num">${limit.catchUpEligible ? money(py.catchUp) : "—"}</td></tr>
      <tr><td style="color:var(--ink-2)">Prorated at ${limit.eligibleMonths}/12 months</td><td class="num">${money(noLmr.limit)}</td></tr>
      <tr><td style="color:var(--ink)">Applied limit</td><td class="num" style="color:var(--accent)">${money(limit.limit)}</td></tr>
    </tbody></table>
    ${limit.lastMonthAvailable ? `<div class="card" style="margin-top:11px;border-color:${limit.usedLastMonthRule ? "var(--accent-dim)" : "var(--line-2)"}">
      <div class="desc">Last-month rule ${limit.usedLastMonthRule ? "applied" : "available but not advantageous"}</div>
      <div class="act">Eligible on 1 December means the member may be treated as eligible for the whole year,
      lifting the limit from ${money(noLmr.limit)} to ${money(limit.fullYear)}. The cost is a testing period:
      they must remain HSA-eligible through <strong class="mono">${limit.testingPeriodEnds ?? `${year + 1}-12-31`}</strong>
      or the difference becomes taxable income plus a 10% additional tax.</div></div>` : ""}
    ${testing.applicable && testing.failed ? `<div class="card" style="margin-top:11px;border-color:#6d2f39">
      <div class="desc" style="color:var(--rose)">Testing period failed</div>
      <div class="act">${money(testing.includedInIncome!)} included in income, plus ${money(testing.additionalTax!)} additional tax.</div></div>` : ""}
  </div></div>

  <div class="panel"><h2>Plan &amp; member facts</h2><div class="pad">
    <form method="get" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:13px;margin-bottom:13px">
      <input type="hidden" name="coverage" value="${serializeCoverage(coverage)}">
      ${FLAGS.filter(([k]) => (member as any)[k]).map(([k]) => `<input type="hidden" name="${k}" value="1">`).join("")}
      <label class="fld">Plan year<select name="year">${years.map((y) => `<option value="${y}" ${y === year ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      <label class="fld">Coverage tier<select name="tier">
        <option value="self" ${plan.coverage === "self" ? "selected" : ""}>Self-only</option>
        <option value="family" ${plan.coverage === "family" ? "selected" : ""}>Family</option></select></label>
      <label class="fld">Age<input type="number" name="age" value="${member.age}"></label>
      <label class="fld">Deductible<input type="number" name="deductible" value="${plan.deductible}" step="100"></label>
      <label class="fld">Out-of-pocket max<input type="number" name="oop" value="${plan.outOfPocketMax}" step="100"></label>
      <label class="fld">Contributed<input type="number" name="contributed" value="${contributed}" step="100"></label>
      <label class="fld">&nbsp;<button class="primary" type="submit">Recalculate</button></label>
    </form>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px">
      ${FLAGS.map(([k, label]) => `<a href="${esc(toggleFlag(k as string))}" style="text-decoration:none">
        <span class="chip ${(member as any)[k] ? "bad" : "mute"}" style="font-size:11px;padding:5px 10px">${(member as any)[k] ? "✓" : "○"} ${esc(label)}</span></a>`).join("")}
      <a href="${esc(link({ preDeductible: plan.coversPreDeductibleNonPreventive ? "" : "1" }))}" style="text-decoration:none">
        <span class="chip ${plan.coversPreDeductibleNonPreventive ? "bad" : "mute"}" style="font-size:11px;padding:5px 10px">${plan.coversPreDeductibleNonPreventive ? "✓" : "○"} Pays non-preventive pre-deductible</span></a>
    </div>
    <div class="card" style="border-color:${eligible ? "var(--accent-dim)" : "#6d2f39"}">
      <div class="desc" style="color:${eligible ? "var(--accent)" : "var(--rose)"}">${eligible ? "Eligible to contribute" : "Not eligible to contribute"}</div>
      ${hdhp.failures.map((f) => `<div class="act">▸ ${esc(f)}</div>`).join("")}
      ${issues.map((i) => `<div class="act">▸ ${esc(i.message)}</div>`).join("")}
      ${eligible ? `<div class="act">Plan meets the ${money0(hdhp.minDeductible)} minimum deductible and stays under the
        ${money0(hdhp.maxOop)} out-of-pocket ceiling for ${plan.coverage} coverage, with no disqualifying coverage on file.</div>` : ""}
    </div>
  </div></div>
 </div>

 <div class="panel"><h2>Card substantiation</h2>
  ${txns.map((t) => {
    const r = substantiate(t, categories);
    const cls = r.outcome === "AUTO-APPROVED" ? "ok" : r.outcome === "DENIED" ? "bad" : "warn";
    return `<div class="dsec">
      <div style="display:flex;gap:9px;align-items:baseline;flex-wrap:wrap;margin-bottom:5px">
        <span class="chip ${cls}">${r.outcome}</span><strong style="font-size:13px">${esc(t.merchant)}</strong>
        <span style="flex:1"></span><span class="mono" style="font-size:12px">${money(t.amountCents / 100)}</span></div>
      <div class="mono" style="font-size:10.5px;color:var(--ink-3);margin-bottom:5px">${t.id} · MCC ${t.mcc} — ${esc(r.category?.label ?? "unmapped")} · presumption ${r.category?.presumption ?? "n/a"}</div>
      <div class="note"><strong style="color:var(--ink-2)">${esc(r.rule.label)}.</strong> ${esc(r.rule.why)}</div></div>`;
  }).join("")}
  <div class="pad note" style="border-top:1px solid var(--line)">A denial always beats an approval shortcut. An
  IIAS-certified terminal can still ring up a cosmetic procedure, so the rules are evaluated together and
  resolved by precedence instead of returning on the first match.</div>
 </div>
</div>

<footer class="foot">
  <p style="margin:0 0 9px"><strong>How it is built.</strong> TypeScript on Node with PostgreSQL. Plan-year
  limits live in a <code>plan_years</code> table rather than as constants, because they are indexed annually
  and a custodian that hardcodes them ships a bug every January. <code>contributionLimit()</code> computes both
  the prorated and full-year figures and applies the last-month rule only when it actually helps, returning the
  testing-period date it creates. Toggle any month, change the tier, or fail the testing period and every
  downstream number recomputes.</p>
  <p style="margin:0">The plan-year figures are configuration and are illustrative rather than authoritative;
  confirm current-year limits against IRS guidance before relying on them. The structural rules are the real
  mechanics. Member, plan and transactions are fabricated.</p>
</footer>
</div></body></html>`;

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    } catch (err) {
      console.error("request failed", err);
      res.writeHead(500, { "content-type": "text/plain" }).end("internal error");
    }
  });

  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(`twelfths listening on ${port}`));

  const shutdown = async () => { server.close(); await pool.end(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
