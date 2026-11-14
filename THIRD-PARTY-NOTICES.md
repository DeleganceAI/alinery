# Third-party notices

Third-party components retain their respective licenses. The notices below cover
the daemon's Bun runtime and pi, the bundled Git fallback, the bundled Python, the bundled fonts, the bundled SuperDevelop
adaptations, and thinking-orbs; other dependencies retain their own license and notice requirements.

## Git

When a machine has no git the app can see, the release archive's `git/` tree is
installed beside Alinery. It is a separate program built from the official
tarball pinned in `scripts/git-pin.txt` (sha256 in `scripts/git-pin.sha256`),
downloaded from `https://mirrors.kernel.org/pub/software/scm/git/`. Alinery does
not link Git. The tree ships Git's `COPYING` (GPL-2.0) and a `SOURCE` file
naming that tarball.

## Python

Each runtime archive (`resources/remote/<triple>.tar.gz`) carries a `python/`
tree for the office skills: a CPython build from
[python-build-standalone](https://github.com/astral-sh/python-build-standalone),
pinned by release and sha256 in `scripts/python-runtime/stage.sh`, with the
packages locked in `scripts/python-runtime/requirements.txt` installed from
PyPI wheels. Alinery runs it as a separate program and does not link it.
CPython is under the PSF License (`python/lib/python3.12/LICENSE.txt`, which
also lists the licenses of what CPython bundles). Each package, pip included,
keeps its license in its `*.dist-info` directory under
`python/lib/python3.12/site-packages/`; all are permissive (MIT, BSD, PSF,
Apache-2.0 or BSD, MIT-CMU).

## Fonts

The app's interface bundles three typefaces, installed from Fontsource and built
into the webview's assets: Geist and Geist Mono (`@fontsource-variable/geist`,
`@fontsource-variable/geist-mono`; Copyright 2024 The Geist Project Authors,
https://github.com/vercel/geist-font) and Sora (`@fontsource/sora`, weights 400
and 600; Copyright 2019 The Sora Project Authors,
https://github.com/sora-xor/sora-font). All three are under the SIL Open Font
License 1.1, reproduced below from the installed package.

---

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

---

## Included skills

`alinery-app/src-tauri/vinculum-daemon/skills/` (shipped as each runtime
archive's `skills/`) holds copies of agent skills, pinned by commit in
`scripts/update-included-skills.sh`:

- `docx`, `pdf`, `pptx`, `xlsx` and `internal-comms` from
  [anthropics/skills](https://github.com/anthropics/skills), Apache License 2.0;
  each directory keeps its `LICENSE.txt`.
- The other skills from
  [claude-office-skills/skills](https://github.com/claude-office-skills/skills),
  MIT License, in `skills/LICENSE.claude-office-skills.txt`. Our copies change
  each skill's frontmatter `name` to its directory name and replace six empty
  descriptions.

## Bun and pi

`alinery-vinculum-daemon` is a [Bun](https://bun.sh) executable compiled with
`bun build --compile` (the version pinned in `scripts/bun-pin.txt`), so it
carries the Bun runtime. Bun is MIT-licensed and links JavaScriptCore and other
libraries under their own licenses, JavaScriptCore under the LGPL-2.0; Bun's
`LICENSE.md` lists them all.

The agent runtime inside it is [pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-durable`, `pi-ai` and their siblings, versions locked in
`alinery-app/src-tauri/vinculum-daemon/bun.lock`), MIT-licensed. The license text
follows, copied verbatim from `https://github.com/earendil-works/pi` `LICENSE`.

---

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## SuperDevelop / Superpowers

The bundled SuperDevelop prompts are modified adaptations of
[Superpowers](https://github.com/obra/superpowers) at commit
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`, used under the MIT license.
The source files and adaptation details are recorded in
`alinery-app/src-tauri/playbooks/superdevelop/README.md`.

The upstream license follows.

---

MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## thinking-orbs

Alinery uses [thinking-orbs](https://github.com/Jakubantalik/thinking-orbs)
version 0.3.1 for animated status indicators.

The following MIT license is reproduced from the installed package.

---

MIT License

Copyright (c) 2026 Jakub Antalik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
