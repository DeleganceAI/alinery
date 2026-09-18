use super::*;

const CATALOG: &str = r#"{
  "ok": true,
  "provider": "alinery",
  "default_model": "alinery/Qwen3.6-35B-A3B",
  "base_url": "https://inference.alinery.ai/v1",
  "plans_url": "https://accounts.alinery.ai/plans",
  "models": [
    {"id":"Qwen3.6-35B-A3B","name":"Qwen3.6-35B-A3B","context_window":262144,"max_tokens":32768,"price":1},
    {"id":"DeepSeek-V4-Pro-0813","name":"DeepSeek-V4-Pro-0813","context_window":1048576,"max_tokens":32768,"price":2},
    {"id":"GLM-5.3-Flash","name":"GLM-5.3-Flash","context_window":1048576,"max_tokens":32768,"price":1}
  ]
}"#;

const MINT: &str = r#"{
  "ok": true,
  "token": "inf_test_abc",
  "expires_at": 1773000000,
  "provider": "alinery",
  "default_model": "alinery/Qwen3.6-35B-A3B",
  "base_url": "https://inference.alinery.ai/v1",
  "plans_url": "https://accounts.alinery.ai/plans",
  "models": [
    {"id":"Qwen3.6-35B-A3B","name":"Qwen3.6-35B-A3B","context_window":262144,"max_tokens":32768,"price":1},
    {"id":"DeepSeek-V4-Pro-0813","name":"DeepSeek-V4-Pro-0813","context_window":1048576,"max_tokens":32768,"price":2},
    {"id":"GLM-5.3-Flash","name":"GLM-5.3-Flash","context_window":1048576,"max_tokens":32768,"price":1}
  ]
}"#;

// A stale hosted block so tests can prove write replaces it rather than appending to it.
const STALE_ALINERY_BLOCK: &str = "  alinery:\n    baseUrl: \"https://old.inference.alinery.ai/v1\"\n    api: openai-completions\n    apiKey: inf_stale_token\n    models:\n      - id: stale-model\n        name: Stale Model\n        contextWindow: 1\n        maxTokens: 1\n";

const LOCAL_BLOCK: &str =
    "  local:\n    baseUrl: http://localhost:11434/v1\n    api: openai-completions\n    apiKey: local\n    compat: openai\n    discovery:\n      type: openai-models-list\n";

const DELEGANCE_BLOCK: &str = "  deleganceLab1:\n    baseUrl: http://127.0.0.1:8080/v1\n    api: openai-completions\n    apiKey: mlx-serve\n    compat: openai\n    discovery:\n      type: openai-models-list\n";

// Writes `existing` to models.yml under a fresh temp app-config dir and returns (dir, app_config).
fn setup_models_yml(name: &str, existing: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = unique_attachment_temp(name);
    let app_config = dir.join("app.toml");
    fs::write(&app_config, b"").unwrap();
    let yml = models_yml_path(&app_config);
    fs::create_dir_all(yml.parent().unwrap()).unwrap();
    fs::write(&yml, existing.as_bytes()).unwrap();
    (dir, app_config)
}

#[test]
fn is_paid_plan_is_founders_or_teams() {
    assert!(is_paid_plan("founders"));
    assert!(is_paid_plan("teams"));
    assert!(!is_paid_plan("free"));
    assert!(paid_from_stored_plan(Some("Founders Edition"), false));
    assert!(!paid_from_stored_plan(Some("Free"), false));
}

#[test]
fn parse_catalog_accepts_the_locked_fixture_shape() {
    let catalog = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    assert_eq!(catalog.provider, "alinery");
    assert_eq!(catalog.default_model, "alinery/Qwen3.6-35B-A3B");
    assert_eq!(catalog.models.len(), 3);
    assert_eq!(catalog.models[0].price, Some(1));
    assert_eq!(catalog.models[1].price, Some(2));
}

#[test]
fn parse_catalog_rejects_a_slashed_id() {
    let body = CATALOG.replace("Qwen3.6-35B-A3B", "org/Qwen3.6-35B-A3B");
    assert!(parse_hosted_catalog_body(body.as_bytes()).is_err());
}

