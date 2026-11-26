"""生成设备表面细节贴图：法线 + 粗糙度（各两套：漆面 / 金属拉丝）。

为什么要自己生成而不是找贴图：
  项目里所有资产都要求可复现、无版权争议，且尺寸/密度要跟着 UV 走。
  一张 512² 的噪声图用 30 行 numpy 就能严格无缝平铺，改参数重跑即可。

为什么写 PNG 字节而不是 bpy.data.images：
  Blender 的 image.pixels 是浮点接口，存 PNG 时会过一次色彩管理，
  法线图这种**非颜色数据**一过 sRGB 编码就废了（实测法线会偏成一片紫色）。
  自己用 zlib 写 8-bit RGB，写进去什么字节读出来就是什么，零歧义。

运行（用 Blender 自带的 Python，本机不需要 numpy）：
  blender -b --factory-startup --python tools/blender/gen_textures.py -- frontend/public/models/tex
"""

import os
import struct
import sys
import zlib

import numpy as np

SIZE = 512


# ---------------------------------------------------------------- PNG 写入


def write_png(path, rgb):
    """rgb: (h, w, 3) uint8。8-bit truecolor，无调色板、无 alpha。"""
    h, w = rgb.shape[:2]
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def to_bytes(arr):
    return np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- 噪声


def value_noise(n, cells, rng):
    """周期值噪声：cells × cells 的随机格点，smoothstep 双线性插值到 n × n。

    周期性是**硬要求**：贴图要平铺，任何一层噪声不环绕，接缝处就会出现
    一条明显的亮线（石材/漆面上一眼能看出来）。
    """
    grid = rng.random((cells, cells))
    t = np.arange(n) * (cells / n)
    i0 = np.floor(t).astype(np.int64) % cells
    i1 = (i0 + 1) % cells
    f = t - np.floor(t)
    s = f * f * (3.0 - 2.0 * f)  # smoothstep，避免双线性插值出方格感

    v00 = grid[np.ix_(i0, i0)]
    v01 = grid[np.ix_(i0, i1)]
    v10 = grid[np.ix_(i1, i0)]
    v11 = grid[np.ix_(i1, i1)]
    # 拆开写：v00/v01 是「行方向 i0、列方向 i0/i1」
    top = v00 + (v01 - v00) * s[None, :]
    bot = v10 + (v11 - v10) * s[None, :]
    return top + (bot - top) * s[:, None]


def fbm(n, base, octaves, rng, persistence=0.5):
    """多层噪声叠加，归一化到 [0,1]。"""
    total = np.zeros((n, n))
    amp = 1.0
    norm = 0.0
    for o in range(octaves):
        total += value_noise(n, base * (2**o), rng) * amp
        norm += amp
        amp *= persistence
    return total / norm


def anisotropic(n, cells_x, cells_y, rng):
    """各向异性噪声：X 方向高频、Y 方向低频 —— 金属拉丝的成因。"""
    grid = rng.random((cells_y, cells_x))
    tx = np.arange(n) * (cells_x / n)
    ty = np.arange(n) * (cells_y / n)
    ix0 = np.floor(tx).astype(np.int64) % cells_x
    ix1 = (ix0 + 1) % cells_x
    iy0 = np.floor(ty).astype(np.int64) % cells_y
    iy1 = (iy0 + 1) % cells_y
    fx = tx - np.floor(tx)
    fy = ty - np.floor(ty)
    sx = fx * fx * (3.0 - 2.0 * fx)
    sy = fy * fy * (3.0 - 2.0 * fy)

    a = grid[np.ix_(iy0, ix0)]
    b = grid[np.ix_(iy0, ix1)]
    c = grid[np.ix_(iy1, ix0)]
    d = grid[np.ix_(iy1, ix1)]
    top = a + (b - a) * sx[None, :]
    bot = c + (d - c) * sx[None, :]
    return top + (bot - top) * sy[:, None]


# ---------------------------------------------------------------- 高度场 → 图


def blur3(x, passes=1):
    """3×3 高斯（1-2-1 分离卷积），同样用 roll 保环绕。

    为什么要糊一遍：value_noise 到 cells=48 时每格只有 10 像素，格点插值会留下
    肉眼可辨的"编织"纹（第一版 512² 图看起来像尼龙布）。糊一遍既不丢结构，
    又能显著降低 PNG 熵（实测两张法线图从 757+678 KB 降到 300 以内）。
    """
    for _ in range(passes):
        a = np.roll(x, 1, 0) + 2.0 * x + np.roll(x, -1, 0)
        x = (np.roll(a, 1, 1) + 2.0 * a + np.roll(a, -1, 1)) / 16.0
    return x


def normal_from_height(height, strength):
    """中心差分求梯度 → 切线空间法线图。np.roll 保证求导也是环绕的。"""
    dx = np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)
    dy = np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)
    nx = -dx * strength
    ny = -dy * strength
    nz = np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / length, ny / length, nz / length], axis=-1) * 0.5 + 0.5


def add_scratches(height, rng, count, length_range, width, depth):
    """随机短划痕。

    线段的中心与长度都留足边距，且**不跨图边**：跨边就会破坏平铺性，
    而不做环绕的伪影比没有划痕更难看。
    """
    n = height.shape[0]
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    margin = length_range[1] + 4
    for _ in range(count):
        cx = rng.integers(margin, n - margin)
        cy = rng.integers(margin, n - margin)
        ang = rng.random() * np.pi
        half = rng.integers(*length_range) / 2.0
        dx = np.cos(ang) * half
        dy = np.sin(ang) * half
        px = xx - cx
        py = yy - cy
        denom = dx * dx + dy * dy + 1e-6
        t = np.clip((px * dx + py * dy) / denom, 0.0, 1.0)
        dist = np.hypot(px - t * dx, py - t * dy)
        mask = dist < width
        if rng.random() > 0.5:
            height[mask] -= rng.uniform(depth[0], depth[1])
        else:
            height[mask] += rng.uniform(depth[0], depth[1]) * 0.5
    return height


