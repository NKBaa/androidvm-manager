# 生成应用图标：琥珀色圆角方块 + 深色播放三角（与界面 logo 一致，单色）
# 用法: python make-icon.py [输出路径]
import sys, os
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'app', 'build', 'icon.ico')
os.makedirs(os.path.dirname(OUT), exist_ok=True)

SS = 8  # 超采样倍数，保证边缘平滑

ACCENT = (217, 154, 43)    # #d99a2b 主色
INK = (20, 19, 15)         # #14130f 近黑，用于播放三角


def make(size):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 单色圆角方块
    radius = int(S * 0.22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=ACCENT)

    # 播放三角（视觉重心略右移）
    cx, cy = S / 2 + S * 0.02, S / 2
    r = S * 0.26
    d.polygon(
        [
            (cx - r * 0.72, cy - r),
            (cx - r * 0.72, cy + r),
            (cx + r * 0.95, cy),
        ],
        fill=INK,
    )

    return img.resize((size, size), Image.LANCZOS)


sizes = [256, 128, 64, 48, 32, 16]
imgs = [make(s) for s in sizes]
imgs[0].save(OUT, format='ICO', sizes=[(s, s) for s in sizes])
imgs[0].save(OUT.replace('.ico', '.png'), format='PNG')
print('saved', OUT, os.path.getsize(OUT), 'bytes')