#[test]
fn parse_catalog_rejects_a_missing_price() {
    let body = r#"{"ok":true,"provider":"alinery","default_model":"alinery/x","base_url":"https://inference.alinery.ai/v1","plans_url":"https://accounts.alinery.ai/plans","models":[{"id":"x","name":"x","context_window":1,"max_tokens":1}]}"#;
    assert!(parse_hosted_catalog_body(body.as_bytes()).is_err());
}

#[test]
fn parse_catalog_rejects_a_missing_default_model() {
    let body = CATALOG.replace("alinery/Qwen3.6-35B-A3B", "alinery/not-in-list");
    assert!(parse_hosted_catalog_body(body.as_bytes()).is_err());
}

#[test]
fn parse_catalog_rejects_control_characters() {
    let body = CATALOG.replace("Qwen3.6-35B-A3B", "Qwen\n3.6-35B-A3B");
    assert!(parse_hosted_catalog_body(body.as_bytes()).is_err());
}

#[test]
fn extra_catalog_rows_are_live_data() {
    let mut value: serde_json::Value = serde_json::from_str(CATALOG).unwrap();
    value["models"].as_array_mut().unwrap().push(serde_json::json!({
        "id": "GLM-next",
        "name": "GLM-next",
        "context_window": 1,
        "max_tokens": 1,
        "price": 3
    }));
    let catalog = parse_hosted_catalog_body(value.to_string().as_bytes()).unwrap();
    assert_eq!(catalog.models.last().map(|m| m.id.as_str()), Some("GLM-next"));
    assert_eq!(catalog.models.last().and_then(|m| m.price), Some(3));
}

#[test]
fn mint_body_keeps_the_token_off_the_catalog_view() {
    let (token, expires, catalog) = parse_inference_session_body(MINT.as_bytes()).unwrap();
    assert_eq!(token, "inf_test_abc");
    assert_eq!(expires, 1773000000);
    let view = resolve_hosted_catalog(Some(catalog), None, "https://accounts.alinery.ai", true, true);
    let json = serde_json::to_string(&view).unwrap();
    assert!(!json.contains("inf_"));
    assert!(!json.contains("token"));
}

