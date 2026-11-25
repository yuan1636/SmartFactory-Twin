-- ============================================================================
-- 清库重建脚本
--
-- ⚠️ 警告：本脚本会删除全部 10 张表及其所有数据（遥测、订单、告警、维护记录、
--          异常真值、模型版本、分数存档全部清空，不可恢复）。只在需要从零重来时使用。
--          建表请用 database/schema.sql（那个脚本不删任何东西）。
--
-- 用法（compose 启动的容器，database/ 已挂载到容器 /database）：
--   docker exec -i sftwin-db psql -U sf -d smartfactory -f /database/reset.sql
--
-- 若用 docs/spec_phase2.md 7.1 的 docker run 命令（没挂载目录），则改为分三步：
--   Get-Content database\reset_drop_only.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
--   Get-Content database\schema.sql         | docker exec -i sftwin-db psql -U sf -d smartfactory
--   Get-Content database\seed.sql           | docker exec -i sftwin-db psql -U sf -d smartfactory
-- ============================================================================

SET TIME ZONE 'UTC';

-- 按外键依赖逆序删除（子表先删，父表后删）
-- anomaly_scores 同时指向 devices 与 model_versions，必须排在这两张之前
DROP TABLE IF EXISTS anomaly_scores      CASCADE;
DROP TABLE IF EXISTS anomaly_injection   CASCADE;
DROP TABLE IF EXISTS maintenance_records CASCADE;
DROP TABLE IF EXISTS alarms              CASCADE;
DROP TABLE IF EXISTS production_orders   CASCADE;
DROP TABLE IF EXISTS device_telemetry    CASCADE;
DROP TABLE IF EXISTS model_versions      CASCADE;
DROP TABLE IF EXISTS devices             CASCADE;
DROP TABLE IF EXISTS production_lines    CASCADE;
DROP TABLE IF EXISTS workshops           CASCADE;

-- 重建表结构与种子数据
\i /database/schema.sql
\i /database/seed.sql
