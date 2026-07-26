// Postgres access.
//
// Plan-year limits live in a table because they are indexed annually. This is the
// single most consequential schema decision in an HSA custodian: hardcode the
// figures and every January is a release; store them and a new year is a row.

import pg from "pg";
import type { PlanYear, MerchantCategory, Transaction } from "./domain/hsa.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plan_years (
      year                    INTEGER PRIMARY KEY,
      self_only               INTEGER NOT NULL,
      family                  INTEGER NOT NULL,
      catch_up                INTEGER NOT NULL,
      min_deductible_self     INTEGER NOT NULL,
      min_deductible_family   INTEGER NOT NULL,
      max_oop_self            INTEGER NOT NULL,
      max_oop_family          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merchant_categories (
      mcc         INTEGER PRIMARY KEY,
      label       TEXT NOT NULL,
      presumption TEXT NOT NULL CHECK (presumption IN ('qualified','mixed','unqualified','conditional'))
    );

    CREATE TABLE IF NOT EXISTS card_transactions (
      id                TEXT PRIMARY KEY,
      merchant          TEXT NOT NULL,
      mcc               INTEGER NOT NULL REFERENCES merchant_categories(mcc),
      amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
      iias              BOOLEAN NOT NULL DEFAULT FALSE,
      matches_copay     BOOLEAN NOT NULL DEFAULT FALSE,
      matches_recurring BOOLEAN NOT NULL DEFAULT FALSE,
      cosmetic          BOOLEAN NOT NULL DEFAULT FALSE,
      dual_purpose      BOOLEAN NOT NULL DEFAULT FALSE,
      swiped_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS card_transactions_swiped_idx ON card_transactions (swiped_at DESC);
  `);
}

const PLAN_YEARS: PlanYear[] = [
  { year: 2026, selfOnly: 4400, family: 8750, catchUp: 1000, minDeductibleSelf: 1700, minDeductibleFamily: 3400, maxOopSelf: 8500, maxOopFamily: 17000 },
  { year: 2025, selfOnly: 4300, family: 8550, catchUp: 1000, minDeductibleSelf: 1650, minDeductibleFamily: 3300, maxOopSelf: 8300, maxOopFamily: 16600 },
];

const CATEGORIES: MerchantCategory[] = [
  { mcc: 8011, label: "Doctors and physicians", presumption: "qualified" },
  { mcc: 8021, label: "Dentists and orthodontists", presumption: "qualified" },
  { mcc: 8042, label: "Optometrists and ophthalmologists", presumption: "qualified" },
  { mcc: 8043, label: "Opticians and eyewear", presumption: "qualified" },
  { mcc: 8062, label: "Hospitals", presumption: "qualified" },
  { mcc: 5912, label: "Drug stores and pharmacies", presumption: "mixed" },
  { mcc: 5411, label: "Grocery stores", presumption: "unqualified" },
  { mcc: 7997, label: "Health clubs and gyms", presumption: "conditional" },
  { mcc: 7230, label: "Beauty and barber shops", presumption: "unqualified" },
];

const TRANSACTIONS: Transaction[] = [
  { id: "TX-5501", merchant: "Ridgeway Family Dentistry", mcc: 8021, amountCents: 34_200, iias: false, matchesCopay: false, matchesRecurring: false, cosmetic: false, dualPurpose: false },
  { id: "TX-5502", merchant: "Meridian Pharmacy #418", mcc: 5912, amountCents: 2_847, iias: true, matchesCopay: false, matchesRecurring: false, cosmetic: false, dualPurpose: false },
  { id: "TX-5503", merchant: "Northline Family Practice", mcc: 8011, amountCents: 3_500, iias: false, matchesCopay: true, matchesRecurring: false, cosmetic: false, dualPurpose: false },
  { id: "TX-5504", merchant: "Aurelia Aesthetics", mcc: 8011, amountCents: 125_000, iias: false, matchesCopay: false, matchesRecurring: false, cosmetic: true, dualPurpose: false },
  { id: "TX-5505", merchant: "Ironhold Fitness", mcc: 7997, amountCents: 8_900, iias: false, matchesCopay: false, matchesRecurring: false, cosmetic: false, dualPurpose: true },
  { id: "TX-5506", merchant: "Grovemart Grocery", mcc: 5411, amountCents: 14_382, iias: false, matchesCopay: false, matchesRecurring: false, cosmetic: false, dualPurpose: false },
  { id: "TX-5507", merchant: "Cascade Vision Center", mcc: 8043, amountCents: 28_900, iias: false, matchesCopay: false, matchesRecurring: true, cosmetic: false, dualPurpose: false },
  { id: "TX-5508", merchant: "Selby Orthopedic Group", mcc: 8011, amountCents: 78_000, iias: false, matchesCopay: false, matchesRecurring: false, cosmetic: false, dualPurpose: false },
  { id: "TX-5509", merchant: "Halcyon Day Spa", mcc: 7230, amountCents: 19_500, iias: false, matchesCopay: false, matchesRecurring: false, cosmetic: false, dualPurpose: false },
];

export async function seed(): Promise<void> {
  for (const p of PLAN_YEARS) {
    await pool.query(
      `INSERT INTO plan_years (year,self_only,family,catch_up,min_deductible_self,min_deductible_family,max_oop_self,max_oop_family)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (year) DO UPDATE SET
         self_only=EXCLUDED.self_only, family=EXCLUDED.family, catch_up=EXCLUDED.catch_up,
         min_deductible_self=EXCLUDED.min_deductible_self, min_deductible_family=EXCLUDED.min_deductible_family,
         max_oop_self=EXCLUDED.max_oop_self, max_oop_family=EXCLUDED.max_oop_family`,
      [p.year, p.selfOnly, p.family, p.catchUp, p.minDeductibleSelf, p.minDeductibleFamily, p.maxOopSelf, p.maxOopFamily],
    );
  }
  for (const c of CATEGORIES) {
    await pool.query(
      `INSERT INTO merchant_categories (mcc,label,presumption) VALUES ($1,$2,$3)
       ON CONFLICT (mcc) DO UPDATE SET label=EXCLUDED.label, presumption=EXCLUDED.presumption`,
      [c.mcc, c.label, c.presumption],
    );
  }
  for (const t of TRANSACTIONS) {
    await pool.query(
      `INSERT INTO card_transactions (id,merchant,mcc,amount_cents,iias,matches_copay,matches_recurring,cosmetic,dual_purpose)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [t.id, t.merchant, t.mcc, t.amountCents, t.iias, t.matchesCopay, t.matchesRecurring, t.cosmetic, t.dualPurpose],
    );
  }
}

