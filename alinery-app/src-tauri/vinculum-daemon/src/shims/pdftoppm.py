# pdftoppm for a machine without poppler: the included pdf and pptx skills (and pdf2image) call it to turn pages into
# images. Drawn by the bundled Python's pypdfium2. Covers the options those skills use; any other fails loudly.
# Written beside the agent shell's other shims (agentShell.ts), which come last on PATH, so a real pdftoppm wins.
import sys

USAGE = "usage: pdftoppm [-png|-jpeg|-tiff] [-r dpi] [-f first] [-l last] [-scale-to px] [-jpegopt quality=N] [-singlefile] file.pdf root"
FORMATS = {"-png": ("PNG", "png"), "-jpeg": ("JPEG", "jpg"), "-tiff": ("TIFF", "tif")}


def main(args):
    fmt, ext, dpi, first, last, scale_to, quality, single = "PPM", "ppm", 150.0, 1, None, None, 75, False
    files = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in FORMATS:
            fmt, ext = FORMATS[a]
        elif a in ("-r", "-f", "-l", "-scale-to", "-jpegopt"):
            i += 1
            if i == len(args):
                sys.exit(f"pdftoppm: {a} needs a value")
            v = args[i]
            if a == "-r":
                dpi = float(v)
            elif a == "-f":
                first = int(v)
            elif a == "-l":
                last = int(v)
            elif a == "-scale-to":
                scale_to = int(v)
            else:
                quality = int(dict(o.split("=", 1) for o in v.split(",") if "=" in o).get("quality", quality))
        elif a == "-singlefile":
            single = True
        elif a in ("-h", "-help", "--help", "-v"):
            print(USAGE)
            return
        elif a.startswith("-") and len(a) > 1:
            sys.exit(f"pdftoppm (Alinery's stand-in, drawn by pypdfium2): {a} is not supported\n{USAGE}")
        else:
            files.append(a)
        i += 1
    if len(files) != 2:
        sys.exit(USAGE)
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(files[0])
    count = len(pdf)
    last = min(count, last or count)
    if single:
        last = first
    width = len(str(count))
    for n in range(first, last + 1):
        page = pdf[n - 1]
        w, h = page.get_size()
        scale = scale_to / max(w, h) if scale_to else dpi / 72
        image = page.render(scale=scale).to_pil().convert("RGB")
        name = f"{files[1]}.{ext}" if single else f"{files[1]}-{n:0{width}d}.{ext}"
        image.save(name, fmt, **({"quality": quality} if fmt == "JPEG" else {}))


main(sys.argv[1:])
