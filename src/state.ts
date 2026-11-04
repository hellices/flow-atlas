import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import type { Finding, Findings } from "./model.js";

export interface Exception {
  rule: string;
  key: string;
  reason: string;
  decidedBy?: string;
  reviewBy?: string;
}

export interface Baseline {
  ref: string;
  keys: string[];
  /** Items each configured source yielded when the baseline was taken. */
  coverage?: Record<string, number>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export const baselinePath = (out: string): string => join(out, "baseline.json");
export const lastCheckPath = (out: string): string => join(out, "last-check.json");
export const feedbackPath = (out: string): string => join(out, "feedback.jsonl");

export function readBaseline(out: string): Baseline | undefined {
  const p = baselinePath(out);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Baseline) : undefined;
}

export function writeBaseline(out: string, baseline: Baseline): void {
  writeJson(baselinePath(out), baseline);
}

export function readExceptions(path: string | undefined): Exception[] {
  if (!path || !existsSync(path)) return [];
  const raw: unknown = parse(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? (raw as Exception[]) : [];
}

/**
 * Whether a review date has passed. A date alone (`2026-11-02`) holds through that whole day, compared as UTC calendar
 * dates; a date-time is compared as an instant.
 */
export function pastReview(reviewBy: string, today: Date): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) return reviewBy < today.toISOString().slice(0, 10);
  const at = Date.parse(reviewBy);
  return !Number.isNaN(at) && at < today.getTime();
}

/** The exception covering a finding, unless its review date has passed. */
export function exceptionFor(finding: Finding, exceptions: Exception[], today = new Date()): { exception?: Exception; expired?: Exception } {
  for (const e of exceptions) {
    const key = e.key.startsWith(`${e.rule}|`) ? e.key : `${e.rule}|${e.key}`;
    if (key !== finding.key) continue;
    if (e.reviewBy && pastReview(String(e.reviewBy), today)) return { expired: e };
    return { exception: e };
  }
  return {};
}

export function writeLastCheck(out: string, value: Findings): void {
  writeJson(lastCheckPath(out), value);
}

export function readLastCheck(out: string): Findings | undefined {
  const p = lastCheckPath(out);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Findings) : undefined;
}

export type Verdict = "fixed" | "accepted" | "false-positive";

export interface FeedbackEntry {
  key: string;
  verdict: Verdict;
  note?: string;
  at: string;
}

export function appendFeedback(out: string, entry: FeedbackEntry): void {
  mkdirSync(out, { recursive: true });
  appendFileSync(feedbackPath(out), `${JSON.stringify(entry)}\n`);
}

export function readFeedback(out: string): FeedbackEntry[] {
  const p = feedbackPath(out);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FeedbackEntry);
}

export function writeGraph(out: string, graph: unknown): void {
  writeJson(join(out, "graph.json"), graph);
}

export function readGraph<T>(out: string): T | undefined {
  const p = join(out, "graph.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined;
}