#[test]
fn parse_hosted_error_reads_code() {
    let err = parse_hosted_error(403, br#"{"ok":false,"error":"Pay up","code":"not_paid"}"#);
    assert_eq!(err.status, 403);
    assert_eq!(err.code.as_deref(), Some("not_paid"));
}

#[test]
fn resolve_prefers_live_then_unexpired_minted_then_empty() {
    let sample = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    let mut live = sample.clone();
    live.models.truncate(1);
    let mut minted = sample;
    minted.default_model = "alinery/DeepSeek-V4-Pro-0813".into();
    let accounts = "https://accounts.alinery.ai";

    let unsigned = resolve_hosted_catalog(None, None, accounts, false, false);
    assert_eq!(unsigned.source, "empty");
    assert!(unsigned.models.is_empty());
    assert_eq!(unsigned.upsell.as_deref(), Some("sign-in"));
    assert!(!unsigned.ready);

    let unpaid = resolve_hosted_catalog(None, None, accounts, true, false);
    assert_eq!(unpaid.upsell.as_deref(), Some("subscribe"));
    assert!(unpaid.models.is_empty());

    let unsigned_live = resolve_hosted_catalog(Some(live.clone()), None, accounts, false, false);
    assert_eq!(unsigned_live.source, "live");
    assert!(!unsigned_live.ready);
    assert_eq!(unsigned_live.upsell.as_deref(), Some("sign-in"));
    assert_eq!(unsigned_live.models.len(), 1);

    let unpaid_minted = resolve_hosted_catalog(None, Some(minted.clone()), accounts, true, false);
    assert!(!unpaid_minted.ready);
    assert_eq!(unpaid_minted.upsell.as_deref(), Some("subscribe"));
    assert_eq!(unpaid_minted.source, "minted");

    let from_minted = resolve_hosted_catalog(None, Some(minted.clone()), accounts, true, true);
    assert_eq!(from_minted.source, "minted");
    assert!(from_minted.ready);
    assert_eq!(from_minted.default_model, "alinery/DeepSeek-V4-Pro-0813");

    let from_live = resolve_hosted_catalog(Some(live.clone()), Some(minted), accounts, true, true);
    assert_eq!(from_live.source, "live");
    assert_eq!(from_live.models.len(), 1);
    assert!(from_live.ready);
}

#[test]
fn models_yml_is_one_alinery_block_without_price_or_alc() {
    let catalog = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    let yaml = render_models_yml(&catalog, "inf_test_abc");
    assert!(yaml.contains("providers:\n  alinery:"));
    assert!(yaml.contains("api: openai-completions"));
    assert!(yaml.contains("apiKey: inf_test_abc"));
    assert!(yaml.contains("id: Qwen3.6-35B-A3B"));
    assert!(yaml.contains("baseUrl: \"https://inference.alinery.ai/v1\""));
    assert!(!yaml.contains("price"));
    assert!(!yaml.contains("alc_"));
    assert!(!yaml.contains("eyJ"));
}

#[test]
fn wipe_hosted_files_removes_inference_and_models_yml() {
    let dir = unique_attachment_temp("hosted-wipe");
    let app_config = dir.join("app.toml");
    fs::write(&app_config, b"").unwrap();
    let inf = inference_path(&dir);
    let yml = models_yml_path(&app_config);
    fs::create_dir_all(yml.parent().unwrap()).unwrap();
    fs::write(&inf, b"{}").unwrap();
    fs::write(&yml, b"providers:\n").unwrap();
    wipe_hosted_files(&dir, &app_config);
    assert!(!inf.exists());
    assert!(!yml.exists());
}

#[cfg(unix)]
#[test]
fn models_yml_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = unique_attachment_temp("hosted-yml-mode");
    let app_config = dir.join("app.toml");
    fs::write(&app_config, b"").unwrap();
    let catalog = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    write_hosted_models_yml(&app_config, &catalog, "inf_test_abc").unwrap();
    let mode = fs::metadata(models_yml_path(&app_config)).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn write_hosted_models_yml_replaces_an_alinery_only_document() {
    let (_dir, app_config) = setup_models_yml("hosted-yml-replace", &format!("providers:\n{STALE_ALINERY_BLOCK}"));
    let catalog = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    write_hosted_models_yml(&app_config, &catalog, "inf_test_abc").unwrap();
    let after = fs::read_to_string(models_yml_path(&app_config)).unwrap();
    assert_eq!(after, render_models_yml(&catalog, "inf_test_abc"));
    assert!(!after.contains("stale-model"));
    assert!(!after.contains("inf_stale_token"));
}

#[test]
fn write_hosted_models_yml_merges_with_user_providers() {
    let existing = format!("providers:\n{STALE_ALINERY_BLOCK}{LOCAL_BLOCK}{DELEGANCE_BLOCK}");
    let (_dir, app_config) = setup_models_yml("hosted-yml-merge", &existing);
    let catalog = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    write_hosted_models_yml(&app_config, &catalog, "inf_test_abc").unwrap();
    let after = fs::read_to_string(models_yml_path(&app_config)).unwrap();
    let rendered = render_models_yml(&catalog, "inf_test_abc");
    let block = rendered.strip_prefix("providers:\n").unwrap();
    let expected = format!("providers:\n{block}{LOCAL_BLOCK}{DELEGANCE_BLOCK}");
    assert_eq!(after, expected);
}

#[test]
fn write_hosted_models_yml_inserts_alinery_before_user_providers() {
    let existing = format!("providers:\n{LOCAL_BLOCK}");
    let (_dir, app_config) = setup_models_yml("hosted-yml-insert", &existing);
    let catalog = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    write_hosted_models_yml(&app_config, &catalog, "inf_test_abc").unwrap();
    let after = fs::read_to_string(models_yml_path(&app_config)).unwrap();
    let rendered = render_models_yml(&catalog, "inf_test_abc");
    let block = rendered.strip_prefix("providers:\n").unwrap();
    assert_eq!(after, format!("providers:\n{block}{LOCAL_BLOCK}"));
}

#[test]
fn write_hosted_models_yml_keeps_an_empty_file_alinery_only() {
    let (_dir, app_config) = setup_models_yml("hosted-yml-empty", "");
    let catalog = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    write_hosted_models_yml(&app_config, &catalog, "inf_test_abc").unwrap();
    assert_eq!(fs::read_to_string(models_yml_path(&app_config)).unwrap(), render_models_yml(&catalog, "inf_test_abc"));
}

#[test]
fn write_hosted_models_yml_refuses_a_file_without_providers() {
    let existing = "this is not yaml\n";
    let (_dir, app_config) = setup_models_yml("hosted-yml-garbage", existing);
    let catalog = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    let err = write_hosted_models_yml(&app_config, &catalog, "inf_test_abc").unwrap_err();
    assert!(err.contains("providers"));
    assert_eq!(fs::read_to_string(models_yml_path(&app_config)).unwrap(), existing);
}

#[test]
fn wipe_hosted_files_keeps_user_providers_and_strips_alinery() {
    let existing = format!("providers:\n{STALE_ALINERY_BLOCK}{LOCAL_BLOCK}");
    let (dir, app_config) = setup_models_yml("hosted-wipe-keep", &existing);
    let inf = inference_path(&dir);
    fs::write(&inf, b"{}").unwrap();
    wipe_hosted_files(&dir, &app_config);
    assert!(!inf.exists());
    let after = fs::read_to_string(models_yml_path(&app_config)).unwrap();
    assert_eq!(after, format!("providers:\n{LOCAL_BLOCK}"));
    assert!(!after.contains("alinery"));
    assert!(!after.contains("inf_"));
}

#[test]
fn wipe_hosted_files_deletes_models_yml_when_alinery_was_the_last_block() {
    let existing = format!("providers:\n{STALE_ALINERY_BLOCK}");
    let (dir, app_config) = setup_models_yml("hosted-wipe-last", &existing);
    let inf = inference_path(&dir);
    fs::write(&inf, b"{}").unwrap();
    wipe_hosted_files(&dir, &app_config);
    assert!(!inf.exists());
    assert!(!models_yml_path(&app_config).exists());
}

const CREDITS_OK: &str = r#"{
  "ok": true,
  "plan": "founders",
  "included_cents": 300,
  "purchased_cents": 1000,
  "balance_cents": 1300,
  "used_this_period_cents": 0,
  "cutoff": false,
  "auto_reload": true,
  "last_reload_error": null,
  "account_url": "https://accounts.alinery.ai/account",
  "plans_url": "https://accounts.alinery.ai/plans"
}"#;

