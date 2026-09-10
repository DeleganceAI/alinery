import { describe, expect, it } from "vitest";
import { shouldAskTelemetryConsent, TELEMETRY_CONSENT_CHOICES, telemetryConsentWrite } from "./telemetry-consent";

const current = {
  enabled: true,
  prompted: false,
  install_id: "",
  endpoint: "http://127.0.0.1:5080",
};

describe("shouldAskTelemetryConsent", () => {
  it("asks when telemetry prefs are missing", () => {
    expect(shouldAskTelemetryConsent(undefined)).toBe(true);
    expect(shouldAskTelemetryConsent(null)).toBe(true);
  });

  it("asks when prompted is false", () => {
    expect(shouldAskTelemetryConsent({ prompted: false, enabled: true })).toBe(true);
  });

  it("does not ask once a choice has been recorded", () => {
    expect(shouldAskTelemetryConsent({ prompted: true, enabled: false })).toBe(false);
    expect(shouldAskTelemetryConsent({ prompted: true, enabled: true })).toBe(false);
  });
});

describe("TELEMETRY_CONSENT_CHOICES", () => {
  it("pins the persisted answer keys so a label tweak cannot change storage", () => {
    expect(TELEMETRY_CONSENT_CHOICES.map((choice) => choice.key)).toEqual(["keep", "opt-out"]);
  });
});

describe("telemetryConsentWrite", () => {
  it("keep enables telemetry and records the prompt", () => {
    expect(telemetryConsentWrite(current, "keep")).toEqual({
      next: { ...current, enabled: true, prompted: true },
      emit: true,
    });
  });

  it("opt-out disables telemetry and still records the prompt", () => {
    expect(telemetryConsentWrite(current, "opt-out")).toEqual({
      next: { ...current, enabled: false, prompted: true },
      emit: true,
    });
  });

  it("later and unknown answers persist nothing", () => {
    expect(telemetryConsentWrite(current, "later")).toBe("later");
    expect(telemetryConsentWrite(current, "")).toBe("later");
    expect(telemetryConsentWrite(current, "typo")).toBe("later");
  });
});
