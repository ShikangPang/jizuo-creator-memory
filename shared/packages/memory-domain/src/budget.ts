import { withMemoryLock } from "./lock.ts";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";

import { resolveWithin } from "@jizuo/work-domain";
import { parse, stringify } from "yaml";
import { z } from "zod";

const BudgetLedger = z.object({
  schemaVersion: z.literal(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reservedTokens: z.number().int().nonnegative(),
  usedTokens: z.number().int().nonnegative(),
  requests: z.record(z.string(), z.object({
    reserved: z.number().int().nonnegative(),
    state: z.enum(["reserved", "settled"]),
    started: z.boolean().default(false),
    actual: z.number().int().nonnegative().optional(),
  })).optional(),
});

export type BudgetSnapshot = z.infer<typeof BudgetLedger>;

export class DailyTokenBudget {
  constructor(
    private readonly workRoot: string,
    private readonly now: () => Date,
  ) {}

  async get(date = this.dateKey()): Promise<BudgetSnapshot> {
    try {
      return BudgetLedger.parse(parse(await readFile(this.pathFor(date), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { schemaVersion: 1, date, reservedTokens: 0, usedTokens: 0 };
    }
  }

  async reserve(tokens: number, dailyLimit: number, date = this.dateKey()): Promise<boolean> {
    z.number().int().positive().parse(tokens);
    z.number().int().positive().parse(dailyLimit);
    return withMemoryLock(`${this.workRoot}:budget`, async () => {
      const ledger = await this.get(date);
      if (ledger.usedTokens + ledger.reservedTokens + tokens > dailyLimit) return false;
      await this.write({ ...ledger, reservedTokens: ledger.reservedTokens + tokens });
      return true;
    });
  }

  async settle(reservedTokens: number, actualTokens: number, date = this.dateKey()): Promise<BudgetSnapshot> {
    z.number().int().nonnegative().parse(reservedTokens);
    z.number().finite().nonnegative().parse(actualTokens);
    return withMemoryLock(`${this.workRoot}:budget`, async () => {
      const ledger = await this.get(date);
      const next = {
        ...ledger,
        reservedTokens: Math.max(0, ledger.reservedTokens - reservedTokens),
        usedTokens: ledger.usedTokens + Math.max(0, Math.floor(actualTokens)),
      };
      await this.write(next);
      return next;
    });
  }

  async reserveRequest(id: string, tokens: number, dailyLimit: number, date = this.dateKey()): Promise<boolean> {
    z.string().uuid().parse(id); z.number().int().positive().parse(tokens); z.number().int().positive().parse(dailyLimit);
    return withMemoryLock(`${this.workRoot}:budget`, async () => {
      const ledger = await this.get(date);
      if (ledger.requests?.[id]) return ledger.requests[id].state === "reserved";
      if (ledger.usedTokens + ledger.reservedTokens + tokens > dailyLimit) return false;
      await this.write({ ...ledger, reservedTokens: ledger.reservedTokens + tokens,
        requests: { ...ledger.requests, [id]: { reserved: tokens, state: "reserved", started: false } } });
      return true;
    });
  }

  async observeRequest(id: string, actual?: number, date = this.dateKey()): Promise<void> {
    if (actual !== undefined) z.number().int().nonnegative().parse(actual);
    await withMemoryLock(`${this.workRoot}:budget`, async () => {
      const ledger = await this.get(date); const request = ledger.requests?.[id];
      if (!request || request.state === "settled") return;
      await this.write({ ...ledger, requests: { ...ledger.requests, [id]: { ...request, started: true, ...(actual === undefined ? {} : { actual }) } } });
    });
  }

  async settleRequest(id: string, actual?: number, date = this.dateKey()): Promise<BudgetSnapshot> {
    if (actual !== undefined) z.number().int().nonnegative().parse(actual);
    return withMemoryLock(`${this.workRoot}:budget`, async () => {
      const ledger = await this.get(date); const request = ledger.requests?.[id];
      if (!request || request.state === "settled") return ledger;
      const charged = actual ?? request.actual ?? (request.started ? request.reserved : 0);
      const next = { ...ledger, reservedTokens: Math.max(0, ledger.reservedTokens - request.reserved), usedTokens: ledger.usedTokens + charged,
        requests: { ...ledger.requests, [id]: { ...request, state: "settled" as const, actual: charged } } };
      await this.write(next); return next;
    });
  }

  /** Only call when no previous Dream process can still be using these reservations. */
  async recoverRequests(date?: string): Promise<void> {
    if (date === undefined) {
      const files = await readdir(resolveWithin(this.workRoot, "memory", "dream", "runs")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []; throw error;
      });
      for (const file of files) if (/^\d{4}-\d{2}-\d{2}-budget\.yaml$/.test(file)) await this.recoverRequests(file.slice(0, 10));
      return;
    }
    const ledger = await this.get(date);
    for (const [id, request] of Object.entries(ledger.requests ?? {})) {
      if (request.state === "reserved") await this.settleRequest(id, undefined, date);
    }
  }

  private dateKey(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private pathFor(date: string): string {
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(date);
    return resolveWithin(this.workRoot, "memory", "dream", "runs", `${date}-budget.yaml`);
  }

  private async write(ledger: BudgetSnapshot): Promise<void> {
    const path = this.pathFor(ledger.date);
    await mkdir(resolveWithin(this.workRoot, "memory", "dream", "runs"), { recursive: true });
    const temporary = `${path}.next`;
    await writeFile(temporary, stringify(ledger, { lineWidth: 0 }), "utf8");
    await rename(temporary, path);
  }
}
