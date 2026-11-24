-- ============================================================================
-- SmartFactory Twin 第 2 阶段建表脚本
-- 依据：docs/spec_phase2.md 第 2 节数据字典（v1.0 冻结）
--
-- 本文件只建表、只建索引，全部可重复执行。
-- 规则（G-16）：本文件内不得出现任何删表语句；清库重建请用 database/reset.sql。
-- 时间口径：全部 TIMESTAMPTZ 存 UTC。
-- ============================================================================

-- 会话统一 UTC，避免容器时区与本地时区混用导致曲线整体偏移（G-05）
SET TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------
-- 2.1 workshops（车间表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workshops (
    id          VARCHAR(16)  PRIMARY KEY,
    name        VARCHAR(64)  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
COMMENT ON TABLE  workshops        IS '车间表';
COMMENT ON COLUMN workshops.id     IS '车间编号，如 WS-A';
COMMENT ON COLUMN workshops.name   IS '车间名称';

-- ---------------------------------------------------------------------------
-- 2.2 production_lines（生产线表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_lines (
    id                       VARCHAR(16)  PRIMARY KEY,
    name                     VARCHAR(64)  NOT NULL,
    workshop_id              VARCHAR(16)  NOT NULL,
    rated_capacity_per_hour  INTEGER      NOT NULL DEFAULT 30
                             CHECK (rated_capacity_per_hour > 0),
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_lines_workshop FOREIGN KEY (workshop_id)
        REFERENCES workshops (id) ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lines_workshop ON production_lines (workshop_id);
COMMENT ON TABLE  production_lines                          IS '生产线表';
COMMENT ON COLUMN production_lines.rated_capacity_per_hour  IS '额定产能，件/小时';

-- ---------------------------------------------------------------------------
-- 2.3 devices（设备基础表，14 台）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
    device_id     VARCHAR(16)  PRIMARY KEY,
    device_name   VARCHAR(64)  NOT NULL,
    device_type   VARCHAR(16)  NOT NULL
                  CHECK (device_type IN ('CNC','ROBOT','CONVEYOR','INSPECTION','AUX')),
    workshop_id   VARCHAR(16)  NULL,
    line_id       VARCHAR(16)  NULL,
    model         VARCHAR(64)  NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'IDLE'
                  CHECK (status IN ('RUNNING','IDLE','STOPPED','ALARM','MAINTENANCE')),
    installed_at  TIMESTAMPTZ  NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_devices_workshop FOREIGN KEY (workshop_id)
        REFERENCES workshops (id) ON UPDATE CASCADE,
    CONSTRAINT fk_devices_line FOREIGN KEY (line_id)
        REFERENCES production_lines (id) ON UPDATE CASCADE,
    CONSTRAINT ck_devices_aux_no_line CHECK (device_type <> 'AUX' OR line_id IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_devices_line     ON devices (line_id);
CREATE INDEX IF NOT EXISTS idx_devices_workshop ON devices (workshop_id);
CREATE INDEX IF NOT EXISTS idx_devices_status   ON devices (status);
COMMENT ON TABLE  devices             IS '设备基础表，14 台';
COMMENT ON COLUMN devices.status      IS '当前状态，仅后端可写：告警置 ALARM，全部告警解除回 RUNNING，维护记录置 MAINTENANCE';
COMMENT ON COLUMN devices.workshop_id IS '辅助设备（AIR-01/PUMP-01）为全厂公用，此处为 NULL';

-- ---------------------------------------------------------------------------
-- 2.4 device_telemetry（设备时序数据表）
-- 本阶段为普通表，未启用 hypertable（预留，本阶段不实现，见 L-01）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_telemetry (
    id              BIGSERIAL        PRIMARY KEY,
    device_id       VARCHAR(16)      NOT NULL,
    ts              TIMESTAMPTZ      NOT NULL,
    temperature     DOUBLE PRECISION NOT NULL CHECK (temperature BETWEEN -20 AND 300),
    vibration       DOUBLE PRECISION NOT NULL CHECK (vibration BETWEEN 0 AND 100),
    current         DOUBLE PRECISION NOT NULL CHECK (current BETWEEN 0 AND 500),
    speed           INTEGER          NOT NULL CHECK (speed >= 0),
    running_status  VARCHAR(16)      NOT NULL
                    CHECK (running_status IN ('RUNNING','IDLE','STOPPED')),
    inserted_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT fk_telemetry_device FOREIGN KEY (device_id)
        REFERENCES devices (device_id) ON DELETE CASCADE,
    CONSTRAINT uq_telemetry_device_ts UNIQUE (device_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON device_telemetry (device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_ts        ON device_telemetry (ts DESC);
COMMENT ON TABLE  device_telemetry      IS '设备时序数据，2 秒一条，本阶段为普通表（未启用 hypertable，见 L-01）';
COMMENT ON COLUMN device_telemetry.ts   IS '采样时间，UTC；原方案字段名 timestamp 因是保留字改为 ts';
COMMENT ON COLUMN device_telemetry.vibration IS '振动速度有效值 mm/s';

-- ---------------------------------------------------------------------------
-- 2.5 production_orders（生产订单表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_orders (
    order_id            VARCHAR(32)  PRIMARY KEY,
    product_id          VARCHAR(32)  NOT NULL,
    planned_quantity    INTEGER      NOT NULL CHECK (planned_quantity > 0),
    actual_quantity     INTEGER      NOT NULL DEFAULT 0 CHECK (actual_quantity >= 0),
    qualified_quantity  INTEGER      NOT NULL DEFAULT 0 CHECK (qualified_quantity >= 0),
    line_id             VARCHAR(16)  NOT NULL,
    planned_start       TIMESTAMPTZ  NOT NULL,
    planned_end         TIMESTAMPTZ  NOT NULL,
    status              VARCHAR(16)  NOT NULL DEFAULT 'PLANNED'
                        CHECK (status IN ('PLANNED','IN_PROGRESS','COMPLETED','DELAYED')),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_orders_line FOREIGN KEY (line_id)
        REFERENCES production_lines (id) ON UPDATE CASCADE,
    CONSTRAINT ck_orders_qty  CHECK (qualified_quantity <= actual_quantity),
    CONSTRAINT ck_orders_time CHECK (planned_end > planned_start)
);
CREATE INDEX IF NOT EXISTS idx_orders_line_status ON production_orders (line_id, status);
COMMENT ON TABLE production_orders IS '生产订单表，由模拟器订单推进器维护计数';

-- ---------------------------------------------------------------------------
-- 2.6 alarms（告警表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alarms (
    alarm_id     BIGSERIAL    PRIMARY KEY,
    device_id    VARCHAR(16)  NOT NULL,
    alarm_type   VARCHAR(24)  NOT NULL
                 CHECK (alarm_type IN ('TEMPERATURE','VIBRATION','CURRENT','STATUS')),
    alarm_level  VARCHAR(16)  NOT NULL
                 CHECK (alarm_level IN ('INFO','WARNING','CRITICAL')),
    message      TEXT         NOT NULL,
    detected_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ  NULL,
    CONSTRAINT fk_alarms_device FOREIGN KEY (device_id)
        REFERENCES devices (device_id) ON DELETE CASCADE,
    CONSTRAINT ck_alarms_resolved CHECK (resolved_at IS NULL OR resolved_at >= detected_at)
);
CREATE INDEX IF NOT EXISTS idx_alarms_open ON alarms (device_id, alarm_type) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alarms_time ON alarms (detected_at DESC);
COMMENT ON TABLE alarms IS '告警表，同一设备同一类型 5 分钟冷却（见 G-09）';

-- ---------------------------------------------------------------------------
-- 2.7 maintenance_records（维护记录表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_records (
    record_id         BIGSERIAL     PRIMARY KEY,
    device_id         VARCHAR(16)   NOT NULL,
    maintenance_type  VARCHAR(16)   NOT NULL
                      CHECK (maintenance_type IN ('ROUTINE','REPAIR','INSPECTION')),
    description       TEXT          NULL,
    started_at        TIMESTAMPTZ   NOT NULL,
    finished_at       TIMESTAMPTZ   NULL,
    cost              NUMERIC(10,2) NULL CHECK (cost >= 0),
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT fk_maint_device FOREIGN KEY (device_id)
        REFERENCES devices (device_id) ON DELETE CASCADE,
    CONSTRAINT ck_maint_time CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS idx_maint_device ON maintenance_records (device_id, started_at DESC);
COMMENT ON TABLE maintenance_records IS '维护记录表，本阶段仅手工写入（自动触发预留，见 L-07）';

-- ---------------------------------------------------------------------------
-- 2.8 anomaly_injection（异常注入真值表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anomaly_injection (
    id            BIGSERIAL    PRIMARY KEY,
    device_id     VARCHAR(16)  NOT NULL,
    anomaly_type  VARCHAR(24)  NOT NULL
                  CHECK (anomaly_type IN ('TEMP_DRIFT','VIB_SPIKE','CURRENT_ABNORMAL')),
    started_at    TIMESTAMPTZ  NOT NULL,
    ended_at      TIMESTAMPTZ  NULL,
    params        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_anomaly_device FOREIGN KEY (device_id)
        REFERENCES devices (device_id) ON DELETE CASCADE,
    CONSTRAINT ck_anomaly_time CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS idx_anomaly_device_time ON anomaly_injection (device_id, started_at);
COMMENT ON TABLE anomaly_injection IS '异常注入真值表，第 4 阶段模型评估的对照标签，本阶段只写不用';
