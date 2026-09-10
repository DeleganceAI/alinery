export type TelemetryConsentState = {
  prompted: boolean;
  enabled: boolean;
};

export function shouldAskTelemetryConsent(t: TelemetryConsentState | undefined | null): boolean {
  return !t || !t.prompted;
}

export const TELEMETRY_CONSENT_CHOICES = [
  { key: "keep", label: "Share anonymous usage" },
  { key: "opt-out", label: "Don't share", tone: "ghost" as const },
];

export function telemetryConsentWrite(
  current: { enabled: boolean; prompted: boolean; install_id: string; endpoint: string },
  answer: string,
): { next: typeof current; emit: boolean } | "later" {
  if (answer === "keep") return { next: { ...current, enabled: true, prompted: true }, emit: true };
  if (answer === "opt-out") return { next: { ...current, enabled: false, prompted: true }, emit: true };
  return "later";
}
