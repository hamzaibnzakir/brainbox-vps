import type { AppError, ErrorCode } from "@/types/generated";

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "code" in e && "title" in e && "message" in e;
}

/** Normalise anything thrown by a command into a human-friendly AppError. */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return { ...e, causes: e.causes ?? [], details: e.details ?? null };
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  return {
    code: "internal",
    title: "Something went wrong",
    message: "An unexpected error occurred.",
    causes: [],
    details: raw,
  };
}

export function errorIs(e: unknown, ...codes: ErrorCode[]): boolean {
  return isAppError(e) && codes.includes(e.code);
}
