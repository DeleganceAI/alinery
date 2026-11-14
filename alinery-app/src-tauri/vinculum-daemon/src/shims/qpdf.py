# qpdf for a machine without it: the included pdf skills show qpdf for merging, splitting, rotating, decrypting and
# encrypting pages. Written on the bundled Python's pypdf. Covers those commands; repair, linearize, optimize and the
# rest fail loudly and name the real qpdf, which takes over once installed: this stand-in sits with the agent shell's
# other shims (agentShell.ts), last on PATH.
import re
import sys

REAL = "install qpdf for that (macOS: brew install qpdf; Debian or Ubuntu: sudo apt install qpdf); once it is on PATH it replaces this stand-in"
USAGE = """usage (Alinery's qpdf stand-in, written on pypdf):
  qpdf [--password=P] [--decrypt] in.pdf [--pages FILE [--password=P] [RANGE] ... --] [--rotate=[+|-]ANGLE[:RANGE]] [--split-pages[=N]] out.pdf
  qpdf --empty --pages FILE [RANGE] ... -- out.pdf
  qpdf in.pdf --encrypt USER OWNER 40|128|256 [--print=none] [--modify=none] -- out.pdf
  qpdf --show-encryption in.pdf
RANGE: 1,3-5,8-z  (z is the last page, r1 counts from the end, 5-1 runs backwards, :odd or :even picks from the result)"""
TERM = r"(?:r?\d+|z|end)"
RANGE = re.compile(rf"^{TERM}(?:-{TERM})?(?:,{TERM}(?:-{TERM})?)*(?::(?:odd|even))?$|^:(?:odd|even)$")
NUMBERED = re.compile(r"%0?\d*d")


def fail(message):
    sys.exit(f"qpdf (Alinery's stand-in): {message}")


def pages_of(spec, count):
    """Zero-based page indexes for a qpdf page range over `count` pages; an empty range is every page."""
    spec, _, parity = (spec or "").partition(":")

    def num(t):
        return count if t in ("z", "end") else count - int(t[1:]) + 1 if t.startswith("r") else int(t)

    picked = []
    for item in spec.split(",") if spec else [f"1-{count}"]:
        a, _, b = item.partition("-")
        a, b = num(a), num(b or a)
        if not (1 <= a <= count and 1 <= b <= count):
            fail(f"page range {item} is outside 1-{count}")
        picked += range(a, b + 1) if a <= b else range(a, b - 1, -1)
    if parity:
        picked = picked[0 if parity == "odd" else 1 :: 2]
    return [n - 1 for n in picked]


