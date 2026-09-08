
import { chromium } from "playwright-extra";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { loadServiceConfig, z } from "@local/cli-utils";
import { secureStatePath, secureWrite } from "./vendor/secure-state/index.js";
import { BudgetTracker } from "./budget-tracker.js";

chromium.use(StealthPlugin());

const SESSION_PATH = secureStatePath("clarity-fm", "session.json");
const STORAGE_STATE_PATH = secureStatePath("clarity-fm", "storage-state.json");
const SCREENSHOT_DIR = process.env.HOME + "/biz/.playwright-mcp";
const USER_DATA_DIR = secureStatePath("clarity-fm", "browser-profile");

const ClarityConfigSchema = z.object({
  clarity: z.object({
    email: z.string().min(1),
    password: z.string().min(1),
    phone: z.string().min(1),
    monthlyBudget: z.number().optional(),
  }),
});

const CLARITY_BASE = "https://clarity.fm";
const CLARITY_LOGIN_URL = `${CLARITY_BASE}/login`;
const CLARITY_DASHBOARD_URL = `${CLARITY_BASE}/dashboard`;


interface SessionInfo {
  wsEndpoint?: string;
  createdAt: string;
  loggedIn: boolean;
  bookingFilled: boolean;
  currentExpert?: string;
  currentDuration?: number;
  currentCostPerMinute?: number;
  currentEstimatedCost?: number;
}

type Config = z.infer<typeof ClarityConfigSchema>;

export interface BookingConfirmationDetails {
  clarityCallId?: string | null;
  scheduledAt?: string | null;
  dialInNumber?: string | null;
  estimatedTotal?: number | null;
  pageText?: string | null;
  pageUrl?: string | null;
}

export function hasBookingConfirmationSignal(confirmation: BookingConfirmationDetails): boolean {
  if (confirmation.clarityCallId || confirmation.scheduledAt || confirmation.dialInNumber) {
    return true;
  }

  const text = `${confirmation.pageText ?? ""} ${confirmation.pageUrl ?? ""}`.toLowerCase();
  if (/\b(confirmed|booking request sent|request received|scheduled|call booked|thank you)\b/.test(text)) {
    return true;
  }

  return /\/(?:calls|bookings|requests)\/(?:confirmation|confirmed|[a-z0-9-]{6,})/i.test(confirmation.pageUrl ?? "");
}

export function parseClarityRate(rateText: string): number | null {
  const perMinute = rateText.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*min|per\s*(?:min|minute))/i);
  if (perMinute) {
    return Number.parseFloat(perMinute[1]);
  }

  const bareCurrency = rateText.trim().match(/^\$\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (bareCurrency) {
    return Number.parseFloat(bareCurrency[1]);
  }

  const numericOnly = rateText.trim().match(/^([0-9]+(?:\.[0-9]+)?)$/);
  return numericOnly ? Number.parseFloat(numericOnly[1]) : null;
}

export interface ExpertProfile {
  name: string;
  username: string;
  url: string;
  rate: number;
  rateDisplay: string;
  bio: string;
  expertise: string[];
  totalCalls: number;
  rating: number | null;
  reviewCount: number | null;
  valueScore: number | null;
  availability: string;
}

export interface SearchResult {
  experts: ExpertProfile[];
  totalResults: number;
  page: number;
  screenshot: string;
}

export interface CallEntry {
  expertName: string;
  date: string;
  duration: string;
  cost: string;
  status: string;
  topic: string;
}

export interface FillBookingOptions {
  expert: string;
  duration?: number;
  topic?: string;
  slot1?: string;
  slot2?: string;
  slot3?: string;
  phone?: string;
}

export interface FillBookingResult {
  success: boolean;
  screenshot: string;
  expertName: string;
  expertProfileUrl: string;
  estimatedCost: number;
  costPerMinute: number;
  duration: number;
  topic?: string;
  budgetWarning?: string;
  message: string;
}

interface ScreenshotOptions {
  filename?: string;
  fullPage?: boolean;
}

type BrowserWithOptionalEndpoint = Browser & {
  wsEndpoint?: () => string;
};

