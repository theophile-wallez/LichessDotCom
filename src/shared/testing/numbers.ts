import { expect } from 'vitest';

// Recorded outputs compared number for number. V8's `Math.exp` and `Math.log`
// can differ in the last bit from one machine to another (Linux x64 and macOS
// arm64 do): fractions only have to match to 12 significant digits.

const SIGNIFICANT_DIGITS = 12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function nearNumber(value: number): unknown {
  if (Number.isInteger(value) || !Number.isFinite(value)) return value;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  return expect.closeTo(value, SIGNIFICANT_DIGITS - 1 - magnitude);
}

/** `expected` with each fraction in it matching any number within its last digits. */
export function nearly(expected: unknown): unknown {
  if (typeof expected === 'number') return nearNumber(expected);
  if (Array.isArray(expected)) return expected.map(nearly);
  if (isRecord(expected)) return nearlyObject(expected);
  return expected;
}

/** The same for an object, as `toMatchObject` takes. */
export function nearlyObject(expected: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, nearly(value)]));
}
