/**
 * Clarity.fm Browser Automation Client
 *
 * Automates expert search, profile viewing, and booking on Clarity.fm.
 * The official API (github.com/clarityfm/clarity-api) is non-functional,
 * so all interactions use Playwright browser automation.
 *
 * Key features:
 * - Search: Find experts by keyword with rate/sort filters
 * - Profile: Extract detailed expert data with value scoring
 * - Compare: Side-by-side expert comparison
 * - Fill Booking: Pre-fill booking form (two-stage confirmation)
 * - Dashboard: View upcoming/completed calls
 *
 * Uses headed browser with stealth plugin. Clarity.fm is a JavaScript SPA
 * with analytics tracking; payment flows may have anti-fraud checks.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

chromium.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const SESSION_PATH = "/tmp/clarity-session.json";
const STORAGE_STATE_PATH = "/tmp/clarity-storage-state.json";
const SCREENSHOT_DIR = "/home/USER/biz/.playwright-mcp";
const CONFIG_PATH = join(__dirname, "..", "config.json");
const USER_DATA_DIR = "/tmp/clarity-browser-profile";

// Clarity.fm URLs
const CLARITY_BASE = "https://clarity.fm";
const CLARITY_LOGIN_URL = `${CLARITY_BASE}/login`;
const CLARITY_DASHBOARD_URL = `${CLARITY_BASE}/dashboard`;

// Interfaces

interface SessionInfo {
  wsEndpoint: string;
  createdAt: string;
  loggedIn: boolean;
  bookingFilled: boolean;
  currentExpert?: string;
}

interface Config {
  clarity: {
    email: string;
    password: string;
    phone: string;
    monthlyBudget?: number;
  };
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

export class ClarityClient {
  private config: Config;
  private browser: any = null;
  private context: any = null;
  private page: any = null;

  constructor() {
    this.config = this.loadConfig();
    if (!existsSync(SCREENSHOT_DIR)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  }

  // ============================================
  // INTERNAL: Config & Session
  // ============================================

  private loadConfig(): Config {
    if (!existsSync(CONFIG_PATH)) {
      throw new Error(`Config file not found at ${CONFIG_PATH}. Set up credentials via cred-loader.`);
    }
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  }

  private async ensureBrowser(): Promise<any> {
    if (!existsSync(USER_DATA_DIR)) {
      mkdirSync(USER_DATA_DIR, { recursive: true });
    }

    // Try to reconnect to existing session
    if (existsSync(SESSION_PATH)) {
      try {
        const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
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
      } catch {
        try { unlinkSync(SESSION_PATH); } catch { /* ignore */ }
      }
    }

    // Clean WSL2 singleton locks
    for (const file of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      const filePath = `${USER_DATA_DIR}/${file}`;
      if (existsSync(filePath)) {
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }

    // Launch with stealth
    this.browser = await chromium.launch({
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
      ],
    });

    // Restore storage state if available (cookies, localStorage)
    const contextOptions: any = {
      viewport: { width: 1280, height: 800 },
    };
    if (existsSync(STORAGE_STATE_PATH)) {
      try {
        contextOptions.storageState = STORAGE_STATE_PATH;
      } catch { /* ignore invalid state */ }
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();

    // Save session for reconnection
    const wsEndpoint = (this.browser as any)?.wsEndpoint?.() as string | undefined;
    if (wsEndpoint) {
      writeFileSync(
        SESSION_PATH,
        JSON.stringify({
          wsEndpoint,
          createdAt: new Date().toISOString(),
          loggedIn: false,
          bookingFilled: false,
        } as SessionInfo)
      );
    }

    return this.page;
  }

  private updateSession(updates: Partial<SessionInfo>): void {
    if (existsSync(SESSION_PATH)) {
      const session = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
      Object.assign(session, updates);
      writeFileSync(SESSION_PATH, JSON.stringify(session));
    }
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
      } catch { /* ignore */ }
    }
  }

  // ============================================
  // INTERNAL: Query → Browse URL Mapping
  // ============================================

  /**
   * Clarity.fm doesn't have keyword search — it uses category-based browsing
   * at /browse/{category}/{subcategory}. Map common queries to the right URL.
   */
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

    // Exact match
    if (CATEGORY_MAP[q]) {
      return `${CLARITY_BASE}/browse/${CATEGORY_MAP[q]}`;
    }

    // Partial match — longest matching key wins
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

    // Fallback: browse featured experts
    return `${CLARITY_BASE}/browse`;
  }

  // ============================================
  // INTERNAL: SPA Helpers
  // ============================================

  /**
   * Wait for SPA content to render. Clarity.fm is a JS SPA that shows
   * loading indicators while fetching data.
   */
  private async waitForSPAContent(page: any, indicator: string, timeout = 15000): Promise<void> {
    // Wait for any loading spinner to disappear
    await page.waitForSelector('text="Loading..."', { state: "hidden", timeout: 5000 }).catch(() => {});
    await page.waitForSelector('[class*="loading"], [class*="spinner"]', { state: "hidden", timeout: 5000 }).catch(() => {});
    // Wait for our target content
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
    } catch { /* ignore */ }

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

  /**
   * Log failed network requests and console errors for debugging
   * anti-bot detection or SPA failures.
   */
  private setupTelemetry(page: any): void {
    page.on("console", (msg: any) => {
      if (msg.type() === "error") {
        // Silently log — these get captured in screenshots
      }
    });
    page.on("requestfailed", (req: any) => {
      const url = req.url();
      // Log API failures that could indicate blocks
      if (url.includes("clarity.fm") && !url.includes(".png") && !url.includes(".jpg")) {
        // Silently noted — diagnosable from screenshots
      }
    });
  }

  // ============================================
  // INTERNAL: Login
  // ============================================

  private async ensureLoggedIn(): Promise<any> {
    const page = await this.ensureBrowser();
    this.setupTelemetry(page);

    const session = this.getSession();
    if (session?.loggedIn) {
      // Verify we're still logged in by checking the page
      try {
        await page.goto(CLARITY_DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);
        // If we're redirected to login, we need to re-auth
        const url = page.url();
        if (!url.includes("login")) {
          return page;
        }
      } catch { /* fall through to login */ }
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

    // Find email field (multi-variant selectors for SPA)
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

    // Find password field
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
      // May be a two-step flow — click continue first
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

    // Click login
    const loginBtn = await page.$(
      'button[type="submit"], button:has-text("Log In"), button:has-text("Sign In"), ' +
      'button:has-text("Login"), input[type="submit"]'
    );
    if (loginBtn) {
      await loginBtn.click({ force: true });
    }

    // Wait for redirect to dashboard or presence of logged-in indicator
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

  // ============================================
  // INTERNAL: Data Extraction
  // ============================================

  private parseRate(rateText: string): number {
    // Parse "$5.00/min" or "$5/min" or "5.00" etc.
    const match = rateText.match(/[\d.]+/);
    return match ? parseFloat(match[0]) : 0;
  }

  private calculateValueScore(reviewCount: number | null, rating: number | null, rate: number): number | null {
    if (rating === null || reviewCount === null) return null;
    if (rate <= 0) return 0;
    return Math.round(((reviewCount * rating) / rate) * 100) / 100;
  }

  private normalizeUsername(expertInput: string): string {
    // Accept full URL or just username
    if (expertInput.startsWith("http")) {
      const url = new URL(expertInput);
      return url.pathname.replace(/^\//, "").split("/")[0];
    }
    return expertInput.replace(/^@/, "");
  }

  // ============================================
  // INTERNAL: Profile Enrichment
  // ============================================

  /**
   * Fetch ratings from individual profile pages in parallel (max 3 concurrent tabs).
   * Browse pages don't render star ratings, so we visit each profile to extract them.
   */
  private async enrichProfiles(experts: ExpertProfile[]): Promise<ExpertProfile[]> {
    const MAX_CONCURRENT = 3;
    const enriched: ExpertProfile[] = [...experts];

    for (let i = 0; i < enriched.length; i += MAX_CONCURRENT) {
      const batch = enriched.slice(i, i + MAX_CONCURRENT);

      const results = await Promise.allSettled(
        batch.map(async (expert) => {
          const tab = await this.context.newPage();
          try {
            await tab.goto(`${CLARITY_BASE}/${expert.username}`, {
              waitUntil: "domcontentloaded",
              timeout: 20000,
            });
            await tab.waitForTimeout(3000);

            const profileData = await tab.evaluate(() => {
              const text = document.body.innerText;

              // Rating — star pattern, validate 0-5 range
              let rating: number | null = null;
              const ratingMatches = text.matchAll(/([\d.]+)\s*(?:out of 5|stars?|★|\/5)/gi);
              for (const m of ratingMatches) {
                const val = parseFloat(m[1]);
                if (val > 0 && val <= 5) { rating = val; break; }
              }

              // Review count — "NNN Reviews/Ratings/Feedback"
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

      // Apply results back to experts
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

  // ============================================
  // PUBLIC: Search Experts
  // ============================================

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

    // Clarity.fm uses category-based browsing at /browse/{category}, not keyword search
    const browseUrl = this.queryToBrowseUrl(options.query);
    await page.goto(browseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    // Handle sort — click sort links after page loads
    if (options.sort === "rate") {
      try {
        const sortLink = await page.$('a:has-text("Lowest Price")');
        if (sortLink) { await sortLink.click(); await page.waitForTimeout(2000); }
      } catch { /* sort unavailable */ }
    } else if (options.sort === "calls") {
      try {
        const popularLink = await page.$('a:has-text("Popular")');
        if (popularLink) { await popularLink.click(); await page.waitForTimeout(2000); }
      } catch { /* filter unavailable */ }
    }

    // Wait for expert cards — they are list items containing "per minute"
    try {
      await this.waitForSPAContent(page, 'li', 15000);
    } catch {
      // Page may have loaded but with no results
    }

    const screenshotPath = `${SCREENSHOT_DIR}/clarity-search-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const limit = Math.min(options.limit || 10, 20);

    // Extract expert data from browse results
    // Clarity.fm DOM: expert cards are <li> elements containing "per minute" + "Request a Call"
    // Each card has: <strong>$rate</strong>, call count in "(NNN)", <strong>Name</strong>, bio text
    const experts = await page.evaluate((opts: { maxResults: number; minRate?: number; maxRate?: number }) => {
      const results: any[] = [];
      const NAV_PATHS = ["browse", "topics", "login", "search", "signup", "dashboard",
        "settings", "questions", "calls", "inbox", "help", "terms", "how-it-works", "customers"];

      // Find expert cards — list items that contain rate and call-to-action
      const allItems = document.querySelectorAll("li");
      const cards = Array.from(allItems).filter(li => {
        const t = li.textContent || "";
        return t.includes("per minute") && t.includes("Request a Call");
      });

      for (const card of cards.slice(0, opts.maxResults)) {
        try {
          const text = card.textContent || "";

          // Username from profile link (href="/username/expertise/..." or "/username")
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

          // Rate from first <strong> starting with "$"
          const strongEls = card.querySelectorAll("strong");
          let rateNum = 0;
          let rateDisplay = "N/A";
          let name = "";
          for (const s of Array.from(strongEls)) {
            const sText = s.textContent?.trim() || "";
            if (sText.startsWith("$") && rateNum === 0) {
              rateNum = parseFloat(sText.replace(/[^0-9.]/g, "")) || 0;
              rateDisplay = `${sText}/min`;
            } else if (!sText.startsWith("$") && sText.length > 1 && !name) {
              name = sText;
            }
          }

          // Apply rate filters
          if (opts.minRate && rateNum < opts.minRate) continue;
          if (opts.maxRate && rateNum > opts.maxRate) continue;

          // Call count from "(NNN)" pattern
          const callMatch = text.match(/\((\d[\d,]*)\)/);
          const totalCalls = callMatch ? parseInt(callMatch[1].replace(",", "")) : 0;

          // Bio — find the longest text segment (>80 chars) that isn't the whole card
          let bio = "";
          const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const el = node as HTMLElement;
            // Only look at leaf-ish containers (those without many child elements)
            if (el.children.length <= 2 && el.childNodes.length > 0) {
              const t = el.textContent?.trim() || "";
              if (t.length > 80 && t.length > bio.length && !t.includes("Request a Call")) {
                bio = t;
              }
            }
          }

          if (name || username) {
            // Clean bio: collapse whitespace and remove DOM artifacts
            const cleanBio = bio.replace(/\s+/g, " ").replace(/Created \d+ \w+ ago/i, "").trim();
            results.push({
              name: name || username,
              username,
              url: `https://clarity.fm/${username}`,
              rate: rateNum,
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
        } catch { /* skip broken cards */ }
      }

      return results;
    }, { maxResults: limit, minRate: options.minRate, maxRate: options.maxRate });

    // Calculate value scores (will be null for unenriched experts)
    for (const expert of experts) {
      expert.valueScore = this.calculateValueScore(expert.reviewCount, expert.rating, expert.rate);
    }

    // Enrich top N results with real ratings from profile pages
    let enrichedCount = 0;
    let enrichmentNote: string | undefined;
    if (options.enrich && options.enrich > 0 && experts.length > 0) {
      const toEnrich = experts.slice(0, options.enrich);
      const enrichedExperts = await this.enrichProfiles(toEnrich);

      // Replace enriched experts back into array
      for (let i = 0; i < enrichedExperts.length; i++) {
        experts[i] = enrichedExperts[i];
      }

      enrichedCount = enrichedExperts.filter(e => e.rating !== null).length;
      enrichmentNote = `Enriched ${enrichedCount}/${toEnrich.length} profiles with real ratings`;

      // Re-sort: enriched experts with valueScore first (desc), then unenriched
      experts.sort((a: ExpertProfile, b: ExpertProfile) => {
        if (a.valueScore !== null && b.valueScore !== null) return b.valueScore - a.valueScore;
        if (a.valueScore !== null) return -1;
        if (b.valueScore !== null) return 1;
        return 0;
      });
    }

    return {
      success: true,
      experts,
      totalResults: experts.length,
      page: options.page || 1,
      query: options.query,
      screenshot: screenshotPath,
      enriched: enrichedCount,
      enrichmentNote,
    };
  }

  // ============================================
  // PUBLIC: View Profile
  // ============================================

  async viewProfile(options: { expert: string }): Promise<any> {
    const page = await this.ensureBrowser();
    this.setupTelemetry(page);

    const username = this.normalizeUsername(options.expert);
    const profileUrl = `${CLARITY_BASE}/${username}`;

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    // Wait for profile content — look for "Request a Call" button or rate info
    try {
      await this.waitForSPAContent(page, 'button, strong', 15000);
      // Extra wait for SPA hydration
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

    // Extract profile data using text-based parsing (Clarity.fm SPA uses classless DOM)
    const profile = await page.evaluate((uname: string) => {
      const text = document.body.innerText;

      // Name — extract from page title (format: "Expert Name - Clarity" or "Expertise - Expert Name - Clarity")
      let name = "";
      const title = document.title || "";
      const titleParts = title.split(" - ").filter(p => p.trim() !== "Clarity" && p.trim().length > 0);
      if (titleParts.length >= 2) {
        // "Expertise Title - Expert Name - Clarity" → take second part
        name = titleParts[1]?.trim() || titleParts[0]?.trim() || "";
      } else if (titleParts.length === 1) {
        name = titleParts[0]?.trim() || "";
      }

      // Fallback: look for <strong> near "Request a Call" button or rate text
      if (!name || name.length < 2) {
        const strongEls = document.querySelectorAll("strong");
        for (const s of Array.from(strongEls)) {
          const sText = s.textContent?.trim() || "";
          // Skip rates, nav items, short text, and common footer/header strings
          if (!sText.startsWith("$") && sText.length > 3 && !sText.match(/^\d/)
            && !sText.includes("startups") && !sText.includes("Clarity")) {
            name = sText;
            break;
          }
        }
      }

      // Rate — "$X.XX" pattern in the page
      const rateMatch = text.match(/\$([\d.]+)\s*(?:per\s*min|\/min)/i);
      const rateText = rateMatch ? `$${rateMatch[1]}/min` : "";
      const rate = rateMatch ? parseFloat(rateMatch[1]) : 0;

      // Rating — look for star pattern, validate 0-5 range
      let rating = 0;
      const ratingMatches = text.matchAll(/([\d.]+)\s*(?:out of 5|stars?|★|\/5)/gi);
      for (const m of ratingMatches) {
        const val = parseFloat(m[1]);
        if (val > 0 && val <= 5) { rating = val; break; }
      }

      // Call & review counts — "NNN\nCalls" or "NNN\nReviews"
      const callMatch = text.match(/(\d[\d,]*)\s*\n?\s*(?:Calls?|Sessions?|Consultations?)/i);
      const totalCalls = callMatch ? parseInt(callMatch[1].replace(",", "")) : 0;

      const reviewMatch = text.match(/(\d[\d,]*)\s*\n?\s*(?:Reviews?|Ratings?|Feedback)/i);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(",", "")) : 0;

      // Bio — find the first substantial text block (>100 chars) in the main content,
      // but skip items from "Similar Experts" section by stopping at certain markers
      let bio = "";
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node: Node | null;
      let foundProfileSection = false;
      while ((node = walker.nextNode())) {
        const el = node as HTMLElement;
        const t = el.textContent?.trim() || "";

        // Track when we're past nav into profile content
        if (t.includes("Request a Call") || t.includes("per min")) {
          foundProfileSection = true;
        }

        // Only extract bio from the profile section, not recommended experts
        if (foundProfileSection && el.children.length <= 3) {
          if (t.length > 100 && t.length < 2000 && t.length > bio.length
            && !t.includes("Request a Call") && !t.includes("Clarity")
            && !t.includes("startups.com") && !t.includes("Copyright")) {
            bio = t;
            break; // Take the first qualifying block after profile section
          }
        }
      }
      bio = bio.replace(/\s+/g, " ").trim();

      // Expertise — links to topics or browse categories within main content
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
        rate,
        rateDisplay: rateText || (rate ? `$${rate.toFixed(2)}/min` : "N/A"),
        bio: bio.substring(0, 500),
        expertise: [...new Set(expertise)].slice(0, 15),
        totalCalls,
        rating,
        reviewCount,
        valueScore: 0,
        availability: "",
      };
    }, username);

    profile.valueScore = this.calculateValueScore(profile.reviewCount, profile.rating, profile.rate);

    return {
      success: true,
      profile,
      screenshot: screenshotPath,
    };
  }

  // ============================================
  // PUBLIC: Compare Experts
  // ============================================

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

    // Find best value (null scores sort last)
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

  // ============================================
  // PUBLIC: Fill Booking Form (Stage 1 — no submit)
  // ============================================

  async fillBooking(options: FillBookingOptions): Promise<any> {
    const page = await this.ensureLoggedIn();

    const username = this.normalizeUsername(options.expert);
    const profileUrl = `${CLARITY_BASE}/${username}`;
    const duration = options.duration || 30;
    const phone = options.phone || this.config.clarity.phone;

    // Navigate to expert profile
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    // Extract rate for cost estimation
    const rateText = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/\$[\d.]+\/min/);
      return match?.[0] || "";
    });
    const costPerMinute = this.parseRate(rateText);
    const estimatedCost = costPerMinute * duration;

    // Extract expert name
    const expertName = await page.evaluate(() => {
      const el = document.querySelector('h1, [class*="profile-name"], [class*="expert-name"]');
      return el?.textContent?.trim() || "";
    });

    // Click "Request a Call" / "Schedule a Call" button
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

    // Wait for booking form to appear
    await page.waitForTimeout(2000);

    // Fill duration if there's a selector/input
    try {
      // Try dropdown
      const durationSelect = await page.$('select[name*="duration" i], select[id*="duration" i], select[class*="duration" i]');
      if (durationSelect) {
        await durationSelect.selectOption({ value: String(duration) }).catch(() =>
          durationSelect.selectOption({ label: `${duration} minutes` }).catch(() =>
            durationSelect.selectOption({ label: `${duration} min` })
          )
        );
      } else {
        // Try input field
        const durationInput = await page.$('input[name*="duration" i], input[id*="duration" i]');
        if (durationInput) await durationInput.fill(String(duration));
      }
    } catch { /* duration selector may not exist */ }

    // Fill topic
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

    // Fill phone number
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

    // Fill time slots if provided
    const slots = [options.slot1, options.slot2, options.slot3].filter(Boolean);
    if (slots.length > 0) {
      // Time slots are notoriously hard to automate in SPAs — try multiple approaches
      try {
        // Approach 1: Direct date/time inputs
        const dateInputs = await page.$$('input[type="datetime-local"], input[type="date"], input[name*="time" i], input[name*="date" i], input[name*="slot" i]');
        for (let i = 0; i < Math.min(slots.length, dateInputs.length); i++) {
          try {
            await dateInputs[i].fill(slots[i]!);
          } catch {
            // Approach 2: Set value via JS on React-controlled inputs
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
      } catch { /* time slot filling is best-effort */ }
    }

    // Take screenshot of filled form
    const screenshotPath = `${SCREENSHOT_DIR}/clarity-booking-filled-${username}-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    this.updateSession({ bookingFilled: true, currentExpert: username });

    // Check budget
    let budgetWarning: string | undefined;
    const monthlyBudget = this.config.clarity.monthlyBudget;
    if (monthlyBudget && estimatedCost > 0) {
      // Budget tracking is done by the budget-tracker module
      // We just report estimated cost here for the agent to check
      budgetWarning = estimatedCost > monthlyBudget
        ? `WARNING: Estimated cost $${estimatedCost.toFixed(2)} exceeds monthly budget of $${monthlyBudget}`
        : undefined;
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
      message: "Booking form filled. Review the screenshot before confirming. DO NOT call submit-booking without user approval.",
    };
  }

  // ============================================
  // PUBLIC: Submit Booking (Stage 2)
  // ============================================

  async submitBooking(): Promise<any> {
    const session = this.getSession();
    if (!session?.bookingFilled) {
      return {
        error: true,
        message: "No booking form has been filled. Call fill-booking first.",
      };
    }

    const page = await this.ensureBrowser();

    try {
      // Find and click the submit/confirm button
      const submitSelectors = [
        'button:has-text("Request Call")',
        'button:has-text("Confirm")',
        'button:has-text("Submit")',
        'button:has-text("Book")',
        'button:has-text("Send Request")',
        'button[type="submit"]',
        '[class*="submit-button"]',
        '[class*="confirm-button"]',
      ];

      let submitted = false;
      for (const selector of submitSelectors) {
        try {
          const btn = await page.$(selector);
          if (btn && await btn.isVisible()) {
            await btn.click({ force: true });
            submitted = true;
            break;
          }
        } catch { continue; }
      }

      if (!submitted) {
        const errorScreenshot = `${SCREENSHOT_DIR}/clarity-submit-no-button-${Date.now()}.png`;
        await page.screenshot({ path: errorScreenshot, fullPage: true });
        return {
          error: true,
          message: `Could not find submit button. The user may need to click submit manually in the headed browser. See: ${errorScreenshot}`,
          screenshot: errorScreenshot,
        };
      }

      // Wait for confirmation / payment step
      await page.waitForTimeout(5000);

      // Check for payment confirmation
      const paymentIndicators = await page.$('[class*="payment"], [class*="stripe"], [class*="credit-card"], iframe[src*="stripe"]');
      if (paymentIndicators) {
        // Payment flow detected — screenshot and defer to user
        const paymentScreenshot = `${SCREENSHOT_DIR}/clarity-payment-step-${Date.now()}.png`;
        await page.screenshot({ path: paymentScreenshot, fullPage: true });
        return {
          error: true,
          message: "Payment confirmation step detected. Please complete payment manually in the browser window. DO NOT retry automatically.",
          screenshot: paymentScreenshot,
          requiresManualPayment: true,
        };
      }

      const confirmScreenshot = `${SCREENSHOT_DIR}/clarity-booking-confirmed-${Date.now()}.png`;
      await page.screenshot({ path: confirmScreenshot, fullPage: true });

      // Extract confirmation data
      const confirmation = await page.evaluate(() => {
        const text = document.body.innerText;

        const callIdMatch = text.match(/(?:Call|Request|Booking)\s*(?:#|ID|Number)[:\s]*([A-Za-z0-9-]+)/i);
        const timeMatch = text.match(/(?:Scheduled|Time|Date)[:\s]*([^\n]+)/i);
        const dialMatch = text.match(/(?:Dial|Call|Phone)[:\s]*([+\d()\s-]+)/);
        const costMatch = text.match(/(?:Total|Cost|Charge|Amount)[:\s]*\$?([\d.]+)/i);

        return {
          clarityCallId: callIdMatch?.[1] || null,
          scheduledAt: timeMatch?.[1]?.trim() || null,
          dialInNumber: dialMatch?.[1]?.trim() || null,
          estimatedTotal: costMatch ? parseFloat(costMatch[1]) : null,
          pageText: text.substring(0, 2000),
        };
      });

      await this.saveStorageState();
      this.updateSession({ bookingFilled: false });

      return {
        success: true,
        screenshot: confirmScreenshot,
        confirmation,
        expert: session.currentExpert,
        message: "Booking submitted successfully.",
      };
    } catch (error: any) {
      const errorScreenshot = `${SCREENSHOT_DIR}/clarity-submit-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true }).catch(() => {});
      return {
        error: true,
        message: `Submit failed: ${error.message}. DO NOT retry — risk of double charge.`,
        screenshot: errorScreenshot,
      };
    }
  }

  // ============================================
  // PUBLIC: List Calls
  // ============================================

  async listCalls(options: { status?: string }): Promise<any> {
    const page = await this.ensureLoggedIn();

    await page.goto(CLARITY_DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    await this.dismissCookieBanners(page);

    // Wait for dashboard content
    try {
      await this.waitForSPAContent(page, '[class*="call"], [class*="booking"], [class*="dashboard"]', 15000);
    } catch { /* dashboard may have no calls */ }

    const screenshotPath = `${SCREENSHOT_DIR}/clarity-dashboard-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const statusFilter = options.status || "all";

    const calls = await page.evaluate((filter: string) => {
      const results: any[] = [];

      // Find call/booking entries
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

          // Extract expert name
          const nameEl = entry.querySelector('[class*="name"], [class*="expert"], a[href^="/"]');
          const expertName = nameEl?.textContent?.trim() || "";

          // Extract date
          const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+ \d{1,2},? \d{4})/);
          const date = dateMatch?.[1] || "";

          // Extract duration
          const durationMatch = text.match(/(\d+)\s*min/i);
          const duration = durationMatch?.[1] ? `${durationMatch[1]} min` : "";

          // Extract cost
          const costMatch = text.match(/\$[\d.]+/);
          const cost = costMatch?.[0] || "";

          // Extract status
          const statusEl = entry.querySelector('[class*="status"], [class*="badge"]');
          const status = statusEl?.textContent?.trim()?.toLowerCase() || "";

          // Extract topic
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
        } catch { /* skip */ }
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

  // ============================================
  // PUBLIC: Screenshot
  // ============================================

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

  // ============================================
  // PUBLIC: Reset
  // ============================================

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