export class ClarityClient {
  private config: Config;
  private budgetTracker = new BudgetTracker();
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor() {
    this.config = this.loadConfig();
    if (!existsSync(SCREENSHOT_DIR)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  }


  private loadConfig(): Config {
    return loadServiceConfig("clarity-fm-manager", {
      schema: ClarityConfigSchema,
      remedy: "Set up credentials via cred-loader.",
    });
  }

  private async ensureBrowser(): Promise<Page> {
    if (!existsSync(USER_DATA_DIR)) {
      mkdirSync(USER_DATA_DIR, { recursive: true });
    }

    if (existsSync(SESSION_PATH)) {
      try {
        const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
        if (session.wsEndpoint) {
          this.browser = await chromium.connectOverCDP(session.wsEndpoint);
          const contexts = this.browser.contexts();
          if (contexts.length > 0) {
            this.context = contexts[0];
            const pages = this.context.pages();
            if (pages.length > 0) {
              this.page = pages[0];
              return this.page;
            }
          }
        }
      } catch {
        try { unlinkSync(SESSION_PATH); } catch {   }
      }
    }

    for (const file of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      const filePath = `${USER_DATA_DIR}/${file}`;
      if (existsSync(filePath)) {
        try { unlinkSync(filePath); } catch {   }
      }
    }

    this.browser = await chromium.launch({
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
      ],
    });

    const contextOptions: BrowserContextOptions = {
      viewport: { width: 1280, height: 800 },
    };
    if (existsSync(STORAGE_STATE_PATH)) {
      try {
        contextOptions.storageState = STORAGE_STATE_PATH;
      } catch {   }
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();

    const wsEndpoint = this.browserWsEndpoint();
    secureWrite(
      SESSION_PATH,
      JSON.stringify({
        wsEndpoint,
        createdAt: new Date().toISOString(),
        loggedIn: false,
        bookingFilled: false,
      } as SessionInfo)
    );

    return this.page;
  }

  private browserWsEndpoint(): string | undefined {
    const endpoint = (this.browser as BrowserWithOptionalEndpoint | null)?.wsEndpoint?.();
    return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : undefined;
  }

  private updateSession(updates: Partial<SessionInfo>): void {
    const existing = this.getSession();
    const wsEndpoint = existing?.wsEndpoint ?? this.browserWsEndpoint();
    const session: SessionInfo = {
      wsEndpoint,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      loggedIn: existing?.loggedIn ?? false,
      bookingFilled: existing?.bookingFilled ?? false,
      ...existing,
      ...updates,
    };
    secureWrite(SESSION_PATH, JSON.stringify(session));
  }

  private getSession(): SessionInfo | null {
    if (!existsSync(SESSION_PATH)) return null;
    try {
      return JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
    } catch {
      return null;
    }
  }

  private async saveStorageState(): Promise<void> {
    if (this.context) {
      try {
        await this.context.storageState({ path: STORAGE_STATE_PATH });
      } catch {   }
    }
  }


  private queryToBrowseUrl(query: string): string {
    const q = query.toLowerCase().trim();

    const CATEGORY_MAP: Record<string, string> = {
      "business": "business",
      "strategy": "business/strategy",
      "business strategy": "business/strategy",
      "branding": "business/branding",
      "career": "business/career-advice",
      "financial": "business/financial-consulting",
      "hr": "business/human-resources",
      "human resources": "business/human-resources",
      "legal": "business/legal",
      "business development": "business/business-development",
      "marketing": "sales-marketing",
      "marketing strategy": "sales-marketing",
      "social media": "sales-marketing/social-media-marketing",
      "social media marketing": "sales-marketing/social-media-marketing",
      "seo": "sales-marketing/search-engine-optimization",
      "pr": "sales-marketing/public-relations",
      "public relations": "sales-marketing/public-relations",
      "email marketing": "sales-marketing/email-marketing",
      "inbound marketing": "sales-marketing/inbound-marketing",
      "growth": "sales-marketing/growth-strategy",
      "growth strategy": "sales-marketing/growth-strategy",
      "advertising": "sales-marketing/advertising",
      "copywriting": "marketing-advertising/copywriting",
      "sales": "sales-marketing/sales-lead-generation",
      "digital marketing": "sales-marketing",
      "funding": "funding",
      "finance": "funding/finance",
      "crowdfunding": "raising-capital/crowdfunding",
      "kickstarter": "raising-capital/kickstarter",
      "venture capital": "raising-capital/venture-capital",
      "vc": "raising-capital/venture-capital",
      "product": "product-design",
      "design": "product-design",
      "product design": "product-design",
      "ux": "product-design/user-experience",
      "user experience": "product-design/user-experience",
      "lean startup": "product-design/lean-startup",
      "product management": "product-design/product-management",
      "analytics": "product-design/metrics-analytics",
      "technology": "technology",
      "tech": "technology",
      "software": "technology/software-development",
      "mobile": "technology/mobile",
      "wordpress": "technology/wordpress",
      "crm": "technology/crm",
      "ecommerce": "industries/e-commerce",
      "e-commerce": "industries/e-commerce",
      "saas": "industries/saas",
      "education": "industries/education",
      "real estate": "industries/real-estate",
      "marketplace": "industries/marketplaces",
      "marketplaces": "industries/marketplaces",
      "nonprofit": "industries/nonprofit",
      "entrepreneurship": "skills-management/entrepreneurship",
      "leadership": "skills-management/leadership",
      "coaching": "skills-management/coaching",
      "productivity": "skills-management/productivity",
      "public speaking": "skills-management/public-speaking",
    };

    if (CATEGORY_MAP[q]) {
      return `${CLARITY_BASE}/browse/${CATEGORY_MAP[q]}`;
    }

    let bestMatch = "";
    let bestPath = "";
    for (const [key, path] of Object.entries(CATEGORY_MAP)) {
      if (q.includes(key) && key.length > bestMatch.length) {
        bestMatch = key;
        bestPath = path;
      }
    }
    if (bestPath) {
      return `${CLARITY_BASE}/browse/${bestPath}`;
    }

    return `${CLARITY_BASE}/browse`;
  }


  private async waitForSPAContent(page: any, indicator: string, timeout = 15000): Promise<void> {
    await page.waitForSelector('text="Loading..."', { state: "hidden", timeout: 5000 }).catch(() => {});
    await page.waitForSelector('[class*="loading"], [class*="spinner"]', { state: "hidden", timeout: 5000 }).catch(() => {});
    await page.waitForSelector(indicator, { timeout });
  }

  private async dismissCookieBanners(page: any): Promise<void> {
    await page.waitForTimeout(1500);
    try {
      await page.evaluate(() => {
        document.querySelectorAll(
          '#onetrust-consent-sdk, .onetrust-pc-dark-filter, #onetrust-banner-sdk, ' +
          '[class*="cookie-overlay"], [class*="consent-overlay"], [id*="cookie-banner"], ' +
          '[class*="CookieConsent"], [id*="CookieConsent"]'
        ).forEach(el => el.remove());
        document.body.style.overflow = "";
      });
    } catch {   }

    const cookieButtons = [
      'button:has-text("Accept All")',
      'button:has-text("Accept Cookies")',
      'button:has-text("Accept")',
      'button:has-text("I Agree")',
      'button:has-text("Got it")',
      'button:has-text("OK")',
    ];
    for (const selector of cookieButtons) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click({ force: true, timeout: 3000 });
          await page.waitForTimeout(300);
          break;
        }
      } catch { continue; }
    }
  }

  private setupTelemetry(page: any): void {
    page.on("console", (msg: any) => {
      if (msg.type() === "error") {
      }
    });
    page.on("requestfailed", (req: any) => {
      const url = req.url();
      if (url.includes("clarity.fm") && !url.includes(".png") && !url.includes(".jpg")) {
      }
    });
  }


  private async ensureLoggedIn(): Promise<any> {
    const page = await this.ensureBrowser();
    this.setupTelemetry(page);

    const session = this.getSession();
    if (session?.loggedIn) {
      try {
        await page.goto(CLARITY_DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        if (!url.includes("login")) {
          return page;
        }
      } catch {   }
    }

    return this.login();
  }

  private async login(): Promise<any> {
    const page = await this.ensureBrowser();
    this.setupTelemetry(page);

    await page.goto(CLARITY_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    const loginScreenshot = `${SCREENSHOT_DIR}/clarity-login-page-${Date.now()}.png`;
    await page.screenshot({ path: loginScreenshot, fullPage: true });

    const emailSelectors = [
      'input[name="email"]',
      'input[type="email"]',
      'input[id="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="Email" i]',
      'input[name="username"]',
      'input[id="username"]',
    ];

    let emailField = null;
    for (const selector of emailSelectors) {
      try {
        emailField = await page.waitForSelector(selector, { timeout: 8000 });
        if (emailField) break;
      } catch { continue; }
    }

    if (!emailField) {
      const errorScreenshot = `${SCREENSHOT_DIR}/clarity-login-error-no-email-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(`Could not find email field on login page. See: ${errorScreenshot}`);
    }

    await emailField.fill(this.config.clarity.email);

    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[id="password"]',
    ];

    let passwordField = null;
    for (const selector of passwordSelectors) {
      try {
        passwordField = await page.waitForSelector(selector, { timeout: 8000 });
        if (passwordField) break;
      } catch { continue; }
    }

    if (!passwordField) {
      const continueBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Next")');
      if (continueBtn) {
        await continueBtn.click({ force: true });
        await page.waitForTimeout(2000);
      }
      for (const selector of passwordSelectors) {
        try {
          passwordField = await page.waitForSelector(selector, { timeout: 10000 });
          if (passwordField) break;
        } catch { continue; }
      }
    }

    if (!passwordField) {
      const errorScreenshot = `${SCREENSHOT_DIR}/clarity-login-error-no-password-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(`Could not find password field. See: ${errorScreenshot}`);
    }

    await passwordField.fill(this.config.clarity.password);

    const loginBtn = await page.$(
      'button[type="submit"], button:has-text("Log In"), button:has-text("Sign In"), ' +
      'button:has-text("Login"), input[type="submit"]'
    );
    if (loginBtn) {
      await loginBtn.click({ force: true });
    }

    try {
      await Promise.race([
        page.waitForURL(/dashboard|home|clarity\.fm\/$/, { timeout: 30000 }),
        page.waitForSelector('[class*="avatar"], [class*="user-menu"], [href*="/settings"], [href*="/dashboard"]', { timeout: 30000 }),
      ]);
    } catch {
      const errorScreenshot = `${SCREENSHOT_DIR}/clarity-login-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(`Login failed — check credentials. See: ${errorScreenshot}`);
    }

    await this.saveStorageState();
    this.updateSession({ loggedIn: true });

    const successScreenshot = `${SCREENSHOT_DIR}/clarity-login-success-${Date.now()}.png`;
    await page.screenshot({ path: successScreenshot });

    return page;
  }


  private calculateValueScore(reviewCount: number | null, rating: number | null, rate: number): number | null {
    if (rating === null || reviewCount === null) return null;
    if (rate <= 0) return 0;
    return Math.round(((reviewCount * rating) / rate) * 100) / 100;
  }

  private normalizeUsername(expertInput: string): string {
    if (expertInput.startsWith("http")) {
      const url = new URL(expertInput);
      return url.pathname.replace(/^\//, "").split("/")[0];
    }
    return expertInput.replace(/^@/, "");
  }


  private async enrichProfiles(experts: ExpertProfile[]): Promise<ExpertProfile[]> {
    const MAX_CONCURRENT = 3;
    const enriched: ExpertProfile[] = [...experts];
    const context = this.context;
    if (!context) {
      throw new Error("Browser context is not initialized.");
    }

    for (let i = 0; i < enriched.length; i += MAX_CONCURRENT) {
      const batch = enriched.slice(i, i + MAX_CONCURRENT);

      const results = await Promise.allSettled(
        batch.map(async (expert) => {
          const tab = await context.newPage();
          try {
            await tab.goto(`${CLARITY_BASE}/${expert.username}`, {
              waitUntil: "domcontentloaded",
              timeout: 20000,
            });
            await tab.waitForTimeout(3000);

            const profileData = await tab.evaluate(() => {
              const text = document.body.innerText;

              let rating: number | null = null;
              const ratingMatches = text.matchAll(/([\d.]+)\s*(?:out of 5|stars?|★|\/5)/gi);
              for (const m of ratingMatches) {
                const val = parseFloat(m[1]);
                if (val > 0 && val <= 5) { rating = val; break; }
              }

              let reviewCount: number | null = null;
              const reviewMatch = text.match(/(\d[\d,]*)\s*\n?\s*(?:Reviews?|Ratings?|Feedback)/i);
              if (reviewMatch) {
                reviewCount = parseInt(reviewMatch[1].replace(",", ""));
              }

              return { rating, reviewCount };
            });

            return profileData;
          } finally {
            await tab.close().catch(() => {});
          }
        })
      );

      results.forEach((result, j) => {
        const idx = i + j;
        if (result.status === "fulfilled" && result.value) {
          enriched[idx].rating = result.value.rating;
          enriched[idx].reviewCount = result.value.reviewCount;
          enriched[idx].valueScore = this.calculateValueScore(
            result.value.reviewCount,
            result.value.rating,
            enriched[idx].rate,
          );
        }
      });
    }

    return enriched;
  }


  async searchExperts(options: {
    query: string;
    minRate?: number;
    maxRate?: number;
    sort?: string;
    page?: number;
    limit?: number;
    enrich?: number;
  }): Promise<any> {
    const page = await this.ensureBrowser();
    this.setupTelemetry(page);

    const browseUrl = this.queryToBrowseUrl(options.query);
    await page.goto(browseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    if (options.sort === "rate") {
      try {
        const sortLink = await page.$('a:has-text("Lowest Price")');
        if (sortLink) { await sortLink.click(); await page.waitForTimeout(2000); }
      } catch {   }
    } else if (options.sort === "calls") {
      try {
        const popularLink = await page.$('a:has-text("Popular")');
        if (popularLink) { await popularLink.click(); await page.waitForTimeout(2000); }
      } catch {   }
    }

    try {
      await this.waitForSPAContent(page, 'li', 15000);
    } catch {
    }

    const screenshotPath = `${SCREENSHOT_DIR}/clarity-search-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const limit = Math.min(options.limit || 10, 20);

    const experts = await page.evaluate((opts: { maxResults: number; minRate?: number; maxRate?: number }) => {
      const results: any[] = [];
      const NAV_PATHS = ["browse", "topics", "login", "search", "signup", "dashboard",
        "settings", "questions", "calls", "inbox", "help", "terms", "how-it-works", "customers"];

      const allItems = document.querySelectorAll("li");
      const cards = Array.from(allItems).filter(li => {
        const t = li.textContent || "";
        return t.includes("per minute") && t.includes("Request a Call");
      });

      for (const card of cards.slice(0, opts.maxResults)) {
        try {
          const text = card.textContent || "";

          let username = "";
          const links = card.querySelectorAll('a[href^="/"]');
          for (const link of Array.from(links)) {
            const href = (link as HTMLAnchorElement).getAttribute("href") || "";
            const m = href.match(/^\/([a-zA-Z0-9_-]+)/);
            if (m && !NAV_PATHS.includes(m[1])) {
              username = m[1];
              break;
            }
          }

          const strongEls = card.querySelectorAll("strong");
          let rateDisplay = "";
          let name = "";
          for (const s of Array.from(strongEls)) {
            const sText = s.textContent?.trim() || "";
            if (sText.startsWith("$") && !rateDisplay) {
              rateDisplay = sText;
            } else if (!sText.startsWith("$") && sText.length > 1 && !name) {
              name = sText;
            }
          }

          const callMatch = text.match(/\((\d[\d,]*)\)/);
          const totalCalls = callMatch ? parseInt(callMatch[1].replace(",", "")) : 0;

          let bio = "";
          const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const el = node as HTMLElement;
            if (el.children.length <= 2 && el.childNodes.length > 0) {
              const t = el.textContent?.trim() || "";
              if (t.length > 80 && t.length > bio.length && !t.includes("Request a Call")) {
                bio = t;
              }
            }
          }

          if (name || username) {
            const cleanBio = bio.replace(/\s+/g, " ").replace(/Created \d+ \w+ ago/i, "").trim();
            results.push({
              name: name || username,
              username,
              url: `https://clarity.fm/${username}`,
              rate: 0,
              rateDisplay,
              bio: cleanBio.substring(0, 200),
              expertise: [],
              totalCalls,
              rating: null,
              reviewCount: null,
              valueScore: null,
              availability: "",
            });
          }
        } catch {   }
      }

      return results;
    }, { maxResults: limit });

    const normalizedExperts = experts
      .map((expert: ExpertProfile) => {
        const rate = parseClarityRate(expert.rateDisplay || "");
        return {
          ...expert,
          rate: rate ?? 0,
          rateDisplay: rate === null ? "N/A" : `$${rate}/min`,
        };
      })
      .filter((expert: ExpertProfile) => {
        if (options.minRate && expert.rate < options.minRate) return false;
        if (options.maxRate && expert.rate > options.maxRate) return false;
        return true;
      });

    for (const expert of normalizedExperts) {
      expert.valueScore = this.calculateValueScore(expert.reviewCount, expert.rating, expert.rate);
    }

    let enrichedCount = 0;
    let enrichmentNote: string | undefined;
    if (options.enrich && options.enrich > 0 && normalizedExperts.length > 0) {
      const toEnrich = normalizedExperts.slice(0, options.enrich);
      const enrichedExperts = await this.enrichProfiles(toEnrich);

      for (let i = 0; i < enrichedExperts.length; i++) {
        normalizedExperts[i] = enrichedExperts[i];
      }

      enrichedCount = enrichedExperts.filter(e => e.rating !== null).length;
      enrichmentNote = `Enriched ${enrichedCount}/${toEnrich.length} profiles with real ratings`;

      normalizedExperts.sort((a: ExpertProfile, b: ExpertProfile) => {
        if (a.valueScore !== null && b.valueScore !== null) return b.valueScore - a.valueScore;
        if (a.valueScore !== null) return -1;
        if (b.valueScore !== null) return 1;
        return 0;
      });
    }

    return {
      success: true,
      experts: normalizedExperts,
      totalResults: normalizedExperts.length,
      page: options.page || 1,
      query: options.query,
      screenshot: screenshotPath,
      enriched: enrichedCount,
      enrichmentNote,
    };
  }


  async viewProfile(options: { expert: string }): Promise<any> {
    const page = await this.ensureBrowser();
    this.setupTelemetry(page);

    const username = this.normalizeUsername(options.expert);
    const profileUrl = `${CLARITY_BASE}/${username}`;

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    try {
      await this.waitForSPAContent(page, 'button, strong', 15000);
      await page.waitForTimeout(2000);
    } catch {
      const errorScreenshot = `${SCREENSHOT_DIR}/clarity-profile-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      return {
        error: true,
        message: `Expert "${username}" not found or page failed to load. Verify the username.`,
        screenshot: errorScreenshot,
      };
    }

    const screenshotPath = `${SCREENSHOT_DIR}/clarity-profile-${username}-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const profile = await page.evaluate<ExpertProfile, string>((uname: string) => {
      const text = document.body.innerText;

      let name = "";
      const title = document.title || "";
      const titleParts = title.split(" - ").filter(p => p.trim() !== "Clarity" && p.trim().length > 0);
      if (titleParts.length >= 2) {
        name = titleParts[1]?.trim() || titleParts[0]?.trim() || "";
      } else if (titleParts.length === 1) {
        name = titleParts[0]?.trim() || "";
      }

      if (!name || name.length < 2) {
        const strongEls = document.querySelectorAll("strong");
        for (const s of Array.from(strongEls)) {
          const sText = s.textContent?.trim() || "";
          if (!sText.startsWith("$") && sText.length > 3 && !sText.match(/^\d/)
            && !sText.includes("startups") && !sText.includes("Clarity")) {
            name = sText;
            break;
          }
        }
      }

      const rateMatch = text.match(/\$\s*[0-9]+(?:\.[0-9]+)?\s*(?:\/\s*min|per\s*(?:min|minute))?/i);
      const rateText = rateMatch ? rateMatch[0] : "";

      let rating = 0;
      const ratingMatches = text.matchAll(/([\d.]+)\s*(?:out of 5|stars?|★|\/5)/gi);
      for (const m of ratingMatches) {
        const val = parseFloat(m[1]);
        if (val > 0 && val <= 5) { rating = val; break; }
      }

      const callMatch = text.match(/(\d[\d,]*)\s*\n?\s*(?:Calls?|Sessions?|Consultations?)/i);
      const totalCalls = callMatch ? parseInt(callMatch[1].replace(",", "")) : 0;

      const reviewMatch = text.match(/(\d[\d,]*)\s*\n?\s*(?:Reviews?|Ratings?|Feedback)/i);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(",", "")) : 0;

      let bio = "";
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node: Node | null;
      let foundProfileSection = false;
      while ((node = walker.nextNode())) {
        const el = node as HTMLElement;
        const t = el.textContent?.trim() || "";

        if (t.includes("Request a Call") || t.includes("per min")) {
          foundProfileSection = true;
        }

        if (foundProfileSection && el.children.length <= 3) {
          if (t.length > 100 && t.length < 2000 && t.length > bio.length
            && !t.includes("Request a Call") && !t.includes("Clarity")
            && !t.includes("startups.com") && !t.includes("Copyright")) {
            bio = t;
            break;
          }
        }
      }
      bio = bio.replace(/\s+/g, " ").trim();

      const expertise: string[] = [];
      const allLinks = document.querySelectorAll('a[href*="/topics/"], a[href*="/browse/"]');
      for (const link of Array.from(allLinks)) {
        const linkText = link.textContent?.trim() || "";
        if (linkText.length > 2 && linkText.length < 60
          && !["About", "How it Works", "Success Stories", "Find an Expert", "Become an Expert"].includes(linkText)) {
          expertise.push(linkText);
        }
      }

      return {
        name: name || uname,
        username: uname,
        url: `https://clarity.fm/${uname}`,
        rate: 0,
        rateDisplay: rateText,
        bio: bio.substring(0, 500),
        expertise: [...new Set(expertise)].slice(0, 15),
        totalCalls,
        rating,
        reviewCount,
        valueScore: 0,
        availability: "",
      };
    }, username);

    const profileRate = parseClarityRate(profile.rateDisplay || "");
    profile.rate = profileRate ?? 0;
    profile.rateDisplay = profileRate === null ? "N/A" : `$${profileRate}/min`;
    profile.valueScore = this.calculateValueScore(profile.reviewCount, profile.rating, profile.rate);

    return {
      success: true,
      profile,
      screenshot: screenshotPath,
    };
  }


  async compareExperts(options: { experts: string }): Promise<any> {
    const usernames = options.experts.split(",").map(u => u.trim()).filter(Boolean);

    if (usernames.length < 2 || usernames.length > 3) {
      return { error: true, message: "Provide 2-3 comma-separated usernames." };
    }

    const profiles: ExpertProfile[] = [];
    const screenshots: string[] = [];

    for (const username of usernames) {
      const result = await this.viewProfile({ expert: username });
      if (result.error) {
        return { error: true, message: `Failed to load profile for "${username}": ${result.message}` };
      }
      profiles.push(result.profile);
      screenshots.push(result.screenshot);
    }

    const sorted = [...profiles].sort((a, b) => (b.valueScore ?? -1) - (a.valueScore ?? -1));
    const bestValue = sorted[0];

    return {
      success: true,
      profiles,
      bestValue: {
        username: bestValue.username,
        name: bestValue.name,
        valueScore: bestValue.valueScore,
        reason: `Highest value score: ${bestValue.valueScore} = (${bestValue.reviewCount} reviews * ${bestValue.rating} rating) / $${bestValue.rate}/min`,
      },
      screenshots,
    };
  }


  async fillBooking(options: FillBookingOptions): Promise<any> {
    const page = await this.ensureLoggedIn();

    const username = this.normalizeUsername(options.expert);
    const profileUrl = `${CLARITY_BASE}/${username}`;
    const duration = options.duration || 30;
    const phone = options.phone || this.config.clarity.phone;

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    const rateText = await page.evaluate(() => document.body.innerText);
    const parsedRate = parseClarityRate(rateText);
    if (parsedRate === null || parsedRate <= 0) {
      const errorScreenshot = `${SCREENSHOT_DIR}/clarity-booking-unknown-cost-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      return {
        error: true,
        code: "unknown-cost",
        message: `Could not determine a per-minute rate for "${username}". Refusing to fill booking form without a known cost. See: ${errorScreenshot}`,
        screenshot: errorScreenshot,
      };
    }
    const costPerMinute = parsedRate;
    const estimatedCost = costPerMinute * duration;

    const expertName = await page.evaluate(() => {
      const el = document.querySelector('h1, [class*="profile-name"], [class*="expert-name"]');
      return el?.textContent?.trim() || "";
    });

    const bookingButtonSelectors = [
      'button:has-text("Request a Call")',
      'button:has-text("Schedule a Call")',
      'button:has-text("Book a Call")',
      'button:has-text("Request Call")',
      'a:has-text("Request a Call")',
      'a:has-text("Schedule a Call")',
      '[class*="book-button"]',
      '[class*="cta-button"]',
      '[data-testid*="book"]',
      '[data-testid*="request"]',
    ];

    let bookingClicked = false;
    for (const selector of bookingButtonSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          await btn.click({ force: true });
          bookingClicked = true;
          await page.waitForTimeout(2000);
          break;
        }
      } catch { continue; }
    }

    if (!bookingClicked) {
      const errorScreenshot = `${SCREENSHOT_DIR}/clarity-booking-no-button-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      return {
        error: true,
        message: `Could not find booking button for "${username}". Expert may not accept calls. See: ${errorScreenshot}`,
        screenshot: errorScreenshot,
      };
    }

    await page.waitForTimeout(2000);

    try {
      const durationSelect = await page.$('select[name*="duration" i], select[id*="duration" i], select[class*="duration" i]');
      if (durationSelect) {
        await durationSelect.selectOption({ value: String(duration) }).catch(() =>
          durationSelect.selectOption({ label: `${duration} minutes` }).catch(() =>
            durationSelect.selectOption({ label: `${duration} min` })
          )
        );
      } else {
        const durationInput = await page.$('input[name*="duration" i], input[id*="duration" i]');
        if (durationInput) await durationInput.fill(String(duration));
      }
    } catch {   }

    if (options.topic) {
      const topicSelectors = [
        'textarea[name*="topic" i]',
        'textarea[name*="message" i]',
        'textarea[name*="description" i]',
        'textarea[placeholder*="topic" i]',
        'textarea[placeholder*="discuss" i]',
        'textarea[placeholder*="message" i]',
        'input[name*="topic" i]',
        'textarea',
      ];
      for (const selector of topicSelectors) {
        try {
          const field = await page.$(selector);
          if (field) {
            await field.fill(options.topic);
            break;
          }
        } catch { continue; }
      }
    }

    const phoneSelectors = [
      'input[name*="phone" i]',
      'input[type="tel"]',
      'input[id*="phone" i]',
      'input[placeholder*="phone" i]',
    ];
    for (const selector of phoneSelectors) {
      try {
        const field = await page.$(selector);
        if (field) {
          await field.fill(phone);
          break;
        }
      } catch { continue; }
    }

    const slots = [options.slot1, options.slot2, options.slot3].filter(Boolean);
    if (slots.length > 0) {
      try {
        const dateInputs = await page.$$('input[type="datetime-local"], input[type="date"], input[name*="time" i], input[name*="date" i], input[name*="slot" i]');
        for (let i = 0; i < Math.min(slots.length, dateInputs.length); i++) {
          try {
            await dateInputs[i].fill(slots[i]!);
          } catch {
            await page.evaluate((val: string, idx: number) => {
              const inputs = document.querySelectorAll('input[type="datetime-local"], input[type="date"], input[name*="time"], input[name*="date"], input[name*="slot"]');
              if (inputs[idx]) {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
                nativeInputValueSetter.call(inputs[idx], val);
                inputs[idx].dispatchEvent(new Event("input", { bubbles: true }));
                inputs[idx].dispatchEvent(new Event("change", { bubbles: true }));
              }
            }, slots[i]!, i);
          }
        }
      } catch {   }
    }

    const screenshotPath = `${SCREENSHOT_DIR}/clarity-booking-filled-${username}-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    this.updateSession({
      bookingFilled: true,
      currentExpert: username,
      currentDuration: duration,
      currentCostPerMinute: costPerMinute,
      currentEstimatedCost: estimatedCost,
    });

    let budgetWarning: string | undefined;
    const monthlyBudget = this.config.clarity.monthlyBudget;
    const budgetStatus = this.budgetTracker.getStatus();
    if (estimatedCost > 0 && budgetStatus.monthlyCap > 0 && this.budgetTracker.isOverBudget(estimatedCost)) {
      budgetWarning =
        `WARNING: Estimated cost $${estimatedCost.toFixed(2)} would exceed remaining monthly budget ` +
        `(spent $${budgetStatus.spent.toFixed(2)} of $${budgetStatus.monthlyCap.toFixed(2)}, ` +
        `remaining $${budgetStatus.remaining.toFixed(2)})`;
    } else if (monthlyBudget && estimatedCost > monthlyBudget) {
      budgetWarning = `WARNING: Estimated cost $${estimatedCost.toFixed(2)} exceeds monthly budget of $${monthlyBudget}`;
    }

    return {
      success: true,
      screenshot: screenshotPath,
      expertName: expertName || username,
      expertProfileUrl: profileUrl,
      estimatedCost,
      costPerMinute,
      duration,
      topic: options.topic,
      budgetWarning,
      message: "Booking preview created. Review the screenshot, then recreate and submit the booking manually in your own Clarity browser. The CLI will not submit or record the spend automatically.",
    };
  }


  async submitBooking(): Promise<any> {
    return {
      error: true,
      code: "manual-submit-required",
      requiresManualSubmission: true,
      message:
        "Automated Clarity submission is disabled because the CLI cannot reconnect to the exact filled form safely. Submit manually in Clarity and record the confirmed spend separately.",
    };
  }


  async listCalls(options: { status?: string }): Promise<any> {
    const page = await this.ensureLoggedIn();

    await page.goto(CLARITY_DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    try {
      await this.waitForSPAContent(page, '[class*="call"], [class*="booking"], [class*="dashboard"]', 15000);
    } catch {   }

    const screenshotPath = `${SCREENSHOT_DIR}/clarity-dashboard-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const statusFilter = options.status || "all";

    const calls = await page.evaluate((filter: string) => {
      const results: any[] = [];

      const entrySelectors = [
        '[class*="call-item"]',
        '[class*="booking-item"]',
        '[class*="appointment"]',
        'tr, [class*="row"]',
      ];

      let entries: Element[] = [];
      for (const sel of entrySelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) {
          entries = Array.from(found);
          break;
        }
      }

      for (const entry of entries) {
        try {
          const text = entry.textContent || "";

          const nameEl = entry.querySelector('[class*="name"], [class*="expert"], a[href^="/"]');
          const expertName = nameEl?.textContent?.trim() || "";

          const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+ \d{1,2},? \d{4})/);
          const date = dateMatch?.[1] || "";

          const durationMatch = text.match(/(\d+)\s*min/i);
          const duration = durationMatch?.[1] ? `${durationMatch[1]} min` : "";

          const costMatch = text.match(/\$[\d.]+/);
          const cost = costMatch?.[0] || "";

          const statusEl = entry.querySelector('[class*="status"], [class*="badge"]');
          const status = statusEl?.textContent?.trim()?.toLowerCase() || "";

          const topicEl = entry.querySelector('[class*="topic"], [class*="subject"]');
          const topic = topicEl?.textContent?.trim() || "";

          if (expertName || date) {
            const callEntry = { expertName, date, duration, cost, status, topic };

            if (filter === "all" ||
                (filter === "upcoming" && (status.includes("upcoming") || status.includes("scheduled"))) ||
                (filter === "pending" && status.includes("pending")) ||
                (filter === "completed" && (status.includes("completed") || status.includes("done")))) {
              results.push(callEntry);
            }
          }
        } catch {   }
      }

      return results;
    }, statusFilter);

    return {
      success: true,
      calls,
      statusFilter,
      totalCalls: calls.length,
      screenshot: screenshotPath,
    };
  }


  async takeScreenshot(options?: ScreenshotOptions): Promise<any> {
    const page = await this.ensureBrowser();

    const filename = options?.filename || `clarity-${Date.now()}.png`;
    const screenshotPath = `${SCREENSHOT_DIR}/${filename}`;

    await page.screenshot({
      path: screenshotPath,
      fullPage: options?.fullPage ?? false,
    });

    return {
      success: true,
      screenshot: screenshotPath,
    };
  }


  async reset(): Promise<any> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.context = null;
        this.page = null;
      }

      if (existsSync(SESSION_PATH)) unlinkSync(SESSION_PATH);

      return { success: true, message: "Browser session closed and cleared." };
    } catch (error: any) {
      return { error: true, message: `Reset failed: ${error.message}` };
    }
  }
}
