#!/usr/bin/env npx tsx
/**
 * Clarity.fm Manager CLI
 *
 * Zod-validated CLI for finding and booking expert calls on Clarity.fm.
 */

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { ClarityClient } from "./clarity-client.js";
import { BudgetTracker } from "./budget-tracker.js";

// Budget tracker is standalone (no browser needed)
const budgetTracker = new BudgetTracker();

const commands = {
  "search-experts": createCommand(
    z.object({
      query: z.string().min(1).describe("Search keyword (e.g., 'marketing strategy')"),
      minRate: z.coerce.number().optional().describe("Minimum USD/min rate"),
      maxRate: z.coerce.number().optional().describe("Maximum USD/min rate"),
      sort: z.enum(["best_match", "rate", "calls"]).optional().describe("Sort order (default: best_match)"),
      page: cliTypes.int(1, 100).optional().describe("Results page (default: 1)"),
      limit: cliTypes.int(1, 20).optional().describe("Max results to return (default: 10, max: 20)"),
      enrich: z.coerce.number().optional().describe("Enrich top N results with real ratings from profile pages"),
    }),
    async (args: any, client: ClarityClient) => {
      return client.searchExperts({
        query: args.query,
        minRate: args.minRate,
        maxRate: args.maxRate,
        sort: args.sort,
        page: args.page,
        limit: args.limit,
        enrich: args.enrich,
      });
    },
    "Search for experts by keyword with rate/sort filters"
  ),

  "view-profile": createCommand(
    z.object({
      expert: z.string().min(1).describe("Expert username or full Clarity.fm URL"),
    }),
    async (args: any, client: ClarityClient) => {
      return client.viewProfile({ expert: args.expert });
    },
    "View detailed expert profile with value scoring"
  ),

  "compare-experts": createCommand(
    z.object({
      experts: z.string().min(1).describe("Comma-separated usernames (2-3)"),
    }),
    async (args: any, client: ClarityClient) => {
      return client.compareExperts({ experts: args.experts });
    },
    "Side-by-side comparison of 2-3 experts with value scoring"
  ),

  "fill-booking": createCommand(
    z.object({
      expert: z.string().min(1).describe("Expert username or full URL"),
      duration: cliTypes.int(15, 120).optional().describe("Call duration in minutes (default: 30)"),
      topic: z.string().optional().describe("Call topic/description"),
      slot1: z.string().optional().describe("Proposed time 1 (ISO 8601)"),
      slot2: z.string().optional().describe("Proposed time 2 (ISO 8601)"),
      slot3: z.string().optional().describe("Proposed time 3 (ISO 8601)"),
      phone: z.string().optional().describe("Phone number override"),
    }),
    async (args: any, client: ClarityClient) => {
      return client.fillBooking({
        expert: args.expert,
        duration: args.duration,
        topic: args.topic,
        slot1: args.slot1,
        slot2: args.slot2,
        slot3: args.slot3,
        phone: args.phone,
      });
    },
    "Fill booking form (does NOT submit — two-stage confirmation)"
  ),

  "submit-booking": createCommand(
    z.object({}),
    async (_args: any, client: ClarityClient) => {
      return client.submitBooking();
    },
    "Submit the filled booking form (after user confirmation)"
  ),

  "list-calls": createCommand(
    z.object({
      status: z.enum(["upcoming", "pending", "completed", "all"]).optional().describe("Filter by status (default: all)"),
    }),
    async (args: any, client: ClarityClient) => {
      return client.listCalls({ status: args.status });
    },
    "View calls from dashboard"
  ),

  "budget-status": createCommand(
    z.object({
      month: z.string().optional().describe("Month (YYYY-MM, default: current)"),
    }),
    async (args: any) => {
      return budgetTracker.getStatus(args.month);
    },
    "Show monthly spend and remaining budget"
  ),

  "set-budget": createCommand(
    z.object({
      monthly: z.coerce.number().min(0).describe("Monthly spending cap in USD"),
    }),
    async (args: any) => {
      return budgetTracker.setBudget(args.monthly);
    },
    "Set monthly spending cap (USD)"
  ),

  "screenshot": createCommand(
    z.object({
      filename: z.string().optional().describe("Screenshot filename (default: clarity-<timestamp>.png)"),
      fullPage: z.boolean().optional().describe("Capture full scrollable page"),
    }),
    async (args: any, client: ClarityClient) => {
      return client.takeScreenshot({
        filename: args.filename,
        fullPage: args.fullPage,
      });
    },
    "Take screenshot of current browser page"
  ),

  "reset": createCommand(
    z.object({}),
    async (_args: any, client: ClarityClient) => client.reset(),
    "Close browser and clear session"
  ),
};

runCli(commands, ClarityClient, {
  programName: "clarity-fm-cli",
  description: "Clarity.fm expert search and booking",
});
