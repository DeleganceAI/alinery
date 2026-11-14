#!/usr/bin/env bash
# Refresh the skills Alinery includes (alinery-app/src-tauri/vinculum-daemon/skills/) from their pinned upstream commits.
#
# Anthropic's document skills come from anthropics/skills (Apache-2.0, each directory keeps its LICENSE.txt); the office
# set from claude-office-skills/skills (MIT, LICENSE.claude-office-skills.txt). Both are copied as they are, except the
# office skills whose frontmatter says `description: ">"` (a YAML slip upstream), which get the description below, and
# an office skill's `name:`, which becomes its directory name (a few upstream use a title, like "PDF Merge & Split"; the
# directory name is the key Settings turns a skill on and off by).
# Which skills start off is skills/included.json, which this script leaves alone. To move a pin, change it here, run this,
# and read the diff: the skills are prompts and scripts an agent will run.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/alinery-app/src-tauri/vinculum-daemon/skills"

ANTHROPIC_REPO=https://github.com/anthropics/skills
ANTHROPIC_PIN=ca45fc496a3436251f191354091d557da31c15b5
# doc-coauthoring is left out: upstream ships it without a LICENSE.txt, and the repository has no license of its own.
ANTHROPIC_SKILLS=(docx pdf pptx xlsx internal-comms)

OFFICE_REPO=https://github.com/claude-office-skills/skills
OFFICE_PIN=9c4c7d5cd2813a8936bf2c9fdb174ea883b85a11
OFFICE_SKILLS=(
  md-to-office office-to-md pdf-converter pdf-to-docx pdf-merge-split md-slides chart-designer data-analysis file-organizer
  table-extractor pdf-compress pdf-watermark pdf-ocr html-to-ppt ppt-visual batch-convert report-generator
  invoice-generator nda-generator contract-review meeting-notes proposal-writer
)
description_for() {
  case "$1" in
    md-to-office) echo "Convert Markdown to Word, PowerPoint, PDF and other Office formats with Pandoc" ;;
    office-to-md) echo "Convert Word, Excel, PowerPoint and PDF files to Markdown with markitdown" ;;
    md-slides) echo "Write a presentation in Markdown and export it to PDF, PPTX or HTML with Marp" ;;
    table-extractor) echo "Extract tables from PDF documents, including merged cells, borderless and multi-page tables, with camelot" ;;
    nda-generator) echo "Draft one-way or mutual non-disclosure agreements for investors, contractors and partnerships" ;;
    meeting-notes) echo "Turn raw meeting notes or transcripts into structured notes with decisions and action items" ;;
    *) return 1 ;;
  esac
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/alinery-skills.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fetch() { # repo pin dir
  git init -q "$3"
  git -C "$3" fetch -q --depth 1 "$1" "$2"
  git -C "$3" checkout -q FETCH_HEAD
}
fetch "$ANTHROPIC_REPO" "$ANTHROPIC_PIN" "$WORK/anthropic"
fetch "$OFFICE_REPO" "$OFFICE_PIN" "$WORK/office"

for name in "${ANTHROPIC_SKILLS[@]}" "${OFFICE_SKILLS[@]}" doc-coauthoring; do rm -rf "${OUT:?}/$name"; done
mkdir -p "$OUT"
for name in "${ANTHROPIC_SKILLS[@]}"; do
  cp -R "$WORK/anthropic/skills/$name" "$OUT/$name"
  [ -f "$OUT/$name/LICENSE.txt" ] || { echo "ERROR: anthropics/skills $name has no LICENSE.txt" >&2; exit 1; }
done
for name in "${OFFICE_SKILLS[@]}"; do
  cp -R "$WORK/office/$name" "$OUT/$name"
  # The first `name:` is the frontmatter's: every SKILL.md starts with it.
  NAME="$name" perl -0pi -e 's/^name: .*$/name: $ENV{NAME}/m' "$OUT/$name/SKILL.md"
  if grep -q '^description: ">"$' "$OUT/$name/SKILL.md"; then
    text="$(description_for "$name")" || { echo "ERROR: $name has the broken description and none is written here" >&2; exit 1; }
    DESC="$text" perl -0pi -e 's/^description: ">"$/description: "$ENV{DESC}"/m' "$OUT/$name/SKILL.md"
  fi
done
cp "$WORK/office/LICENSE" "$OUT/LICENSE.claude-office-skills.txt"
find "$OUT" -name .DS_Store -delete
echo "skills ready: $OUT (anthropics/skills $ANTHROPIC_PIN, claude-office-skills/skills $OFFICE_PIN)"
