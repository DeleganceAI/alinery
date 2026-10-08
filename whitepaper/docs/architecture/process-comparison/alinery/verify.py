"""Compile the fixture driver against the real, pinned Alinery core crate."""
import argparse,json,os,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--alinery-source',type=Path,required=True);a=p.parse_args()
here=Path(__file__).resolve().parent
crate=(a.alinery_source/'alinery-app/src-tauri/alinery-core').resolve()
if not (crate/'Cargo.toml').is_file():p.error('alinery-core/Cargo.toml not found')
with tempfile.TemporaryDirectory(prefix='fam-alinery-check-') as td:
 manifest=Path(td)/'Cargo.toml'
 manifest.write_text('[package]\nname="fam-alinery-check"\nversion="0.1.0"\nedition="2021"\n[workspace]\n[[bin]]\nname="verify"\npath='+json.dumps(str(here/'verify.rs'))+'\n[dependencies]\nalinery-core={path='+json.dumps(str(crate))+'}\nserde_json="1"\n')
 subprocess.run(['cargo','run','--offline','--quiet','--manifest-path',str(manifest),'--',str(here.parent)],check=True)
