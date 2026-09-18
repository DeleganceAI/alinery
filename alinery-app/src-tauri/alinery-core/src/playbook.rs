//! Canonical v2 playbook authoring format. Markdown bodies are opaque text;
//! only exact, standalone Alinery section markers are structural.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybookScope { Bundled, Global, Repo }

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlaybookRef { pub scope: PlaybookScope, pub key: String }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputMode { Single, Each, Complete }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputSelector { pub path: String, pub mode: InputMode }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputSelector { pub path: String }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedStep {
    pub key: String,
    pub title: String,
    pub short: String,
    pub is_coding_step: bool,
    pub auto_advance_default: bool,
    pub inputs: Vec<InputSelector>,
    pub outputs: Vec<OutputSelector>,
    pub model: String,
    pub harness: String,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NormalizedPlaybook {
    pub version: u32,
    pub key: String,
    pub title: String,
    pub description: String,
    pub default_model: String,
    pub default_harness: String,
    pub step: Vec<NormalizedStep>,
    pub preamble: String,
    pub section_order: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaybookValidationError {
    pub code: String,
    pub message: String,
    pub line: Option<usize>,
    pub field: Option<String>,
    pub severity: String,
}

impl PlaybookValidationError {
    pub fn new(code: &str, message: impl Into<String>, line: Option<usize>, field: Option<String>) -> Self {
        Self { code: code.into(), message: message.into(), line, field, severity: "error".into() }
    }
}

pub fn valid_playbook_key(key: &str) -> bool {
    key.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && key.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// The only glob language supported by playbooks: a literal directory and a
/// filename containing zero or one `*` (matching zero or more filename bytes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactSelector {
    pub directory: String,
    pub prefix: String,
    pub suffix: String,
    pub wildcard: bool,
}

impl ArtifactSelector {
    pub fn parse(path: &str) -> Result<Self, String> {
        if path.is_empty() || !path.ends_with(".md") || path.contains(['\\', ':', '?', '[', ']'])
            || path.chars().any(char::is_control) {
            return Err("expected a safe relative .md path with at most one filename wildcard".into());
        }
        let mut parts = path.split('/').peekable();
        while let Some(part) = parts.next() {
            if part.is_empty() || part == "." || part == ".." || (parts.peek().is_some() && part.contains('*')) {
                return Err("empty, dot, parent and wildcard directory components are forbidden".into());
            }
        }
        let (directory, filename) = path.rsplit_once('/').unwrap_or(("", path));
        let (prefix, suffix, wildcard) = match filename.split_once('*') {
            Some((prefix, suffix)) if !suffix.contains('*') => (prefix, suffix, true),
            Some(_) => return Err("at most one wildcard is permitted".into()),
            None => (filename, "", false),
        };
        Ok(Self { directory: directory.into(), prefix: prefix.into(), suffix: suffix.into(), wildcard })
    }

    pub fn matches(&self, path: &str) -> bool {
        let (directory, filename) = path.rsplit_once('/').unwrap_or(("", path));
        if directory != self.directory { return false; }
        if !self.wildcard { return filename == self.prefix; }
        filename.len() >= self.prefix.len() + self.suffix.len()
            && filename.starts_with(&self.prefix) && filename.ends_with(&self.suffix)
    }

    pub fn overlaps(&self, other: &Self) -> bool {
        if self.directory != other.directory { return false; }
        match (self.wildcard, other.wildcard) {
            (false, false) => self.prefix == other.prefix,
            (false, true) => other.matches_filename(&self.prefix),
            (true, false) => self.matches_filename(&other.prefix),
            // Arbitrarily long star expansions separate the prefix and suffix
            // constraints. A witness exists exactly when both literal pairs agree.
            (true, true) => (self.prefix.starts_with(&other.prefix) || other.prefix.starts_with(&self.prefix))
                && (self.suffix.ends_with(&other.suffix) || other.suffix.ends_with(&self.suffix)),
        }
    }

    fn matches_filename(&self, filename: &str) -> bool {
        filename.len() >= self.prefix.len() + self.suffix.len()
            && filename.starts_with(&self.prefix) && filename.ends_with(&self.suffix)
    }
}

pub const PLAYBOOK_PROMPT_TOKENS: &[&str] = &[
    "ARTIFACTS_DIR", "ARTIFACT_FILE", "REVIEW_HANDOFF_FILE", "SESSION_HISTORY_DIR",
    "TASK_NAME", "TASK_SLUG", "WORKTREE", "PLAYBOOK_KEY", "PHASE_KEY", "PHASE_TITLE",
    "TICKET_FILE", "PROMPT_EXTRA",
];

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    version: u32,
    key: String,
    title: String,
    description: String,
    default_model: String,
    default_harness: String,
    step: Vec<StepMetadata>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StepMetadata {
    key: String,
    title: String,
    short: String,
    is_coding_step: bool,
    auto_advance_default: bool,
    inputs: Vec<InputSelector>,
    outputs: Vec<OutputSelector>,
    model: String,
    harness: String,
}

fn check_fields(table: &toml::map::Map<String, toml::Value>, fields: &[(&str, &str)], field: &str, errors: &mut Vec<PlaybookValidationError>) {
    for (name, kind) in fields {
        let path = if field.is_empty() { (*name).to_owned() } else { format!("{field}.{name}") };
        match table.get(*name) {
            None => errors.push(PlaybookValidationError::new("missing_field", format!("required field {path} is missing"), None, Some(path))),
            Some(value) => {
                let valid = match *kind { "string" => value.is_str(), "integer" => value.is_integer(), "boolean" => value.is_bool(), "array" => value.is_array(), _ => false };
                if !valid { errors.push(PlaybookValidationError::new("invalid_field_type", format!("{path} must be {kind}"), None, Some(path))); }
            }
        }
    }
    for name in table.keys() {
        if !fields.iter().any(|(known, _)| name == known) {
            let path = if field.is_empty() { name.clone() } else { format!("{field}.{name}") };
            errors.push(PlaybookValidationError::new("unknown_field", format!("unknown field {path}"), None, Some(path)));
        }
    }
}

fn section_key(line: &str) -> Option<&str> {
    let key = line.strip_prefix("<!-- alinery:step ")?.strip_suffix(" -->")?;
    if key.is_empty() || key.chars().any(char::is_whitespace) { return None; }
    Some(key)
}

fn validate_tokens(prompt: &str, first_line: usize, field: &str, errors: &mut Vec<PlaybookValidationError>) {
    let mut offset = 0;
    while let Some(start) = prompt[offset..].find("{{").map(|pos| offset + pos) {
        let Some(end) = prompt[start + 2..].find("}}").map(|pos| start + 2 + pos) else { break; };
        if (start == 0 || prompt.as_bytes()[start - 1] != b'\\') && !PLAYBOOK_PROMPT_TOKENS.contains(&&prompt[start + 2..end]) {
            errors.push(PlaybookValidationError::new("unknown_prompt_token", format!("unknown prompt token {}", &prompt[start..end + 2]), Some(first_line + prompt[..start].bytes().filter(|b| *b == b'\n').count()), Some(field.into())));
        }
        offset = end + 2;
    }
}

pub fn parse_playbook_md(source: &str) -> Result<NormalizedPlaybook, Vec<PlaybookValidationError>> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut lines = source.split_inclusive('\n');
    if lines.next().map(|line| line.trim_end_matches(['\r', '\n'])) != Some("+++") {
        return Err(vec![PlaybookValidationError::new("missing_frontmatter", "expected v2 TOML +++ frontmatter at the beginning of the file", Some(1), None)]);
    }
    let metadata_start = source.find('\n').map_or(source.len(), |pos| pos + 1);
    let mut offset = metadata_start;
    let mut closing = None;
    for (index, line) in lines.enumerate() {
        if line.trim_end_matches(['\r', '\n']) == "+++" { closing = Some((offset, offset + line.len(), index + 3)); break; }
        offset += line.len();
    }
    let Some((metadata_end, body_start, body_line)) = closing else {
        return Err(vec![PlaybookValidationError::new("missing_frontmatter_end", "missing closing +++ delimiter", Some(1), None)]);
    };
    let metadata_source = &source[metadata_start..metadata_end];
    let value: toml::Value = match toml::from_str(metadata_source) {
        Ok(value) => value,
        Err(error) => {
            let line = error.span().map(|span| 2 + metadata_source[..span.start].bytes().filter(|b| *b == b'\n').count());
            return Err(vec![PlaybookValidationError::new("invalid_toml", error.to_string(), line, None)]);
        }
    };
    let mut errors = Vec::new();
    let table = value.as_table().expect("TOML document is a table");
    check_fields(table, &[("version", "integer"), ("key", "string"), ("title", "string"), ("description", "string"), ("default_model", "string"), ("default_harness", "string"), ("step", "array")], "", &mut errors);
    if table.get("version").and_then(toml::Value::as_integer) != Some(2) {
        errors.push(PlaybookValidationError::new("unsupported_version", "only playbook version 2 is supported", None, Some("version".into())));
    }
    if let Some(steps) = table.get("step").and_then(toml::Value::as_array) {
        if steps.is_empty() { errors.push(PlaybookValidationError::new("missing_steps", "at least one step is required", None, Some("step".into()))); }
        for (index, step) in steps.iter().enumerate() {
            let field = format!("step[{index}]");
            let Some(step) = step.as_table() else { errors.push(PlaybookValidationError::new("invalid_field_type", "step must be a table", None, Some(field))); continue; };
            check_fields(step, &[("key", "string"), ("title", "string"), ("short", "string"), ("is_coding_step", "boolean"), ("auto_advance_default", "boolean"), ("inputs", "array"), ("outputs", "array"), ("model", "string"), ("harness", "string")], &field, &mut errors);
            for name in ["inputs", "outputs"] {
                if let Some(selectors) = step.get(name).and_then(toml::Value::as_array) {
                    for (index, selector) in selectors.iter().enumerate() {
                        let field = format!("{field}.{name}[{index}]");
                        match selector.as_table() {
                            Some(selector) => {
                                let fields: &[(&str, &str)] = if name == "inputs" { &[("path", "string"), ("mode", "string")] } else { &[("path", "string")] };
                                check_fields(selector, fields, &field, &mut errors);
                                if name == "inputs" && selector.get("mode").and_then(toml::Value::as_str).is_some_and(|mode| !["single", "each", "complete"].contains(&mode)) {
                                    errors.push(PlaybookValidationError::new("invalid_input_mode", "mode must be single, each or complete", None, Some(format!("{field}.mode"))));
                                }
                            }
                            None => errors.push(PlaybookValidationError::new("invalid_field_type", "selector must be a table", None, Some(field))),
                        }
                    }
                }
            }
        }
    }
    // Scan even after metadata errors: section diagnostics remain independently useful.
    let body = &source[body_start..];
    let mut markers = Vec::new();
    offset = 0;
    for (index, line) in body.split_inclusive('\n').enumerate() {
        if let Some(key) = section_key(line.trim_end_matches(['\r', '\n'])) { markers.push((key.to_owned(), offset, offset + line.len(), body_line + index)); }
        offset += line.len();
    }
    let preamble = body[..markers.first().map_or(body.len(), |marker| marker.1)].to_owned();
    let known: HashSet<&str> = table.get("step").and_then(toml::Value::as_array).into_iter().flatten().filter_map(|step| step.get("key").and_then(toml::Value::as_str)).collect();
    let mut sections = HashMap::new();
    let mut section_order = Vec::new();
    for (index, (key, _, start, line)) in markers.iter().enumerate() {
        let end = markers.get(index + 1).map_or(body.len(), |marker| marker.1);
        let prompt = &body[*start..end];
        let field = format!("step[{key}].prompt");
        if !known.contains(key.as_str()) { errors.push(PlaybookValidationError::new("unknown_step", format!("section refers to unknown step {key}"), Some(*line), Some(field.clone()))); }
        if sections.insert(key.clone(), prompt.to_owned()).is_some() { errors.push(PlaybookValidationError::new("duplicate_step_section", format!("duplicate section for {key}"), Some(*line), Some(field.clone()))); }
        if prompt.trim().is_empty() { errors.push(PlaybookValidationError::new("empty_prompt", format!("step {key} has an empty prompt"), Some(*line), Some(field.clone()))); }
        validate_tokens(prompt, line + 1, &field, &mut errors);
        section_order.push(key.clone());
    }
    for key in known {
        if !sections.contains_key(key) { errors.push(PlaybookValidationError::new("missing_step_section", format!("missing section for {key}"), None, Some(format!("step[{key}].prompt")))); }
    }
    let metadata: Metadata = match value.try_into() {
        Ok(metadata) => metadata,
        Err(error) => {
            if errors.is_empty() { errors.push(PlaybookValidationError::new("invalid_metadata", error.to_string(), None, None)); }
            return Err(errors);
        }
    };
    if !valid_playbook_key(&metadata.key) { errors.push(PlaybookValidationError::new("invalid_key", "playbook key must be a lowercase ASCII slug", None, Some("key".into()))); }
    if metadata.title.trim().is_empty() { errors.push(PlaybookValidationError::new("empty_title", "playbook title must not be empty", None, Some("title".into()))); }
    let mut keys = HashSet::new();
    let mut outputs: Vec<(&str, &str, ArtifactSelector)> = Vec::new();
    for step in &metadata.step {
        let field = format!("step[{}]", step.key);
        if !valid_playbook_key(&step.key) { errors.push(PlaybookValidationError::new("invalid_key", "step key must be a lowercase ASCII slug", None, Some(format!("{field}.key")))); }
        if !keys.insert(&step.key) { errors.push(PlaybookValidationError::new("duplicate_step", format!("duplicate step {}", step.key), None, Some(format!("{field}.key")))); }
        if step.title.trim().is_empty() { errors.push(PlaybookValidationError::new("empty_title", "step title must not be empty", None, Some(format!("{field}.title")))); }
        let mut collection_inputs = 0;
        for (index, input) in step.inputs.iter().enumerate() {
            let field = format!("{field}.inputs[{index}]");
            if input.mode != InputMode::Single { collection_inputs += 1; }
            match ArtifactSelector::parse(&input.path) {
                Ok(selector) => {
                    if selector.wildcard != (input.mode != InputMode::Single) { errors.push(PlaybookValidationError::new("input_mode_path", "single requires an exact path; each/complete require one wildcard", None, Some(field.clone()))); }
                    if step.is_coding_step && (selector.wildcard || input.mode != InputMode::Single) { errors.push(PlaybookValidationError::new("coding_input", "coding steps may consume only exact single inputs", None, Some(field))); }
                }
                Err(message) => errors.push(PlaybookValidationError::new("invalid_selector", message, None, Some(format!("{field}.path")))),
            }
        }
        if collection_inputs > 1 { errors.push(PlaybookValidationError::new("multiple_collections", "a step may consume only one each or complete collection", None, Some(format!("{field}.inputs")))); }
        if step.outputs.is_empty() { errors.push(PlaybookValidationError::new("missing_outputs", "a step requires at least one output", None, Some(format!("{field}.outputs")))); }
        for (index, output) in step.outputs.iter().enumerate() {
            match ArtifactSelector::parse(&output.path) {
                Ok(selector) => {
                    if output.path.split('/').next().is_some_and(|part| matches!(part, "attachments" | "subtasks")) {
                        errors.push(PlaybookValidationError::new("reserved_output_namespace", "attachments and subtasks are reserved output namespaces", None, Some(format!("{field}.outputs[{index}].path"))));
                    }
                    for (other_key, other_path, other) in &outputs {
                        if selector.overlaps(other) { errors.push(PlaybookValidationError::new("overlapping_outputs", format!("step {} output {:?} overlaps step {} output {:?}", step.key, output.path, other_key, other_path), None, Some(format!("{field}.outputs[{index}].path")))); }
                    }
                    outputs.push((&step.key, &output.path, selector));
                }
                Err(message) => errors.push(PlaybookValidationError::new("invalid_selector", message, None, Some(format!("{field}.outputs[{index}].path")))),
            }
        }
    }
    if !errors.is_empty() { return Err(errors); }
    Ok(NormalizedPlaybook {
        version: metadata.version, key: metadata.key, title: metadata.title, description: metadata.description,
        default_model: metadata.default_model, default_harness: metadata.default_harness,
        step: metadata.step.into_iter().map(|step| NormalizedStep {
            prompt: sections.remove(&step.key).expect("validated section"), key: step.key, title: step.title,
            short: step.short, is_coding_step: step.is_coding_step, auto_advance_default: step.auto_advance_default,
            inputs: step.inputs, outputs: step.outputs, model: step.model, harness: step.harness,
        }).collect(), preamble, section_order,
    })
}

// Canonical metadata uses single-line TOML basic strings. Generic TOML
// serializers may choose multiline literals whose standalone +++ line would
// terminate the Markdown frontmatter envelope.
fn render_basic_string(output: &mut String, value: &str) {
    use std::fmt::Write;
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{8}' => output.push_str("\\b"),
            '\u{c}' => output.push_str("\\f"),
            '\0'..='\u{1f}' | '\u{7f}' => write!(output, "\\u{:04X}", character as u32).expect("string write"),
            character => output.push(character),
        }
    }
    output.push('"');
}

