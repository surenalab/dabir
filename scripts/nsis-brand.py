# Generate NSIS header and sidebar bitmaps from the Dabir app icon and wordmark.
#   python3 scripts/nsis-brand.py
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ICON = ROOT / "src-tauri" / "icons" / "icon.png"
OUT = ROOT / "src-tauri" / "windows"
LAJVARD = (34, 57, 107)  # #22396B
INK = (255, 255, 255)
GOLD = (201, 162, 39)  # the diamond on the icon
MUTED = (210, 218, 232)

FONTS = [
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "/System/Library/Fonts/NewYork.ttf",
    "/Library/Fonts/Georgia.ttf",
    "C:/Windows/Fonts/georgia.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
]


def font(size: int) -> ImageFont.ImageFont:
    for p in FONTS:
        if Path(p).is_file():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def canvas(w: int, h: int) -> Image.Image:
    return Image.new("RGB", (w, h), LAJVARD)


def paste_icon(dst: Image.Image, size: int, xy: tuple[int, int]) -> None:
    im = Image.open(ICON).convert("RGBA")
    im = im.resize((size, size), Image.Resampling.LANCZOS)
    # Flatten onto lajvard so the BMP has no alpha (NSIS wants 24-bit).
    bg = Image.new("RGBA", im.size, (*LAJVARD, 255))
    bg.alpha_composite(im)
    dst.paste(bg.convert("RGB"), xy)


def centred(draw: ImageDraw.ImageDraw, text: str, y: int, f: ImageFont.ImageFont, fill, width: int) -> None:
    box = draw.textbbox((0, 0), text, font=f)
    x = (width - (box[2] - box[0])) // 2
    draw.text((x, y), text, font=f, fill=fill)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    header = canvas(150, 57)
    paste_icon(header, 40, (6, 8))
    hd = ImageDraw.Draw(header)
    hd.text((50, 16), "Dabir", font=font(22), fill=INK)
    header.save(OUT / "nsis-header.bmp", "BMP")

    side = canvas(164, 314)
    paste_icon(side, 88, (38, 36))
    sd = ImageDraw.Draw(side)
    centred(sd, "Dabir", 140, font(28), INK, 164)
    sd.rectangle((62, 178, 102, 181), fill=GOLD)
    centred(sd, "Surena Lab", 190, font(13), MUTED, 164)
    centred(sd, "A paper workspace", 210, font(11), MUTED, 164)
    side.save(OUT / "nsis-sidebar.bmp", "BMP")
    print(f"wrote {OUT / 'nsis-header.bmp'} and {OUT / 'nsis-sidebar.bmp'}")


if __name__ == "__main__":
    main()
