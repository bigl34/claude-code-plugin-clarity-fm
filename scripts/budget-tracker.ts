/**
 * Clarity.fm Budget Tracker
 *
 * Local JSON-based monthly spend tracking. Prevents accidental overspend
 * by checking estimated costs against a user-configurable monthly cap.
 *
 * Data stored at ~/.cache/clarity-fm-manager/budget.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const BUDGET_DIR = join(homedir(), ".cache", "clarity-fm-manager");
const BUDGET_PATH = join(BUDGET_DIR, "budget.json");

interface BudgetEntry {
  date: string;
  expert: string;
  duration: number;
  costPerMinute: number;
  estimatedTotal: number;
}

interface BudgetData {
  monthlyCap: number;
  entries: Record<string, BudgetEntry[]>; // keyed by YYYY-MM
}

export class BudgetTracker {
  private data: BudgetData;

  constructor() {
    this.data = this.load();
  }

  private load(): BudgetData {
    if (!existsSync(BUDGET_DIR)) {
      mkdirSync(BUDGET_DIR, { recursive: true });
    }
    if (existsSync(BUDGET_PATH)) {
      try {
        return JSON.parse(readFileSync(BUDGET_PATH, "utf-8"));
      } catch {
        return { monthlyCap: 0, entries: {} };
      }
    }
    return { monthlyCap: 0, entries: {} };
  }

  private save(): void {
    if (!existsSync(BUDGET_DIR)) {
      mkdirSync(BUDGET_DIR, { recursive: true });
    }
    writeFileSync(BUDGET_PATH, JSON.stringify(this.data, null, 2));
  }

  private currentMonth(): string {
    return new Date().toISOString().slice(0, 7); // YYYY-MM
  }

  setBudget(monthly: number): { success: boolean; monthlyCap: number; message: string } {
    this.data.monthlyCap = monthly;
    this.save();
    return {
      success: true,
      monthlyCap: monthly,
      message: `Monthly budget set to $${monthly.toFixed(2)}`,
    };
  }

  addEntry(expert: string, duration: number, costPerMinute: number): void {
    const month = this.currentMonth();
    if (!this.data.entries[month]) {
      this.data.entries[month] = [];
    }
    this.data.entries[month].push({
      date: new Date().toISOString(),
      expert,
      duration,
      costPerMinute,
      estimatedTotal: duration * costPerMinute,
    });
    this.save();
  }

  getMonthlySpend(month?: string): number {
    const m = month || this.currentMonth();
    const entries = this.data.entries[m] || [];
    return entries.reduce((sum, e) => sum + e.estimatedTotal, 0);
  }

  isOverBudget(additionalCost: number, month?: string): boolean {
    if (this.data.monthlyCap <= 0) return false;
    return (this.getMonthlySpend(month) + additionalCost) > this.data.monthlyCap;
  }

  getStatus(month?: string): {
    success: boolean;
    month: string;
    monthlyCap: number;
    spent: number;
    remaining: number;
    entries: BudgetEntry[];
    overBudget: boolean;
  } {
    const m = month || this.currentMonth();
    const spent = this.getMonthlySpend(m);
    const cap = this.data.monthlyCap;

    return {
      success: true,
      month: m,
      monthlyCap: cap,
      spent: Math.round(spent * 100) / 100,
      remaining: cap > 0 ? Math.round((cap - spent) * 100) / 100 : -1,
      entries: this.data.entries[m] || [],
      overBudget: cap > 0 && spent > cap,
    };
  }
}
