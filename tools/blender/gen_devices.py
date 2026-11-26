"""
设备模型参数化生成（批 3，D-78）。

为什么用脚本而不是手工建模：14 台设备只有 6 种形体，尺寸又锁死在
`frontend/src/three/layout.ts` 的 DEVICE_SIZES 里。手工建模会失真、改尺寸要重做；
脚本生成的好处是——尺寸是参数、倒角是参数、材质是参数，改一层全部同步，
而且"模型是自己写的"这件事，比下载 CC0 资源更适合放在毕设里讲。

导出约定（与前端对齐，改这里必须同步 glbDevices.ts）：
  - 单位：米；1 Blender 单位 = 1 米
  - 原点：设备底面中心（与 three 里 group 的位置一致）
  - 朝向：宽度沿 X、深度沿 Y（导出后 glTF 的 Z）、高度沿 Z（导出后 Y）
  - 文件名：cnc.glb / robot.glb / inspection.glb，放进 frontend/public/models/

跑法（无头）：
  blender.exe -b --factory-startup --python tools/blender/gen_devices.py -- <输出目录>
"""

import math
import os
import sys

import bpy
from mathutils import Vector

# ---------------------------------------------------------------- 基础工具


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat_pbr(name, color, metallic=0.0, roughness=0.5, emission=None, emission_strength=0.0, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None:
        # Blender 4.x 起 Emission 拆成 Color + Strength 两个插槽
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = "BLEND"
    return mat


def _finish(obj, name, mat, bevel):
    obj.name = name
    obj.data.materials.append(mat)
    # 倒角是本批"不再像积木"的关键：真实钣金件没有绝对锐边，边缘一有高光就活了
    if bevel > 0:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def box(name, center, size, mat, bevel=0.02, rot=None):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    obj = bpy.context.active_object
    obj.scale = size
    if rot:
        obj.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return _finish(obj, name, mat, bevel)


def cyl(name, center, radius, depth, mat, axis="Z", bevel=0.01, verts=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=center)
    obj = bpy.context.active_object
    if axis == "X":
        obj.rotation_euler = (0, math.radians(90), 0)
    elif axis == "Y":
        obj.rotation_euler = (math.radians(90), 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return _finish(obj, name, mat, bevel)


def tube(name, points, radius, mat, bevel=0.0):
    """用曲线做气管/线缆：真实机床上的软管是最抢眼的细节之一"""
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for p, co in zip(spline.bezier_points, points):
        p.co = Vector(co)
        p.handle_left_type = "AUTO"
        p.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    # 转成 mesh，导出才稳定（曲线在 glTF 里会被就地求值，但没法做倒角与后续合并）
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.active_object


def text(name, body, size, location, mat, rot=None, extrude=0.0022):
    """立体文字（型号铭牌）：FONT 曲线转 mesh，参与顶点色合并。

    为什么把字做成几何而不是贴一张文字图：
      合并管线是「所有设备共享一份材质」，贴文字就得给每台设备准备专属贴图或图集；
      做成几何后文字跟机身一起走顶点色，**draw call 零增加**，近景还有真实的浮雕
      厚度（0.0022 m 挤出 + 光照打出的高光边），这是任何贴图都给不了的。

    默认旋转 -90°：Blender 的 FONT 在 XY 平面、法线朝 +Z，
    机床正面朝 -Y，所以要沿 X 轴翻下来，文字才"贴在正面"而不是"躺在地上"。
    """
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = body
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.extrude = extrude
    # 曲线细分默认 12，一个字母就能吃掉 300+ 三角；铭牌字高只有 5 cm，
    # 屏幕上最大也就 40 像素，细分 3 已经看不出折线，三角数降到 1/3
    curve.resolution_u = 3
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = rot if rot else (math.radians(-90), 0, 0)
    obj.data.materials.append(mat)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.active_object


# ---------------------------------------------------------------- 材质库


def materials():
    """颜色一律按**线性值**给（Blender 的 Base Color 是线性空间，导到 glTF 后原样保留）。

    第一版按 sRGB 习惯给了 0.82 的近白色，进 three 后线性 0.82 ≈ sRGB 0.93，
    再被 IBL + 主光一打就整台过曝——截图里机床是一块白，护罩分缝全糊掉。
    这里全部压到真实工业漆的线性区间：浅灰 0.34、深灰 0.10、安全橙 0.55。
    屏幕不给 emission（烘焙成顶点色时会丢），改用高亮青色顶点色近似"亮着的屏"。
    """
    return {
        "paint_light": mat_pbr("paint_light", (0.34, 0.37, 0.41), metallic=0.05, roughness=0.42),
        "paint_dark": mat_pbr("paint_dark", (0.09, 0.11, 0.13), metallic=0.15, roughness=0.45),
        "paint_blue": mat_pbr("paint_blue", (0.05, 0.12, 0.19), metallic=0.2, roughness=0.38),
        "steel": mat_pbr("steel", (0.40, 0.42, 0.45), metallic=1.0, roughness=0.32),
        "dark_steel": mat_pbr("dark_steel", (0.06, 0.07, 0.08), metallic=0.9, roughness=0.5),
        "rubber": mat_pbr("rubber", (0.03, 0.03, 0.035), metallic=0.0, roughness=0.9),
        "glass": mat_pbr("glass", (0.30, 0.45, 0.52), metallic=0.0, roughness=0.08, alpha=0.30),
        "screen": mat_pbr("screen", (0.30, 0.78, 0.95), roughness=0.2),
        "lamp_green": mat_pbr("lamp_green", (0.15, 0.85, 0.35), roughness=0.3),
        "warn_yellow": mat_pbr("warn_yellow", (0.62, 0.42, 0.02), roughness=0.6),
        "orange": mat_pbr("orange", (0.55, 0.20, 0.03), metallic=0.1, roughness=0.4),
        "granite": mat_pbr("granite", (0.045, 0.045, 0.05), metallic=0.0, roughness=0.35),
    }


# ---------------------------------------------------------------- 六类设备


def build_cnc(m):
    """立式加工中心：4.0 × 2.6 × 2.6（X×Y×Z），原点在底面中心"""
    box("cnc_plinth", (0, 0, 0.11), (3.9, 2.5, 0.22), m["dark_steel"], bevel=0.02)
    box("cnc_lower", (0, 0, 0.62), (3.66, 2.36, 0.82), m["paint_light"], bevel=0.05)
    box("cnc_enclosure", (0, 0, 1.66), (3.5, 2.2, 1.24), m["paint_light"], bevel=0.06)
    box("cnc_cap", (0, 0, 2.34), (3.3, 2.05, 0.12), m["paint_dark"], bevel=0.03)

    # 前门：门框 + 观察窗 + 把手（玻璃单独一片，透明材质才看得出"里面有东西"）
    box("cnc_door_frame", (0, -1.13, 1.62), (2.5, 0.08, 1.15), m["paint_dark"], bevel=0.02)
    box("cnc_door_glass", (-0.15, -1.18, 1.66), (1.9, 0.03, 0.9), m["glass"], bevel=0.0)
    cyl("cnc_door_handle", (1.0, -1.2, 1.35), 0.025, 0.5, m["steel"], axis="Z", bevel=0.0)

    # 右侧悬臂操作面板：立柱 + 摇臂 + 屏幕 + 按键条
    box("cnc_panel_post", (1.86, 0.55, 1.2), (0.12, 0.12, 1.9), m["dark_steel"], bevel=0.01)
    box("cnc_panel_arm", (1.55, 0.55, 2.02), (0.5, 0.1, 0.1), m["dark_steel"], bevel=0.01)
    box("cnc_panel_body", (1.32, 0.5, 1.84), (0.5, 0.14, 0.62), m["paint_dark"],
        bevel=0.02, rot=(0, math.radians(-12), 0))
    box("cnc_panel_screen", (1.3, 0.41, 1.86), (0.4, 0.02, 0.4), m["screen"],
        bevel=0.0, rot=(0, math.radians(-12), 0))

    # 顶部三色灯：绿色节拍灯（其余两色由前端状态灯接管，这里只做灯柱基座）
    cyl("cnc_lamp_base", (-1.2, 0.6, 2.45), 0.07, 0.14, m["dark_steel"], bevel=0.0)

    # 侧面散热格栅：5 条横缝，远看就是"机床的呼吸口"
    # 原来写在 x=1.52（壳体半宽 1.75），整组埋在壳里看不见——这是 2026-11-26 复看时发现的
    for i in range(5):
        box(f"cnc_vent_{i}", (1.76, 0.2, 0.55 + i * 0.14), (0.06, 0.9, 0.06), m["dark_steel"], bevel=0.0)

    # 下部检修门：真实机床正面下半部就是一块带把手的电控柜门。
    # 这条门缝在中距离比任何法线贴图都更说明"外壳是拼装的钣金"——
    # 实测只加法线贴图时，4 m 的整块平板仍读作水泥墙，加了门缝才立住。
    box("cnc_cabinet_door", (-0.3, -1.195, 0.58), (2.0, 0.05, 0.62), m["paint_light"], bevel=0.012)
    cyl("cnc_cabinet_handle", (0.62, -1.23, 0.58), 0.018, 0.22, m["steel"], axis="Z", bevel=0.0)

    # 后部排屑器 + 冷却液箱
    box("cnc_chip_conveyor", (-1.2, 1.35, 0.35), (0.9, 0.9, 0.5), m["dark_steel"], bevel=0.03,
        rot=(math.radians(-22), 0, 0))
    box("cnc_coolant_tank", (1.1, 1.25, 0.3), (1.2, 0.7, 0.5), m["paint_blue"], bevel=0.03)

    # 气管与线束：三条软管从机身后部绕到面板
    tube("cnc_hose_a", [(0.9, 1.2, 1.9), (1.4, 1.5, 1.5), (1.55, 1.0, 1.1)], 0.035, m["rubber"])
    tube("cnc_hose_b", [(0.7, 1.25, 2.0), (1.2, 1.55, 1.7), (1.45, 1.1, 1.35)], 0.028, m["rubber"])
    tube("cnc_cable", [(-0.6, 1.3, 2.0), (0.4, 1.45, 1.6), (1.2, 1.0, 1.2)], 0.022, m["dark_steel"])

    # 警示标与铭牌：必须贴在壳**外**表面。原值 y=-1.16 而壳体前面在 -1.18，
    # 等于整块牌埋进壳里（远看只剩一条缝），是照着截图才发现的历史缺陷
    box("cnc_warn_plate", (-1.55, -1.195, 0.95), (0.28, 0.02, 0.2), m["warn_yellow"], bevel=0.0)
    # 铭牌 = 钢边 + 浅漆面板。只用纯钢牌时，metal 桶在没有正对光源的角度只能反射
    # 暗青色的环境，整块牌读作"一块黑膏药"，字反而看不见；浅底深字才是真铭牌的样子
    box("cnc_nameplate_rim", (-0.9, -1.193, 0.95), (0.52, 0.018, 0.14), m["steel"], bevel=0.0)
    box("cnc_nameplate", (-0.9, -1.197, 0.95), (0.48, 0.018, 0.11), m["paint_light"], bevel=0.0)
    # 型号文字：浮雕在面板前面 6 mm 处（面板前面 -1.206），深色字压浅底
    text("cnc_name_text", "VMC-850", 0.052, (-0.9, -1.214, 0.95), m["paint_dark"])

    # 地脚
    for sx in (-1, 1):
        for sy in (-1, 1):
            cyl(f"cnc_foot_{sx}_{sy}", (sx * 1.7, sy * 1.05, 0.08), 0.11, 0.16, m["dark_steel"], bevel=0.0)


def build_robot(m):
    """六轴机器人：1.8 × 1.4 × 2.4"""
    cyl("rob_base", (0, 0, 0.06), 0.62, 0.12, m["dark_steel"], bevel=0.01)
    cyl("rob_turret", (0, 0, 0.28), 0.45, 0.32, m["orange"], bevel=0.02)
    box("rob_shoulder", (0, 0, 0.62), (0.62, 0.72, 0.46), m["orange"], bevel=0.04)

    # 大臂：从肩部斜向前上，倾角 -18°
    box("rob_upper_arm", (0.0, 0.32, 1.08), (0.34, 0.42, 1.05), m["orange"],
        bevel=0.05, rot=(math.radians(-18), 0, 0))
    cyl("rob_elbow", (0, 0.52, 1.58), 0.19, 0.44, m["orange"], axis="X", bevel=0.01)

    # 小臂：继续向前下
    box("rob_forearm", (0.0, 0.86, 1.86), (0.24, 0.78, 0.3), m["orange"],
        bevel=0.04, rot=(math.radians(-28), 0, 0))
    cyl("rob_wrist", (0, 1.16, 2.02), 0.13, 0.26, m["dark_steel"], axis="X", bevel=0.0)
    cyl("rob_flange", (0, 1.3, 2.06), 0.1, 0.1, m["steel"], bevel=0.0)

    # 末端夹爪：两根指 + 横梁
    box("rob_gripper_bar", (0, 1.4, 2.08), (0.26, 0.1, 0.12), m["dark_steel"], bevel=0.01)
    for sx in (-1, 1):
        box(f"rob_finger_{sx}", (sx * 0.1, 1.52, 2.06), (0.05, 0.16, 0.14), m["steel"], bevel=0.005)

    # 平衡缸 + 拖链线束
    cyl("rob_balancer", (0.28, 0.05, 1.05), 0.06, 0.9, m["steel"], axis="Z", bevel=0.0)
    tube("rob_dress_pack", [(0, -0.1, 0.75), (-0.34, 0.2, 1.2), (-0.3, 0.7, 1.75), (-0.12, 1.05, 2.0)],
         0.055, m["rubber"])

    # 底座警示条
    box("rob_warn_band", (0, 0, 0.13), (1.24, 0.06, 0.05), m["warn_yellow"], bevel=0.0)

    # 型号铭牌：做成方形牌座再刻字。直接贴在回转圆柱上会穿模
    # （0.26 宽的平板搭在 r=0.45 的圆上，两端必然扎进去），垫一块牌座最省事。
    box("rob_nameplate_rim", (0, -0.44, 0.30), (0.28, 0.03, 0.15), m["steel"], bevel=0.004)
    box("rob_nameplate", (0, -0.447, 0.30), (0.24, 0.03, 0.11), m["paint_light"], bevel=0.004)
    text("rob_name_text", "KR-16", 0.05, (0, -0.465, 0.30), m["paint_dark"])

    # 摆动枢轴：把大臂及以上的件挂到一个空物体上，导出成独立节点 `arm_pivot`。
    # 前端 motion.ts 只旋转"枢轴组"，几何用的是谁的 mesh 无所谓——换成 GLB 后
    # 机械臂照样摆，动画接口不用改（这是本批最省事的一刀）。
    pivot = bpy.data.objects.new("arm_pivot", None)
    pivot.empty_display_type = "PLAIN_AXES"
    bpy.context.collection.objects.link(pivot)
    pivot.location = (0.0, 0.0, 1.95)  # 与 three 的 ARM_PIVOT_Y 同值
    bpy.context.view_layer.update()
    for name in ("rob_upper_arm", "rob_elbow", "rob_forearm", "rob_wrist", "rob_flange",
                 "rob_gripper_bar", "rob_finger_-1", "rob_finger_1", "rob_dress_pack"):
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        obj.parent = pivot
        obj.matrix_parent_inverse = pivot.matrix_world.inverted()


def build_inspection(m):
    """三坐标/视觉检测台：3.0 × 2.0 × 1.8"""
    # 花岗岩台面 + 四条腿
    box("ins_table", (0, 0, 1.02), (2.6, 1.5, 0.22), m["granite"], bevel=0.01)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(f"ins_leg_{sx}_{sy}", (sx * 1.1, sy * 0.6, 0.45), (0.16, 0.16, 0.9), m["dark_steel"], bevel=0.01)

    # 龙门：两根立柱 + 横梁 + 滑座 + 镜头
    for sx in (-1, 1):
        box(f"ins_col_{sx}", (sx * 1.15, 0.62, 1.62), (0.14, 0.14, 1.0), m["steel"], bevel=0.01)
    box("ins_beam", (0, 0.62, 2.08), (2.44, 0.16, 0.14), m["steel"], bevel=0.01)
    box("ins_carriage", (0.2, 0.62, 1.98), (0.34, 0.3, 0.26), m["paint_dark"], bevel=0.02)
    cyl("ins_lens", (0.2, 0.62, 1.78), 0.075, 0.22, m["dark_steel"], bevel=0.0)
    cyl("ins_lens_glass", (0.2, 0.62, 1.665), 0.06, 0.02, m["glass"], bevel=0.0)

    # 侧屏 + 操作盒
    box("ins_screen_post", (-1.3, -0.55, 1.3), (0.08, 0.08, 0.7), m["dark_steel"], bevel=0.0)
    box("ins_screen", (-1.3, -0.5, 1.72), (0.5, 0.06, 0.36), m["paint_dark"], bevel=0.02)
    box("ins_screen_glass", (-1.3, -0.54, 1.72), (0.44, 0.02, 0.3), m["screen"], bevel=0.0)

    # 台面工件夹具 + 警示条
    box("ins_fixture", (0.3, -0.05, 1.18), (0.5, 0.4, 0.1), m["steel"], bevel=0.01)
    box("ins_warn_band", (0, -0.72, 1.02), (2.6, 0.04, 0.06), m["warn_yellow"], bevel=0.0)

    # 台面 T 型槽：三坐标/测量台的标准特征。深色细条嵌在花岗岩面上，
    # 比刻字更远距离可见，也是"这块板是测量平台"的唯一线索
    for i in (-1, 0, 1):
        box(f"ins_slot_{i}", (i * 0.75, 0, 1.128), (0.05, 1.4, 0.02), m["dark_steel"], bevel=0.0)


def build_conveyor(m):
    """滚筒输送机：10.0 × 1.2 × 0.9。

    **刻意不建滚筒**：前端 `RollerRig` 每帧写 8 个滚筒的实例矩阵做旋转，
    这里再放一套圆柱就会双份。GLB 只负责机架、支腿、侧梁、电机、控制盒，
    滚筒与定位条留给程序化那一套（y=0.82、半径 0.18，与 builders.ts 一致）。
    """
    # 机架床面（低于滚筒轴，露得出滚筒）
    box("cv_bed", (0, 0, 0.60), (9.8, 1.05, 0.06), m["dark_steel"], bevel=0.01)
    # 两侧侧梁：比滚筒轴高一点，滚筒夹在中间才像输送线
    for sy in (-1, 1):
        box(f"cv_rail_{sy}", (0, sy * 0.58, 0.86), (10.0, 0.06, 0.22), m["paint_dark"], bevel=0.01)
        box(f"cv_rail_cap_{sy}", (0, sy * 0.58, 0.98), (10.0, 0.09, 0.03), m["steel"], bevel=0.0)

    # 支腿：6 组，每组两根 + 横撑
    for i in range(6):
        x = -4.5 + i * 1.8
        for sy in (-1, 1):
            box(f"cv_leg_{i}_{sy}", (x, sy * 0.5, 0.29), (0.08, 0.08, 0.58), m["dark_steel"], bevel=0.005)
        box(f"cv_cross_{i}", (x, 0, 0.2), (0.06, 1.0, 0.06), m["dark_steel"], bevel=0.0)

    # 驱动电机与减速机
    box("cv_motor", (-4.9, 0.15, 0.45), (0.55, 0.42, 0.38), m["paint_dark"], bevel=0.02)
    cyl("cv_motor_shaft", (-4.6, 0.15, 0.45), 0.07, 0.2, m["steel"], axis="X", bevel=0.0)
    # 尾部张紧与端部溜槽
    box("cv_chute", (5.0, 0, 0.72), (0.5, 1.0, 0.24), m["steel"], bevel=0.01)
    # 控制盒 + 急停
    box("cv_ctrl_box", (4.4, 0.62, 0.95), (0.4, 0.24, 0.5), m["paint_dark"], bevel=0.02)
    box("cv_ctrl_screen", (4.4, 0.49, 0.98), (0.3, 0.02, 0.3), m["screen"], bevel=0.0)
    cyl("cv_estop", (4.4, 0.62, 1.24), 0.05, 0.06, m["warn_yellow"], bevel=0.0)
    # 支腿警示贴
    for sy in (-1, 1):
        box(f"cv_warn_{sy}", (0, sy * 0.62, 0.6), (0.5, 0.01, 0.12), m["warn_yellow"], bevel=0.0)


def build_aux_air(m):
    """空压机：2.4 × 1.6 × 2.0"""
    box("air_skid", (0, 0, 0.08), (2.3, 1.5, 0.16), m["dark_steel"], bevel=0.02)
    # 立式储气罐
    cyl("air_tank", (-0.55, 0, 0.95), 0.5, 1.5, m["paint_blue"], bevel=0.02)
    cyl("air_tank_top", (-0.55, 0, 1.74), 0.5, 0.06, m["steel"], bevel=0.01)
    cyl("air_tank_bottom", (-0.55, 0, 0.18), 0.5, 0.06, m["steel"], bevel=0.01)
    # 主机与电机
    box("air_motor", (0.55, 0, 0.55), (1.1, 1.2, 0.7), m["paint_light"], bevel=0.04)
    cyl("air_motor_fan", (0.55, -0.62, 0.62), 0.26, 0.12, m["dark_steel"], axis="Y", bevel=0.0)
    box("air_cooler", (0.55, 0, 1.05), (0.9, 1.0, 0.32), m["dark_steel"], bevel=0.02)
    # 排气管 + 阀门
    tube("air_pipe_out", [(-0.55, 0.3, 1.78), (0.1, 0.3, 1.9), (0.6, 0.3, 1.35)], 0.055, m["steel"])
    cyl("air_valve", (0.62, 0.3, 1.3), 0.08, 0.1, m["warn_yellow"], bevel=0.0)
    # 控制箱 + 压力表
    box("air_ctrl", (0.95, 0.75, 1.15), (0.4, 0.2, 0.5), m["paint_dark"], bevel=0.02)
    cyl("air_gauge", (0.95, 0.62, 1.2), 0.09, 0.05, m["steel"], axis="Y", bevel=0.0)
    box("air_warn", (-0.55, -0.52, 1.0), (0.3, 0.01, 0.2), m["warn_yellow"], bevel=0.0)
    # 排气压力铭牌：贴在主机正面（y=-0.6），钢牌 + 深色浮雕字
    box("air_nameplate_rim", (0.55, -0.605, 0.72), (0.57, 0.02, 0.15), m["steel"], bevel=0.004)
    box("air_nameplate", (0.55, -0.611, 0.72), (0.53, 0.02, 0.11), m["paint_light"], bevel=0.004)
    text("air_name_text", "0.8MPa", 0.05, (0.55, -0.624, 0.72), m["paint_dark"])


def build_aux_pump(m):
    """冷却泵组：1.6 × 1.4 × 1.4"""
    box("pump_base", (0, 0, 0.07), (1.5, 1.3, 0.14), m["dark_steel"], bevel=0.02)
    # 泵体（蜗壳）+ 电机（卧式，轴向 X）
    cyl("pump_body", (-0.15, 0, 0.45), 0.3, 0.5, m["paint_blue"], axis="X", bevel=0.02)
    cyl("pump_suction", (-0.15, -0.42, 0.45), 0.1, 0.22, m["steel"], axis="Y", bevel=0.0)
    cyl("pump_motor", (0.45, 0, 0.45), 0.26, 0.55, m["paint_dark"], axis="X", bevel=0.02)
    box("pump_coupling", (0.18, 0, 0.45), (0.2, 0.22, 0.22), m["steel"], bevel=0.01)
    # 进出口管 + 阀门手轮
    tube("pump_pipe_up", [(-0.15, 0.3, 0.55), (-0.15, 0.3, 1.05), (0.1, 0.3, 1.2)], 0.07, m["steel"])
    cyl("pump_handwheel", (0.1, 0.3, 1.22), 0.16, 0.03, m["warn_yellow"], bevel=0.0)
    # 压力表 + 铭牌
    cyl("pump_gauge", (0.35, 0.28, 0.75), 0.08, 0.05, m["steel"], axis="Y", bevel=0.0)
    box("pump_plate", (-0.15, -0.31, 0.75), (0.26, 0.01, 0.12), m["warn_yellow"], bevel=0.0)
    text("pump_name_text", "CP-40", 0.045, (-0.15, -0.322, 0.75), m["paint_dark"])


# ---------------------------------------------------------------- 导出


def apply_box_uv(obj, scale=1.0):
    """按主导法线做立方投影 UV：`scale=1` 时 1 UV = 1 米。

    不用 `bpy.ops.uv.cube_project`：headless 下 UV 操作依赖 edit-mode context，
    Blender 5.x 偶发 poll 失败。手算立方投影二十行，且完全不受版本影响——
    我们只需要"每个面沿自己最平的那个方向展开"，不需要任何接缝优化。

    法线贴图必须靠 UV 采样，而此前的合并管线把 UV 直接删了（只靠顶点色），
    所以这一步是"细节贴图"能落地的前置条件，不是可选项。
    """
    me = obj.data
    if not me.polygons:
        return
    layer = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    mw = obj.matrix_world
    nmat = mw.to_3x3().inverted().transposed()
    for poly in me.polygons:
        n = (nmat @ poly.normal).normalized()
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in poly.loop_indices:
            co = mw @ me.vertices[me.loops[li].vertex_index].co
            if ax == 0:  # 朝 ±X 的面：用 (y, z)
                u, v = co.y, co.z
            elif ax == 1:  # 朝 ±Y：用 (x, z)
                u, v = co.x, co.z
            else:  # 朝 ±Z：用 (x, y)
                u, v = co.x, co.y
            layer.data[li].uv = (u * scale, v * scale)


def export(name, out_dir):
    # 先给所有网格补立方投影 UV，再导出（glTF 会把 uv 一起写进 GLB）
    for obj in bpy.data.objects:
        if obj.type == "MESH":
            apply_box_uv(obj)

    path = os.path.join(out_dir, f"{name}.glb")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_materials="EXPORT",
    )
    size = os.path.getsize(path)
    tris = sum(len(o.data.loop_triangles) for o in bpy.data.objects if o.type == "MESH" and (o.data.calc_loop_triangles() or True))
    print(f"EXPORTED {name}: {size/1024:.0f} KB, {tris} tris")


def main():
    argv = sys.argv
    out_dir = argv[argv.index("--") + 1] if "--" in argv else "frontend/public/models"
    os.makedirs(out_dir, exist_ok=True)

    for name, builder in (
        ("cnc", build_cnc),
        ("robot", build_robot),
        ("inspection", build_inspection),
        ("conveyor", build_conveyor),
        ("aux_air", build_aux_air),
        ("aux_pump", build_aux_pump),
    ):
        reset_scene()
        builder(materials())
        export(name, out_dir)


main()
