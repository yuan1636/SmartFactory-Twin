-- ============================================================================
-- SmartFactory Twin 第 2 阶段种子数据
-- 依据：docs/spec_phase2.md 2.9（v1.0 冻结）
-- 外键顺序：workshops → production_lines → devices
-- 全部 ON CONFLICT DO NOTHING，可重复执行。
-- ============================================================================

SET TIME ZONE 'UTC';

-- 1) 车间
INSERT INTO workshops (id, name) VALUES
    ('WS-A', '机加工车间'),
    ('WS-B', '检测与装配车间')
ON CONFLICT (id) DO NOTHING;

-- 2) 生产线
INSERT INTO production_lines (id, name, workshop_id, rated_capacity_per_hour) VALUES
    ('LINE-A1', '生产线 A1', 'WS-A', 30),
    ('LINE-A2', '生产线 A2', 'WS-A', 30),
    ('LINE-B1', '生产线 B1', 'WS-B', 30),
    ('LINE-B2', '生产线 B2', 'WS-B', 30)
ON CONFLICT (id) DO NOTHING;

-- 3) 设备（14 台：12 台核心 + 2 台辅助）
INSERT INTO devices (device_id, device_name, device_type, workshop_id, line_id, model, status, installed_at) VALUES
    ('CNC-01',  '数控机床 1',   'CNC',        'WS-A', 'LINE-A1', 'VMC-850',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('ROB-01',  '机械臂 1',     'ROBOT',      'WS-A', 'LINE-A1', 'IRB-1200', 'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CONV-01', '传送带 1',     'CONVEYOR',   'WS-A', 'LINE-A1', 'BELT-6M',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CNC-02',  '数控机床 2',   'CNC',        'WS-A', 'LINE-A2', 'VMC-850',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('ROB-02',  '机械臂 2',     'ROBOT',      'WS-A', 'LINE-A2', 'IRB-1200', 'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CONV-02', '传送带 2',     'CONVEYOR',   'WS-A', 'LINE-A2', 'BELT-6M',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CNC-03',  '数控机床 3',   'CNC',        'WS-B', 'LINE-B1', 'VMC-850',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('ROB-03',  '机械臂 3',     'ROBOT',      'WS-B', 'LINE-B1', 'IRB-1200', 'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('INSP-01', '自动检测台 1', 'INSPECTION', 'WS-B', 'LINE-B1', 'VIS-200',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CNC-04',  '数控机床 4',   'CNC',        'WS-B', 'LINE-B2', 'VMC-850',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('ROB-04',  '机械臂 4',     'ROBOT',      'WS-B', 'LINE-B2', 'IRB-1200', 'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('INSP-02', '自动检测台 2', 'INSPECTION', 'WS-B', 'LINE-B2', 'VIS-200',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('AIR-01',  '空压机',       'AUX',        NULL,   NULL,      'GA-15',    'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('PUMP-01', '冷却泵',       'AUX',        NULL,   NULL,      'CP-50',    'RUNNING', '2025-06-01T00:00:00+00:00')
ON CONFLICT (device_id) DO NOTHING;

-- 初始 status 统一 RUNNING：模拟器不写该字段（G-10），
-- 若初始为 IDLE，第一次告警发生前设备会一直呈停机状态，演示效果不对。
