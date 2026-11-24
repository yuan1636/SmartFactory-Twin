-- ============================================================================
-- 只做删除（供未挂载 database 目录的容器使用，配合 schema.sql / seed.sql 分步执行）
-- ⚠️ 会清空全部数据，不可恢复。完整一键重建请用 database/reset.sql。
-- ============================================================================

SET TIME ZONE 'UTC';

DROP TABLE IF EXISTS anomaly_injection   CASCADE;
DROP TABLE IF EXISTS maintenance_records CASCADE;
DROP TABLE IF EXISTS alarms              CASCADE;
DROP TABLE IF EXISTS production_orders   CASCADE;
DROP TABLE IF EXISTS device_telemetry    CASCADE;
DROP TABLE IF EXISTS devices             CASCADE;
DROP TABLE IF EXISTS production_lines    CASCADE;
DROP TABLE IF EXISTS workshops           CASCADE;
