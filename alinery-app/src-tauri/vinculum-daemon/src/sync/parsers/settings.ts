// The settings row (plan S4.1) has no file of its own: it is built from the repository's `config.toml` and
// `harnesses.toml` and the daemon's `app.toml`, and any of the three moves it. All three paths route here;
// they are `present`, so a missing file still leaves a row (the defaults) rather than deleting it.
import { readSettingsFiles, settingsEntity, settingsKey } from "../../domain/settings.ts";
import type { Parser } from "./index.ts";

export const SETTINGS_PATHS = ["config.toml", "harnesses.toml", "app.toml"];

export function settingsParser(alinery: string, appConfig: string): Parser {
  return {
    match: /^(?:config|harnesses|app)\.toml$/,
    key: () => settingsKey,
    present: SETTINGS_PATHS,
    parse: async () => settingsEntity(readSettingsFiles(alinery, appConfig)),
  };
}
