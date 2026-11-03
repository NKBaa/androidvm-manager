# 生成应用图标：蓝紫渐变圆角方块 + 白色播放三角（与界面 logo 一致）
# 用法: python make-icon.py <输出路径>
import sys, os, math
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'app', 'build', 'icon.ico')
os.makedirs(os.path.dirname(OUT), exist_ok=True)

SS = 8  # 超采样倍数，保证边缘平滑


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make(size):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 渐变底（对角）
    c1 = (76, 125, 255)   # #4c7dff
    c2 = (124, 92, 255)   # #7c5cff
    grad = Image.new('RGB', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        for_x_t = y / max(1, S - 1)
        gd.line([(0, y), (S, y)], fill=lerp(c1, c2, for_x_t))
    # 叠加一点左上高光
    hl = Image.new('L', (S, S), 0)
    hd = ImageDraw.Draw(hl)
    for y in range(S):
        t = y / max(1, S - 1)
        hd.line([(0, y), (S, y)], fill=int(60 * (1 - t)))
    white = Image.new('RGB', (S, S), (255, 255, 255))
    grad = Image.composite(white, grad, hl)

    # 圆角遮罩
    radius = int(S * 0.22)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # 播放三角（居中，略微右移视觉更平衡）
    cx, cy = S / 2 + S * 0.02, S / 2
    r = S * 0.26
    pts = [
        (cx - r * 0.72, cy - r),
        (cx - r * 0.72, cy + r),
        (cx + r * 0.95, cy),
    ]
    d.polygon(pts, fill=(255, 255, 255, 245))

    return img.resize((size, size), Image.LANCZOS)


sizes = [256, 128, 64, 48, 32, 16]
imgs = [make(s) for s in sizes]
imgs[0].save(OUT, format='ICO', sizes=[(s, s) for s in sizes])
imgs[0].save(OUT.replace('.ico', '.png'), format='PNG')
print('saved', OUT, os.path.getsize(OUT), 'bytes')