fn render_string_field(output: &mut String, key: &str, value: &str) {
    output.push_str(key);
    output.push_str(" = ");
    render_basic_string(output, value);
    output.push('\n');
}

/// Canonical metadata, verbatim document text. Callers accepting editable DTOs
/// must parse the result before persisting it, just as for a source-file import.
pub fn render_playbook_md(playbook: &NormalizedPlaybook) -> String {
    use std::fmt::Write;
    let mut result = format!("+++\nversion = {}\n", playbook.version);
    for (key, value) in [
        ("key", playbook.key.as_str()), ("title", playbook.title.as_str()),
        ("description", playbook.description.as_str()), ("default_model", playbook.default_model.as_str()),
        ("default_harness", playbook.default_harness.as_str()),
    ] {
        render_string_field(&mut result, key, value);
    }
    if playbook.step.is_empty() { result.push_str("step = []\n"); }
    for step in &playbook.step {
        result.push_str("\n[[step]]\n");
        for (key, value) in [
            ("key", step.key.as_str()), ("title", step.title.as_str()), ("short", step.short.as_str()),
            ("model", step.model.as_str()), ("harness", step.harness.as_str()),
        ] {
            render_string_field(&mut result, key, value);
        }
        writeln!(result, "is_coding_step = {}\nauto_advance_default = {}", step.is_coding_step, step.auto_advance_default).expect("string write");
        result.push_str("inputs = [");
        for (index, input) in step.inputs.iter().enumerate() {
            if index != 0 { result.push_str(", "); }
            result.push_str("{ path = ");
            render_basic_string(&mut result, &input.path);
            result.push_str(", mode = ");
            render_basic_string(&mut result, match input.mode { InputMode::Single => "single", InputMode::Each => "each", InputMode::Complete => "complete" });
            result.push_str(" }");
        }
        result.push_str("]\noutputs = [");
        for (index, output) in step.outputs.iter().enumerate() {
            if index != 0 { result.push_str(", "); }
            result.push_str("{ path = ");
            render_basic_string(&mut result, &output.path);
            result.push_str(" }");
        }
        result.push_str("]\n");
    }
    result.push_str("+++\n");
    result.push_str(&playbook.preamble);
    let mut written = HashSet::new();
    for key in playbook.section_order.iter().chain(playbook.step.iter().map(|step| &step.key)) {
        if !written.insert(key) { continue; }
        if let Some(step) = playbook.step.iter().find(|step| &step.key == key) {
            if !result.ends_with('\n') { result.push('\n'); }
            result.push_str(&format!("<!-- alinery:step {} -->\n", step.key));
            result.push_str(&step.prompt);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        "+++\nversion = 2\nkey = \"test\"\ntitle = \"Test\"\ndescription = \"\"\ndefault_model = \"\"\ndefault_harness = \"\"\n[[step]]\nkey = \"run\"\ntitle = \"Run\"\nshort = \"\"\nis_coding_step = false\nauto_advance_default = false\ninputs = [{path = \"ticket.md\", mode = \"single\"}]\noutputs = [{path = \"result.md\"}]\nmodel = \"\"\nharness = \"\"\n+++\nPreamble\n<!-- alinery:step run -->\nRead {{TICKET_FILE}}.\n".into()
    }

    fn rejects(source: &str, code: &str) {
        let errors = parse_playbook_md(source).expect_err("invalid definition must be rejected");
        assert!(errors.iter().any(|error| error.code == code), "{errors:?}");
        assert!(errors.iter().all(|error| error.severity == "error"));
    }

    #[test]
    fn round_trip_preserves_document_text_and_section_order() {
        let mut definition = parse_playbook_md(&fixture()).unwrap();
        let mut second = definition.step[0].clone();
        second.key = "other".into();
        second.outputs[0].path = "other.md".into();
        second.prompt = "# Arbitrary heading\r\n```toml\r\n+++\r\n```\r\n\\{{NOT_A_TOKEN}}\r\n".into();
        definition.step.push(second);
        definition.section_order = vec!["other".into(), "run".into()];
        definition.preamble = "Preamble\r\n<!-- ordinary comment -->\r\n".into();
        let rendered = render_playbook_md(&definition);
        assert_eq!(parse_playbook_md(&rendered).unwrap(), definition);
        assert_eq!(render_playbook_md(&parse_playbook_md(&rendered).unwrap()), rendered);
        let crlf = format!("\u{feff}{}", fixture().replace('\n', "\r\n"));
        let parsed = parse_playbook_md(&crlf).unwrap();
        assert_eq!(parsed.step[0].prompt, "Read {{TICKET_FILE}}.\r\n");
        assert_eq!(parse_playbook_md(&render_playbook_md(&parsed)).unwrap(), parsed);
    }

    #[test]
    fn rejects_invalid_envelope_and_schema() {
        for source in ["", "---\nversion: 1\n---", "text\n+++\n", " +++\n"] {
            rejects(source, "missing_frontmatter");
        }
        rejects("+++\nversion = 2\n", "missing_frontmatter_end");
        rejects(&fixture().replace("version = 2", "version = ["), "invalid_toml");
        for value in ["1", "3", "\"2\""] {
            rejects(&fixture().replace("version = 2", &format!("version = {value}")), "unsupported_version");
        }
    }

    #[test]
    fn requires_all_fields_and_safe_unique_identities() {
        let source = fixture();
        // Removing each authored field independently guards against accidental
        // serde defaults, including explicit empty strings and false flags.
        for (removed, _) in source.split_inclusive('\n').enumerate().filter(|(_, line)| line.contains(" = ")) {
            let missing_field: String = source.split_inclusive('\n').enumerate().filter_map(|(index, line)| (index != removed).then_some(line)).collect();
            rejects(&missing_field, "missing_field");
        }
        for key in ["Bad", "-bad", "a/b", "a.b", "a b", "é"] {
            rejects(&source.replacen("key = \"test\"", &format!("key = \"{key}\""), 1), "invalid_key");
        }
        assert!(parse_playbook_md(&source.replacen("key = \"test\"", "key = \"0-a\"", 1)).is_ok());
        rejects(&source.replacen("title = \"Test\"", "title = \" \"", 1), "empty_title");
        let mut definition = parse_playbook_md(&source).unwrap();
        definition.step.push(definition.step[0].clone());
        rejects(&render_playbook_md(&definition), "duplicate_step");
        definition.step.clear();
        definition.section_order.clear();
        rejects(&render_playbook_md(&definition), "missing_steps");
    }

    #[test]
    fn rejects_unknown_fields_at_every_schema_level() {
        for field in ["steps", "edge", "columns", "kind", "typo"] {
            rejects(&fixture().replacen("version = 2", &format!("version = 2\n{field} = []"), 1), "unknown_field");
        }
        for field in ["artifact", "prompt", "prompt_inline", "column", "kind", "human", "retry", "retry_max", "attempts", "rerun", "rerun_on_failure", "on_failure", "completion", "human_approval", "allow_empty_prompt"] {
            rejects(&fixture().replace("short = \"\"", &format!("short = \"\"\n{field} = \"\"")), "unknown_field");
        }
        rejects(&fixture().replace("mode = \"single\"", "mode = \"single\", optional = true"), "unknown_field");
        rejects(&fixture().replace("{path = \"result.md\"}", "{path = \"result.md\", mode = \"single\"}"), "unknown_field");
        rejects(&fixture().replace("{path = \"result.md\"}", "\"result.md\""), "invalid_field_type");
        rejects(&fixture().replace("{path = \"result.md\"}", "{}"), "missing_field");
        rejects(&fixture().replace("mode = \"single\"", "mode = \"zip\""), "invalid_input_mode");
    }

    #[test]
    fn sections_delimit_inside_fences_but_not_inline_examples() {
        let source = fixture();
        let duplicate = format!("{source}```markdown\n<!-- alinery:step run -->\nsecond\n```\n");
        let errors = parse_playbook_md(&duplicate).unwrap_err();
        let duplicate_error = errors.iter().find(|error| error.code == "duplicate_step_section").unwrap();
        assert_eq!(duplicate_error.line, Some(source.lines().count() + 2));
        rejects(&source.replace("<!-- alinery:step run -->", "<!-- alinery:step missing -->"), "unknown_step");
        rejects(&source.replace("<!-- alinery:step run -->", "inline <!-- alinery:step run -->"), "missing_step_section");
        rejects(&source.replace("Read {{TICKET_FILE}}.", " "), "empty_prompt");
        let with_examples = format!("{source}inline <!-- alinery:step unknown -->\n <!-- alinery:step unknown -->\n<!-- alinery:step  unknown -->\n");
        assert!(parse_playbook_md(&with_examples).is_ok());
    }

    #[test]
    fn paths_and_modes_reject_unsafe_or_ambiguous_collections() {
        for path in ["/x.md", "", "../x.md", "a/./x.md", "a/../x.md", "a//x.md", "x.txt", "**.md", "*/x.md", "a*b*.md", "C:\\x.md", "a\\x.md", "a?.md"] {
            assert!(ArtifactSelector::parse(path).is_err(), "{path}");
        }
        assert!(ArtifactSelector::parse("research/result-*.md").unwrap().matches("research/result-12.md"));
        rejects(&fixture().replace("ticket.md", "ticket-*.md"), "input_mode_path");
        rejects(&fixture().replace("mode = \"single\"", "mode = \"each\""), "input_mode_path");
        let each = fixture().replace("ticket.md", "ticket-*.md").replace("mode = \"single\"", "mode = \"each\"");
        assert!(parse_playbook_md(&each).is_ok());
        rejects(&each.replace("is_coding_step = false", "is_coding_step = true"), "coding_input");
        let mixed = each.replace("mode = \"each\"}", "mode = \"each\"}, {path = \"other-*.md\", mode = \"complete\"}");
        rejects(&mixed, "multiple_collections");
        rejects(&fixture().replace("outputs = [{path = \"result.md\"}]", "outputs = []"), "missing_outputs");
        for namespace in ["attachments", "subtasks"] {
            rejects(&fixture().replace("result.md", &format!("{namespace}/result.md")), "reserved_output_namespace");
        }
        assert!(parse_playbook_md(&fixture().replace("result.md", "nested/attachments/result-*.md").replace("is_coding_step = false", "is_coding_step = true")).is_ok());
    }

    #[test]
    fn tokens_validate_allowlist_without_losing_escapes() {
        let all = PLAYBOOK_PROMPT_TOKENS.iter().map(|token| format!("{{{{{token}}}}}")).collect::<Vec<_>>().join(" ");
        assert!(parse_playbook_md(&fixture().replace("Read {{TICKET_FILE}}.", &all)).is_ok());
        for token in ["{{UNKNOWN}}", "{{task_name}}", "{{ TASK_NAME }}"] {
            rejects(&fixture().replace("Read {{TICKET_FILE}}.", token), "unknown_prompt_token");
        }
        let literal = "\\{{UNKNOWN}} \\{{TASK_NAME}} incomplete {{ fine }";
        let parsed = parse_playbook_md(&fixture().replace("Read {{TICKET_FILE}}.", literal)).unwrap();
        assert_eq!(parse_playbook_md(&render_playbook_md(&parsed)).unwrap().step[0].prompt, format!("{literal}\n"));
    }

    #[test]
    fn exact_star_intersection_detects_nontrivial_ambiguity() {
        for (left, right, expected) in [
            ("x.md", "x.md", true), ("result-a.md", "result-*.md", true),
            ("ab*.md", "*bc.md", true), ("*a.md", "*b.md", false),
            ("result-a*.md", "result-b*.md", false), ("a/*.md", "b/*.md", false),
            ("abc.md", "abc*.md", true), ("a.md", "a*a.md", false),
        ] {
            let left = ArtifactSelector::parse(left).unwrap();
            let right = ArtifactSelector::parse(right).unwrap();
            assert_eq!(left.overlaps(&right), expected, "{left:?}, {right:?}");
            assert_eq!(right.overlaps(&left), expected);
        }
        rejects(&fixture().replace("{path = \"result.md\"}", "{path = \"result.md\"}, {path = \"result*.md\"}"), "overlapping_outputs");
        let mut definition = parse_playbook_md(&fixture()).unwrap();
        let mut other = definition.step[0].clone();
        other.key = "other".into();
        other.outputs[0].path = "result*.md".into();
        definition.step.push(other);
        rejects(&render_playbook_md(&definition), "overlapping_outputs");
        definition.step[1].outputs[0].path = "ticket.md".into();
        definition.step[1].inputs[0].path = "result.md".into();
        assert!(parse_playbook_md(&render_playbook_md(&definition)).is_ok(), "cycles are valid");
    }

    #[test]
    fn reports_independent_section_and_selector_errors() {
        let source = fixture().replace("result.md", "../result.md").replace("<!-- alinery:step run -->", "<!-- alinery:step missing -->");
        let errors = parse_playbook_md(&source).unwrap_err();
        assert!(errors.iter().any(|error| error.code == "invalid_selector" && error.field.as_deref() == Some("step[run].outputs[0].path")));
        assert!(errors.iter().any(|error| error.code == "unknown_step" && error.line.is_some()));
    }

    #[test]
    fn renderer_keeps_frontmatter_delimiters_inside_metadata_strings() {
        let mut definition = parse_playbook_md(&fixture()).unwrap();
        for description in ["before\n+++\nafter", "\"quoted\" \\\n\r\t\u{8}\u{c}\0\u{1f}\u{7f} café"] {
            definition.description = description.into();
            let rendered = render_playbook_md(&definition);
            assert_eq!(parse_playbook_md(&rendered).unwrap(), definition);
        }
    }
}
