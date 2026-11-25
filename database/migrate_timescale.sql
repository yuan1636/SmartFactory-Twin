-- ============================================================================
-- device_telemetry → TimescaleDB hypertable 迁移
--
-- 依据：docs/spec_phase4.md §6（v2.0）
-- 前置：已换成 timescale/timescaledb:2.17.2-pg16 镜像，且 schema.sql 与数据都已就位
-- 用法（在仓库根目录、PowerShell）：
--   Get-Content database\migrate_timescale.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
--
-- 本脚本可重复执行：
--   · CREATE EXTENSION IF NOT EXISTS   —— 重复无害
--   · DROP CONSTRAINT IF EXISTS        —— 主键已删则跳过
--   · create_hypertable(if_not_exists)  —— 已是 hypertable 则跳过（并返回 NULL）
-- 失败后的正确处理是「从 dump 重来」，不要在半个状态上打补丁。
--
-- ⚠️ migrate_data => true 会取 ACCESS EXCLUSIVE 锁：执行期间该表不可读写。
--    执行前必须停掉模拟器，否则后端写入会被阻塞。
-- ============================================================================

SET TIME ZONE 'UTC';

-- 1) 扩展。官方镜像已预加载 shared_preload_libraries，这里只需建对象。
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 2) 删主键。
--    为什么必须删：hypertable 上每个唯一索引都必须包含分区列 ts，
--    而 device_telemetry_pkey 是 PRIMARY KEY (id)，不含 ts，
--    不删会报 cannot create a unique index without the column "ts" (used in partitioning)。
--    id 列本身、NOT NULL 与序列默认值都保留，后端 INSERT ... RETURNING id 不受影响。
ALTER TABLE device_telemetry DROP CONSTRAINT IF EXISTS device_telemetry_pkey;

-- 3) 转 hypertable。
--    chunk_time_interval 取 1 天：当前 7.5 天数据 → 约 8 个 chunk，
--    既能让 chunk 剪枝生效，又不至于块太多拖慢查询规划。
--    migrate_data 必须为 true：表非空，不搬数据会直接失败。
SELECT create_hypertable(
         'device_telemetry',
         'ts',
         chunk_time_interval => INTERVAL '1 day',
         migrate_data        => true,
         if_not_exists       => true
       );

-- 4) 压缩设置（只设策略，不执行压缩）。
--    segmentby=device_id：接口查询几乎都带 device_id，分段后只需解压命中的段。
--    orderby=ts DESC：段内按时间倒序，查"最近 N 条"可顺序读取；时间戳单调，delta 编码压缩率最高。
--    注意：压缩块不可写入。压缩边界必须大于可能的回填深度（本阶段取 7 天，见 spec §6.4）。
ALTER TABLE device_telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby   = 'ts DESC'
);

-- 5) 重算统计信息。
--    不做这一步，pg_statistic 还停留在普通表状态，chunk 剪枝与连接顺序可能选错，
--    后续的耗时对比会得到一组没有意义的结果。
ANALYZE device_telemetry;

-- 6) 自检：把关键状态打出来，供验收文档直接粘贴
SELECT hypertable_name, num_chunks, compression_enabled
FROM timescaledb_information.hypertables
WHERE hypertable_name = 'device_telemetry';

SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'device_telemetry'::regclass
ORDER BY conname;