export async function loadPlanYear(year: number): Promise<PlanYear | null> {
  const { rows } = await pool.query("SELECT * FROM plan_years WHERE year = $1", [year]);
  const r = rows[0];
  if (!r) return null;
  return {
    year: r.year, selfOnly: r.self_only, family: r.family, catchUp: r.catch_up,
    minDeductibleSelf: r.min_deductible_self, minDeductibleFamily: r.min_deductible_family,
    maxOopSelf: r.max_oop_self, maxOopFamily: r.max_oop_family,
  };
}

export async function loadPlanYears(): Promise<number[]> {
  const { rows } = await pool.query("SELECT year FROM plan_years ORDER BY year DESC");
  return rows.map((r) => r.year);
}

export async function loadCategories(): Promise<Record<number, MerchantCategory>> {
  const { rows } = await pool.query("SELECT * FROM merchant_categories");
  const out: Record<number, MerchantCategory> = {};
  for (const r of rows) out[r.mcc] = { mcc: r.mcc, label: r.label, presumption: r.presumption };
  return out;
}

export async function loadTransactions(): Promise<Transaction[]> {
  const { rows } = await pool.query("SELECT * FROM card_transactions ORDER BY swiped_at DESC, id");
  return rows.map((r) => ({
    id: r.id, merchant: r.merchant, mcc: r.mcc, amountCents: r.amount_cents,
    iias: r.iias, matchesCopay: r.matches_copay, matchesRecurring: r.matches_recurring,
    cosmetic: r.cosmetic, dualPurpose: r.dual_purpose,
  }));
}
