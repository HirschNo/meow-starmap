import math, random
from PIL import Image, ImageDraw, ImageFilter

S = 720
random.seed(7)

img = Image.new('RGB', (S, S), (4, 6, 15))
px = img.load()
cx, cy = S / 2, S / 2
for y in range(S):
    for x in range(S):
        dx, dy = (x - cx) / (S * 0.62), (y - cy) / (S * 0.62)
        r = min(1.0, math.hypot(dx, dy))
        t = r ** 1.7
        px[x, y] = (
            int(14 * (1 - t) + 4 * t),
            int(22 * (1 - t) + 6 * t),
            int(52 * (1 - t) + 14 * t),
        )

glow = Image.new('RGB', (S, S), (0, 0, 0))
g = ImageDraw.Draw(glow)

GALAXIES = [
    (300, 300, (250, 214, 120), 9),   # amber project core
    (470, 250, (96, 165, 250), 7),    # blue cluster
    (410, 480, (167, 139, 250), 6),   # violet cluster
]
for gx, gy, col, n in GALAXIES:
    g.ellipse([gx - 40, gy - 40, gx + 40, gy + 40], fill=tuple(int(c * 0.30) for c in col))
    g.ellipse([gx - 16, gy - 16, gx + 16, gy + 16], fill=tuple(int(c * 0.75) for c in col))
    g.ellipse([gx - 7, gy - 7, gx + 7, gy + 7], fill=(255, 255, 255))
    for _ in range(n * 9):
        a = random.uniform(0, math.tau)
        rr = random.uniform(50, 150)
        sx, sy = gx + math.cos(a) * rr, gy + math.sin(a) * rr * 0.8
        rad = random.uniform(3.0, 7.0)
        dim = random.uniform(0.55, 1.0)
        g.ellipse([sx - rad, sy - rad, sx + rad, sy + rad],
                  fill=tuple(int(c * dim) for c in col))

# background stars
for _ in range(140):
    x, y = random.uniform(0, S), random.uniform(0, S)
    rad = random.uniform(0.6, 1.9)
    v = random.randint(90, 210)
    g.ellipse([x - rad, y - rad, x + rad, y + rad], fill=(v, v, min(255, v + 25)))

glow = glow.filter(ImageFilter.GaussianBlur(9))
img = Image.blend(img, glow, 0.95)

# links between cores
d = ImageDraw.Draw(img, 'RGBA')
pts = [(x, y) for x, y, _, _ in GALAXIES]
for i in range(len(pts)):
    for j in range(i + 1, len(pts)):
        d.line([pts[i], pts[j]], fill=(120, 170, 255, 46), width=2)

# final sharpen of cores: small white points
for gx, gy, col, _ in GALAXIES:
    d.ellipse([gx - 5, gy - 5, gx + 5, gy + 5], fill=(255, 255, 255, 255))

img = img.resize((180, 180), Image.LANCZOS)
img.save('assets/icon-180.png', optimize=True)
print('ok', img.size)
