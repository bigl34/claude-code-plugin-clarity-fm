
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "node:crypto";
import { join } from "path";
import { homedir } from "os";

export function resolveBudgetPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): { directory: string; path: string; legacyPath: string } {
  const directory = env.CLARITY_FM_STATE_DIR
    || join(env.BIZ_ROOT || join(home, "biz"), "var", "clarity-fm-manager"); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return {
    directory,
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    path: join(directory, "budget.json"),
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    legacyPath: join(home, ".cache", "clarity-fm-manager", "budget.json"),
  };
}

const BUDGET_PATHS = resolveBudgetPaths();

type BudgetPaths = ReturnType<typeof resolveBudgetPaths>;

function ensurePrivateDirectory(paths: BudgetPaths = BUDGET_PATHS): void {
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  chmodSync(paths.directory, 0o700);
}

export function migrateLegacyBudget(paths: BudgetPaths = BUDGET_PATHS): void {
  if (existsSync(paths.path) || !existsSync(paths.legacyPath)) return;
  ensurePrivateDirectory(paths);
  const temporaryPath = `${paths.path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    copyFileSync(
      paths.legacyPath,
      temporaryPath,
      constants.COPYFILE_EXCL,
    );
    chmodSync(temporaryPath, 0o600);
    JSON.parse(readFileSync(temporaryPath, "utf8"));
    const fileDescriptor = openSync(temporaryPath, "r");
    try {
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    try {
      linkSync(temporaryPath, paths.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

interface BudgetEntry {
  date: string;
  expert: string;
  duration: number;
  costPerMinute: number;
  estimatedTotal: number;
}

interface BudgetData {
  monthlyCap: number;
  entries: Record<string, BudgetEntry[]>;
}

export class BudgetTracker {
  private data: BudgetData;

  constructor() {
    this.data = this.load();
  }

  private load(): BudgetData {
    migrateLegacyBudget();
    ensurePrivateDirectory();
    if (existsSync(BUDGET_PATHS.path)) {
      try {
        return JSON.parse(readFileSync(BUDGET_PATHS.path, "utf-8"));
      } catch {
        return { monthlyCap: 0, entries: {} };
      }
    }
    return { monthlyCap: 0, entries: {} };
  }

  private save(): void {
    ensurePrivateDirectory();
    writeFileSync(BUDGET_PATHS.path, JSON.stringify(this.data, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(BUDGET_PATHS.path, 0o600);
  }

  private currentMonth(): string {
    return new Date().toISOString().slice(0, 7);
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