#[test]
fn parse_desktop_credits_reads_the_locked_envelope() {
    let credits = parse_desktop_credits_body(CREDITS_OK.as_bytes()).unwrap();
    assert_eq!(credits.plan, "founders");
    assert_eq!(credits.balance_cents, 1300);
    assert!(!credits.cutoff);
}

#[test]
fn credits_view_upsells_free_to_subscribe_and_empty_paid_to_buy() {
    let paid = parse_desktop_credits_body(CREDITS_OK.as_bytes()).unwrap();
    let view = credits_view_from(&paid);
    assert!(view.visible);
    assert_eq!(view.balance_cents, Some(1300));
    assert_eq!(view.upsell, None);

    let mut empty = paid.clone();
    empty.balance_cents = 0;
    assert_eq!(credits_view_from(&empty).upsell.as_deref(), Some("buy-credits"));

    let mut free = paid.clone();
    free.plan = "free".into();
    free.balance_cents = 0;
    let free_view = credits_view_from(&free);
    assert!(!free_view.paid);
    assert_eq!(free_view.upsell.as_deref(), Some("subscribe"));
}

#[test]
fn apply_credits_marks_empty_paid_catalog_not_ready() {
    let catalog = parse_hosted_catalog_body(CATALOG.as_bytes()).unwrap();
    let ready = resolve_hosted_catalog(None, Some(catalog), "https://accounts.alinery.ai", true, true);
    assert!(ready.ready);
    let empty = DesktopCreditsView {
        visible: true,
        signed_out: false,
        plan: Some("founders".into()),
        paid: true,
        balance_cents: Some(0),
        cutoff: false,
        upsell: Some("buy-credits".into()),
        account_url: Some("https://accounts.alinery.ai/account".into()),
        plans_url: Some("https://accounts.alinery.ai/plans".into()),
    };
    let view = apply_credits_to_hosted_view(ready, &empty);
    assert!(!view.ready);
    assert_eq!(view.upsell.as_deref(), Some("buy-credits"));
    assert_eq!(view.balance_cents, Some(0));
}