def main(args):
    from pypdf import PdfReader, PdfWriter
    from pypdf.constants import UserAccessPermissions as U

    files, groups, rotations = [], None, []
    password, empty, decrypt, split, show, encrypt = "", False, False, 0, False, None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--pages":
            groups, i = [], i + 1
            while i < len(args) and args[i] != "--":
                group = [args[i], "", ""]
                i += 1
                if i < len(args) and args[i].startswith("--password="):
                    group[1], i = args[i].split("=", 1)[1], i + 1
                if i < len(args) and args[i] != "--" and RANGE.match(args[i]):
                    group[2], i = args[i], i + 1
                groups.append(group)
            if i == len(args):
                fail("--pages needs a closing --")
        elif a == "--encrypt":
            if len(args) < i + 4 or args[i + 3] not in ("40", "128", "256"):
                fail("--encrypt needs USER OWNER and 40, 128 or 256")
            encrypt, i = {"user": args[i + 1], "owner": args[i + 2], "bits": args[i + 3], "deny": U(0)}, i + 4
            while i < len(args) and args[i] != "--":
                if args[i] == "--print=none":
                    encrypt["deny"] |= U.PRINT | U.PRINT_TO_REPRESENTATION
                elif args[i] == "--modify=none":
                    encrypt["deny"] |= U.MODIFY | U.ADD_OR_MODIFY | U.FILL_FORM_FIELDS | U.ASSEMBLE_DOC
                elif args[i] not in ("--print=full", "--modify=all"):
                    fail(f"--encrypt option {args[i]} is not supported; {REAL}")
                i += 1
            if i == len(args):
                fail("--encrypt needs a closing --")
        elif a.startswith("--password="):
            password = a.split("=", 1)[1]
        elif a.startswith("--rotate="):
            rotations.append(a.split("=", 1)[1])
        elif a == "--split-pages" or a.startswith("--split-pages="):
            split = int(a.partition("=")[2] or 1)
        elif a == "--empty":
            empty = True
        elif a == "--decrypt":
            decrypt = True
        elif a == "--show-encryption":
            show = True
        elif a in ("--help", "-h", "--version"):
            print(USAGE)
            return
        elif a.startswith("-") and a != "-":
            fail(f"{a} is not supported; {REAL}\n{USAGE}")
        else:
            files.append(a)
        i += 1

    if show:
        if len(files) != 1:
            fail(USAGE)
        reader = PdfReader(files[0])
        if not reader.is_encrypted:
            print("File is not encrypted")
            return
        info = reader.trailer["/Encrypt"].get_object()
        p = int(info.get("/P", 0))
        print(f"R = {info.get('/R')}\nP = {p}")
        for name, bit in (("print", U.PRINT), ("modify", U.MODIFY), ("extract", U.EXTRACT), ("annotate", U.ADD_OR_MODIFY)):
            print(f"{name}: {'allowed' if p & bit else 'not allowed'}")
        return

    if len(files) != (1 if empty else 2):
        fail(USAGE)
    if empty and not groups:
        fail("--empty needs --pages")
    output = files[-1]
    if output in files[:-1] or output in (g[0] for g in groups or []):
        fail("the output must not be one of the inputs")
    readers = {}

    def open_pdf(path, pw):
        if path not in readers:
            reader = PdfReader(path)
            if reader.is_encrypted and not reader.decrypt(pw):
                fail(f"{path}: invalid password")
            readers[path] = reader
        return readers[path]

    primary = None if empty else open_pdf(files[0], password)
    if primary is not None and primary.is_encrypted and not (decrypt or encrypt):
        fail(f"{files[0]} is encrypted, and keeping its encryption is not supported: add --decrypt, or --encrypt to set new passwords")

    if groups is None:
        writer = PdfWriter(clone_from=primary)
    else:
        writer = PdfWriter()
        for path, pw, spec in groups:
            reader = primary if path == "." else open_pdf(path, pw)
            for n in pages_of(spec, len(reader.pages)):
                writer.add_page(reader.pages[n])
    for rotation in rotations:
        match = re.match(r"^([+-]?)(\d+)(?::(.*))?$", rotation)
        if not match or int(match[2]) % 90:
            fail(f"--rotate={rotation}: the angle must be a multiple of 90")
        angle = int(match[2])
        for n in pages_of(match[3], len(writer.pages)):
            page = writer.pages[n]
            if match[1]:
                page.rotate(angle if match[1] == "+" else -angle)
            else:
                page.rotation = angle

    def save(w, path):
        if encrypt:
            algorithm = {"40": "RC4-40", "128": "AES-128", "256": "AES-256"}[encrypt["bits"]]
            w.encrypt(encrypt["user"], encrypt["owner"], permissions_flag=U.all() & ~encrypt["deny"], algorithm=algorithm)
        w.write(path)

    if not split:
        save(writer, output)
        return
    # qpdf's names: %d (any width) becomes the zero-padded first page, or first-last for a group; without it, -NN goes
    # before the extension.
    total = len(writer.pages)
    width = len(str(total))
    for start in range(0, total, split):
        last = min(start + split, total)
        label = f"{start + 1:0{width}d}" if split == 1 else f"{start + 1:0{width}d}-{last:0{width}d}"
        if NUMBERED.search(output):
            name = NUMBERED.sub(label, output, count=1)
        else:
            name = re.sub(r"(\.pdf)?$", rf"-{label}\1", output, count=1, flags=re.I)
        part = PdfWriter()
        for page in writer.pages[start:last]:
            part.add_page(page)
        save(part, name)


main(sys.argv[1:])
