/**
 * Generic gradebook mathematics. This is deliberately separate from storage and UI.
 * It is not a DepEd grading policy and never produces an official grade.
 */
export const GENERIC_RAW_POLICY = Object.freeze({
  id: "generic-raw-v1",
  name: "Generic raw-score view",
  official: false,
  rounding: "Percentages are rounded half up to two decimal places for display."
});

const DECIMAL_PATTERN = /^-?\d+(?:\.\d{1,3})?$/;
const MAX_SCALED_VALUE = 1_000_000_000n;

export function normalizeDecimalInput(value, label = "Score") {
  const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!DECIMAL_PATTERN.test(text)) throw new RangeError(`${label} must be a number with up to three decimal places.`);
  const negative = text.startsWith("-"); const [wholePart, fractionPart = ""] = (negative ? text.slice(1) : text).split(".");
  const whole = wholePart.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionPart.replace(/0+$/, "");
  const normalizedUnsigned = fraction ? `${whole}.${fraction}` : whole; const normalized = negative && normalizedUnsigned !== "0" ? `-${normalizedUnsigned}` : normalizedUnsigned;
  if (decimalParts(normalized).integer < -MAX_SCALED_VALUE || decimalParts(normalized).integer > MAX_SCALED_VALUE) throw new RangeError(`${label} is too large.`);
  return normalized;
}

function decimalParts(value) {
  const [whole, fraction = ""] = value.split(".");
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

export function sumDecimalStrings(values) {
  const normalized = values.map((value) => normalizeDecimalInput(value, "Points")); const parts = normalized.map(decimalParts); const scale = Math.max(0, ...parts.map((part) => part.scale)); const total = parts.reduce((sum, part) => sum + part.integer * (10n ** BigInt(scale - part.scale)), 0n); const negative = total < 0n; const absolute = negative ? -total : total; const raw = absolute.toString().padStart(scale + 1, "0"); const whole = scale ? raw.slice(0, -scale) : raw; const fraction = scale ? raw.slice(-scale).replace(/0+$/, "") : ""; return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function compareDecimal(left, right) {
  const a = decimalParts(normalizeDecimalInput(left)); const b = decimalParts(normalizeDecimalInput(right));
  const scale = Math.max(a.scale, b.scale); const leftScaled = a.integer * (10n ** BigInt(scale - a.scale)); const rightScaled = b.integer * (10n ** BigInt(scale - b.scale));
  return leftScaled === rightScaled ? 0 : leftScaled > rightScaled ? 1 : -1;
}

function formatHundredths(value) {
  const whole = value / 100n; const fraction = String(value % 100n).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
}

export function genericRawPercentage(rawScore, maximumScore) {
  const raw = normalizeDecimalInput(rawScore, "Score"); const maximum = normalizeDecimalInput(maximumScore, "Maximum score");
  if (compareDecimal(maximum, "0") <= 0) throw new RangeError("Maximum score must be greater than zero.");
  if (compareDecimal(raw, "0") < 0) throw new RangeError("Score cannot be negative.");
  if (compareDecimal(raw, maximum) > 0) throw new RangeError("Score cannot be greater than the maximum score.");
  const a = decimalParts(raw); const b = decimalParts(maximum);
  const numerator = a.integer * (10n ** BigInt(b.scale)) * 100n;
  const denominator = b.integer * (10n ** BigInt(a.scale));
  const hundredths = (numerator * 100n + denominator / 2n) / denominator;
  return Object.freeze({ rawScore: raw, maximumScore: maximum, display: formatHundredths(hundredths), roundedHundredths: hundredths.toString() });
}

export function validateScoreInput(value, maximumScore) {
  if (value == null || String(value).trim() === "") return Object.freeze({ entered: false, rawScore: "", error: null });
  try { return Object.freeze({ entered: true, rawScore: genericRawPercentage(value, maximumScore).rawScore, error: null }); }
  catch (error) { return Object.freeze({ entered: true, rawScore: String(value), error: error.message }); }
}

export function scoreDisplay(rawScore, maximumScore) {
  if (rawScore == null || String(rawScore).trim() === "") return Object.freeze({ entered: false, label: "Not entered" });
  try { return Object.freeze({ entered: true, label: `${rawScore} / ${maximumScore} = ${genericRawPercentage(rawScore, maximumScore).display} raw`, percentage: genericRawPercentage(rawScore, maximumScore) }); }
  catch (error) { return Object.freeze({ entered: true, label: error.message, error: true }); }
}
