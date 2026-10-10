# Finite Agent Machines

This folder contains the current paper, its LaTeX source, and the files needed
to compile it. Open [finite-agent-machines.pdf](finite-agent-machines.pdf) to
read the paper; edit [finite-agent-machines.tex](finite-agent-machines.tex).

## Build the PDF

Use `latexmk`, pdfLaTeX, and BibTeX from a TeX distribution that supplies the
packages imported by the source, including TikZ, `listings`, and `needspace`.
The checked build used TeX Live 2026. Keep the bundled `aaai2026.sty` and
`aaai2026.bst` files unmodified, including their license notices.

From the repository root:

```sh
latexmk -cd -pdf -interaction=nonstopmode -halt-on-error -outdir=build whitepaper/finite-agent-machines.tex
cp whitepaper/build/finite-agent-machines.pdf whitepaper/finite-agent-machines.pdf
```

The `examples/` files are included as listings in the appendices. Keep their
relative paths intact. Building the PDF does not execute these examples and
does not require their Node, Python, or agent runtimes.

## Reproduce the comparison examples

This folder includes the 17 files printed in the paper. The appendix commands
for fixture tests and live execution assume the **full reproduction bundle**,
which also contains test drivers, lockfiles, generators, and verification
records. Those additional files are preserved in the
[comparison source archive](https://github.com/DeleganceAI/alinery/tree/3204b5d9964a1e94350947af29fe6358fc2c22d6/whitepaper/docs/architecture/process-comparison) at commit `3204b5d9964a1e94350947af29fe6358fc2c22d6` on the
`whitepaper` branch.

Download the [full source bundle](https://raw.githubusercontent.com/DeleganceAI/alinery/3204b5d9964a1e94350947af29fe6358fc2c22d6/whitepaper/docs/architecture/process-comparison/process-comparison-bundle.zip), extract
it outside this folder, and follow its `process-comparison/RUNNING.md` and the
per-system instructions. The [companion comparison PDF](https://raw.githubusercontent.com/DeleganceAI/alinery/3204b5d9964a1e94350947af29fe6358fc2c22d6/whitepaper/docs/architecture/process-comparison/process-comparison.pdf)
describes the comparison and verification scope. Fixture checks are not
live-model validation.

The initial publication source was taken from the same commit, with include
paths adjusted for this folder. Subsequent manuscript revisions are maintained
here.
Earlier paper versions and working notes remain on the `whitepaper` branch.
