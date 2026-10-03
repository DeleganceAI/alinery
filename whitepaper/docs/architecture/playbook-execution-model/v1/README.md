# Playbook Execution Model V1

This directory preserves the original Playbook execution-model specification
from PR #237 at commit `8aaab0b1928db358385bc17206e93d4f939734f3`.
It is the historical V1 design dossier and must not be revised in place; later
versions belong in sibling version directories.

The snapshot includes the LaTeX source and all three Markdown Playbook files
included by the document. The only source changes made while versioning V1
were the three `\\lstinputlisting` paths, which now point to these preserved
copies.

The corresponding checked-in PDF is:

`output/pdf/playbook-execution-model/v1/alinery-playbook-execution-model.pdf`

Its SHA-256 digest is:

`b5c571b0185e76a93cfb9bc3f1ee801bf9589ab7a7a49ad09bf8b519b3006ff8`

To rebuild from the repository root without overwriting the preserved PDF:

```sh
mkdir -p /tmp/alinery-playbook-v1
latexmk -xelatex -interaction=nonstopmode -halt-on-error \
  -outdir=/tmp/alinery-playbook-v1 \
  docs/architecture/playbook-execution-model/v1/playbook-execution-model.tex
```
