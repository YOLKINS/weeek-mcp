import { WeeekError } from "../types.js";

export type Json = Record<string, unknown>;

// `typeof === "object"` covers arrays too; this helper narrows to plain
// objects so each *FromJson parser can index by string keys safely under
// `noUncheckedIndexedAccess`.
export function asJson(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export function invalid(status: number, message: string): WeeekError {
  return new WeeekError({
    code: "weeek_invalid_response",
    message,
    status,
  });
}
