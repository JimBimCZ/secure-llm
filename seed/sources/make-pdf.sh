#!/usr/bin/env bash
# Regenerates 10-networking-nic.pdf from its Markdown source.
#
# Why a PDF at all: ingest accepts .md, .txt and .pdf, so the seed set exercises all
# three formats on first boot rather than leaving the PDF path untested until someone
# uploads one by hand.
# Why a script: the committed binary should be reproducible from a source we can diff,
# not an artefact nobody can regenerate.
#
# macOS only (textutil/cupsfilter are system tools). The PDF is committed, so this only
# needs re-running when the Markdown source changes.
set -euo pipefail
cd "$(dirname "$0")"           # seed/sources

src="10-networking-nic.md"
out="../10-networking-nic.pdf"   # the PDF is the ingestable artefact; this .md is not
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# cupsfilter's text-to-PDF path writes MacRoman, so an em-dash comes back out of a PDF
# text extractor as garbage. Fold to ASCII and strip the Markdown markup that would
# otherwise appear literally. Deliberately crude: it handles the subset of Markdown this
# one source file actually uses.
python3 - "$src" > "$tmp/plain.txt" <<'PY'
import re, sys

text = open(sys.argv[1], encoding="utf-8").read()
for src_ch, dst in (("—", " - "), ("–", "-"), ("×", "x")):
    text = text.replace(src_ch, dst)

out = []
for line in text.splitlines():
    line = re.sub(r"^#{1,6} ", "", line)   # headings
    line = line.replace("**", "")          # bold
    line = re.sub(r"^- ", "* ", line)      # list bullets
    out.append(line)
print("\n".join(out))

assert all(ord(c) < 128 for c in "\n".join(out)), "non-ASCII survived the fold"
PY

cupsfilter -t "Networking notes" "$tmp/plain.txt" > "$out" 2>/dev/null

echo "wrote $out ($(wc -c < "$out" | tr -d ' ') bytes)"
