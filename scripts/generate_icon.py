"""
Generate high-quality ASTERIA application icons for Windows installer and executable.
Produces resources/icon.png and resources/icon.ico with aerospace crosshairs and optical beam styling.
"""
import os
import math
from PIL import Image, ImageDraw

def create_asteria_icon():
    os.makedirs('resources', exist_ok=True)
    size = 512
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    center = size // 2
    r = 240

    # 1. Dark outer aerospace bezel
    draw.ellipse([center - r, center - r, center + r, center + r], fill=(11, 15, 25, 255), outline=(30, 41, 59, 255), width=8)

    # 2. Cyan optical tracking rings
    r_inner = 180
    draw.ellipse([center - r_inner, center - r_inner, center + r_inner, center + r_inner], outline=(0, 229, 255, 180), width=4)

    r_focal = 110
    draw.ellipse([center - r_focal, center - r_focal, center + r_focal, center + r_focal], outline=(0, 229, 255, 240), width=6)

    # 3. Corner tick marks / Reticle markings
    for angle in [45, 135, 225, 315]:
        rad = math.radians(angle)
        x1 = center + int((r_inner - 20) * math.cos(rad))
        y1 = center + int((r_inner - 20) * math.sin(rad))
        x2 = center + int((r_inner + 20) * math.cos(rad))
        y2 = center + int((r_inner + 20) * math.sin(rad))
        draw.line([x1, y1, x2, y2], fill=(0, 229, 255, 220), width=4)

    # 4. Precision Crosshair lines with aperture gap
    gap = 40
    # Horizontal
    draw.line([center - r + 30, center, center - gap, center], fill=(0, 229, 255, 255), width=5)
    draw.line([center + gap, center, center + r - 30, center], fill=(0, 229, 255, 255), width=5)
    # Vertical
    draw.line([center, center - r + 30, center, center - gap], fill=(0, 229, 255, 255), width=5)
    draw.line([center, center + gap, center, center + r - 30], fill=(0, 229, 255, 255), width=5)

    # 5. Glowing Central Beacon / Laser Point (Gold / Amber / Orange)
    beacon_r = 24
    draw.ellipse([center - beacon_r, center - beacon_r, center + beacon_r, center + beacon_r], fill=(255, 170, 0, 255), outline=(255, 215, 0, 255), width=4)

    core_r = 10
    draw.ellipse([center - core_r, center - core_r, center + core_r, center + core_r], fill=(255, 255, 255, 255))

    # Save PNG
    png_path = os.path.join('resources', 'icon.png')
    img.save(png_path, 'PNG')
    print(f"Generated {png_path}")

    # Save ICO (multi-size)
    ico_path = os.path.join('resources', 'icon.ico')
    img.save(
        ico_path,
        format='ICO',
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    )
    print(f"Generated {ico_path}")

if __name__ == '__main__':
    create_asteria_icon()
