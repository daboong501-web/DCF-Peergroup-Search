/**
 * scripts/ 진입점들이 공유하는 CLI 유틸.
 * 기존 레포 관행(update-corp-codes.ts)을 따라 .env.local / .env 를 직접 읽는다.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { etWallClockToUtcMs } from "./session";

export type ArgValue = string | boolean;

/** `--key value`, `--key=value`, `--flag` 형태를 파싱한다. */
export function parseArgs(argv: string[]): Record<string, ArgValue> {
  const out: Record<string, ArgValue> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function requireString(args: Record<string, ArgValue>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`ARG_REQUIRED: --${key} 인자가 필요합니다.`);
  }
  return v;
}

export function optionalString(args: Record<string, ArgValue>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

export function optionalNumber(args: Record<string, ArgValue>, key: string): number | undefined {
  const v = optionalString(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`ARG_INVALID: --${key} 는 숫자여야 합니다 (${v}).`);
  return n;
}

export function flag(args: Record<string, ArgValue>, key: string): boolean {
  return args[key] === true || args[key] === "true";
}

/** 쉼표구분 심볼 목록 → 대문자 배열. */
export function parseSymbols(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

/**
 * `--from YYYY-MM-DD`, `--to YYYY-MM-DD` 를 [fromMs, toMs) 범위로 바꾼다.
 * 두 날짜 모두 **미국 동부시각 기준이며 양끝 포함**이다 (to 당일도 포함되도록 다음날 00:00 을 상한으로 잡는다).
 */
export function parseDateRange(from: string, to: string): { fromMs: number; toMs: number } {
  const fromMs = etMidnight(from);
  const toMs = etMidnight(to) + 86_400_000;
  if (!(toMs > fromMs)) {
    throw new Error(`ARG_INVALID: --to(${to}) 는 --from(${from}) 이후여야 합니다.`);
  }
  return { fromMs, toMs };
}

function etMidnight(date: string): number {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`ARG_INVALID: 날짜는 YYYY-MM-DD 형식이어야 합니다 (${date}).`);
  return etWallClockToUtcMs(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0);
}

/** .env.local → .env 순으로 읽어 process.env 에 채운다 (이미 있는 값은 덮어쓰지 않음). */
export function loadDotEnv(): void {
  for (const envFile of [".env.local", ".env"]) {
    const envPath = join(process.cwd(), envFile);
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      const key = match[1];
      if (process.env[key] === undefined) {
        process.env[key] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}