def gray_to_rgb(gray):
    return np.stack([gray, gray, gray], axis=-1)


# ---------------------------------------------------------------- 四种图


def make_dirt(rng, strength=0.16, cool=False):
    """颜色乘子：积灰、油膜与轻微黄变（与顶点色相乘，不是独立颜色）。

    为什么需要这一张：法线贴图只改光照方向，远距离会被 mipmap 抹平；而"这台机器
    用了三年"这件事，靠的是**颜色不一致**——面板有深有浅、下裙板积灰、边角发黄。
    实测只加法线时，机床在 3 m 处仍是一块均匀的白，加上 12% 的色差才有实体感。

    输出是**线性乘子**（运行时按 NoColorSpace 读，写多少乘多少）。
    """
    low = fbm(SIZE, 3, 4, rng, 0.6)
    mid = fbm(SIZE, 12, 3, rng, 0.5)
    h = 1.0 - (low * 0.62 + mid * 0.38) * strength
    # 灰尘让短波先衰减：B 掉得比 R 多，整体偏暖一点点，比纯灰更像"旧"
    r = h
    g = h * (0.995 if cool else 0.988)
    b = h * (0.998 if cool else 0.972)
    return np.stack([r, g, b], axis=-1)


def make_paint(rng):
    """漆面（喷塑钣金）：橘皮 + 轻颗粒 + 稀疏划痕。

    尺度按"这张图在模型上覆盖多宽"反推：材质里 repeat 取 7、UV 单位是米，
    一张 512² 就压住 0.143 m，于是 cells=12 → 12 mm 起伏（橘皮），
    cells=48 → 3 mm 颗粒（喷塑的桔纹）。cells 再高就会细到只剩噪点。
    """
    # 权重从「橘皮 0.66 / 颗粒 0.18」翻成「0.35 / 0.50」：
    # 橘皮那层在 repeat=6 时是 14 mm 的起伏，给多了整块板会读作粗糙铸件；
    # 真实喷塑的主体是 3 mm 级颗粒，橘皮只是很弱的一层底
    height = fbm(SIZE, 12, 3, rng, 0.55) * 0.35  # 橘皮：很弱的一层底
    height += fbm(SIZE, 48, 1, rng, 0.5) * 0.50  # 喷塑颗粒：主体
    height = blur3(height, 1)
    height = add_scratches(height, rng, count=48, length_range=(14, 64), width=0.9, depth=(0.03, 0.07))
    # 强度踩过三次：14 → 高频噪点像砂纸；4.5 → 近景像毛石混凝土；
    # 2.0 才是"喷塑钣金"该有的量级——纹理要能被记住，但不能抢主体轮廓
    normal = normal_from_height(height, strength=3.2)

    dirt = fbm(SIZE, 4, 3, rng, 0.5)
    grit = fbm(SIZE, 40, 2, rng, 0.5)
    # 幅度从 0.20 拉到 0.32：0.30~0.50 的差在 10 m 外基本被 mipmap 抹平，
    # 只有拉开到 0.26~0.58 才读得出"这台机器不新"
    rough = 0.26 + dirt * 0.32 + (grit - 0.5) * 0.06
    return normal, gray_to_rgb(np.clip(rough, 0.20, 0.68)), make_dirt(rng, strength=0.10)


def make_metal(rng):
    """金属（拉丝钢板）：沿 U 的细长条纹 + 稀疏深划痕。

    条纹方向别搞反：拉丝是"沿 U 延伸的长条"，所以要让**V 方向高频、U 方向低频**
    （cells_x 小、cells_y 大）。第一版写反了，出来是一片竖条，像瓦楞板。
    """
    brush = anisotropic(SIZE, cells_x=3, cells_y=88, rng=rng)
    height = brush * 0.78 + fbm(SIZE, 18, 2, rng, 0.5) * 0.22
    height = blur3(height, 1)
    height = add_scratches(height, rng, count=20, length_range=(40, 150), width=0.7, depth=(0.03, 0.06))
    normal = normal_from_height(height, strength=3.2)

    rough = 0.16 + brush * 0.24 + fbm(SIZE, 6, 2, rng, 0.5) * 0.06
    # 金属件比漆面耐脏，色差只给一半，且偏冷（油膜反光偏蓝）
    return normal, gray_to_rgb(np.clip(rough, 0.14, 0.5)), make_dirt(rng, strength=0.07, cool=True)


def main():
    argv = sys.argv
    out_dir = argv[argv.index("--") + 1] if "--" in argv else "frontend/public/models/tex"
    os.makedirs(out_dir, exist_ok=True)

    jobs = (
        ("paint_normal", make_paint, 0),
        ("paint_rough", make_paint, 1),
        ("paint_dirt", make_paint, 2),
        ("metal_normal", make_metal, 0),
        ("metal_rough", make_metal, 1),
        ("metal_dirt", make_metal, 2),
    )
    # 同一个 seed 同时产出 normal 与 rough，保证两者来自同一高度场（颗粒位置对得上）
    cache = {}
    for name, maker, slot in jobs:
        key = (maker.__name__, 20261126 if maker is make_paint else 20261127)
        if key not in cache:
            cache[key] = maker(np.random.default_rng(key[1]))
        rgb = to_bytes(cache[key][slot])
        path = os.path.join(out_dir, f"{name}.png")
        write_png(path, rgb)
        print(f"TEX {name}: {os.path.getsize(path) / 1024:.0f} KB")


main()
