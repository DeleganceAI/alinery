# Playbook Execution Model V2

V2 is a compact, self-contained conference-paper draft derived from the
preserved V1 design dossier. It uses one research-to-design Playbook throughout
and progressively introduces linear handoffs, late-grounded branching,
coverage-checked merging, and forward-only recurrence.

Drafting constraints:

- target roughly eight pages of main text, without treating that as a hard limit;
- use Figure 1 to describe the running Playbook in the main paper;
- keep the schematic Playbook definition in Appendix A;
- present executable semantics and a worked example without empirical results
  or evaluation discussion;
- keep the semantic model distinct from unresolved production policy;
- leave V1 unchanged as the detailed historical source.

The source uses the unmodified `aaai2026.sty` and `aaai2026.bst` files from
the official AAAI-26 author kit linked by ICAPS-26. The paper is formatted as an
attributed working draft; submission decisions remain open.

Build from the repository root:

```sh
mkdir -p /tmp/alinery-playbook-v2
latexmk -cd -pdf -interaction=nonstopmode -halt-on-error \
  -outdir=/tmp/alinery-playbook-v2 \
  docs/architecture/playbook-execution-model/v2/playbook-execution-model.tex
```

The checked draft PDF lives at:

`output/pdf/playbook-execution-model/v2/alinery-playbook-execution-model-v2.pdf`
