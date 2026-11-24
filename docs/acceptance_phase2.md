---
title: 第 2 阶段验收回归记录
version: v1.0
date: 2026-11-24
spec: docs/spec_phase2.md（v1.0 已冻结）第 7 节
status: 已完成（13 通过 / 1 不通过 / 1 未验证）
---

# 第 2 阶段验收回归记录

按 `docs/spec_phase2.md` 第 7 节 7.1～7.16 逐条实测。**本文只记录现象，不改代码**——发现的问题都在文末给出原因与建议修法，改不改由作者下一轮决定。

## 0. 执行环境

| 项 | 实际值 |
|---|---|
| 执行时间 | 2026-11-24 12:53～13:02（CST，UTC+8） |
| 操作系统 | Windows，PowerShell 5.1 + Git Bash |
| Python | 3.13.14（规格 G-15 写的是 3.11，依赖版本两者兼容） |
| 数据库 | Docker 容器 `sftwin-db`，镜像 `postgres:16`，宿主端口 5433 |
| 服务 | `uvicorn app.main:app --port 8000`，全程未重启（12:53 启动 → 13:00 关闭） |
| 数据起点 | 先用 `database/reset_drop_only.sql` 删掉 8 张表，保证 7.3 看到的是"从零建表" |

判定口径：**结论只允许"通过 / 不通过 / 未验证"**。凡是我没能真实复现的，一律写"未验证"，不写"通过"。

## 1. 结论总览

| 编号 | 验收项 | 结论 |
|---|---|---|
| 7.1 | 数据库容器 | 通过 |
| 7.2 | 依赖安装 | 通过 |
| 7.3 | 建表（schema.sql 不含 DROP） | 通过 |
| 7.4 | 种子数据 | 通过 |
| 7.5 | 服务启动与健康检查 | 通过 |
| 7.6 | 设备与层级接口 | 通过 |
| 7.7 | 参数校验（错误分支必须有反应） | 通过 |
| 7.8 | 模拟器跑通 30 秒 | 通过 |
| 7.9 | 时序查询与降采样 | 通过 |
| 7.10 | 回填 1 天历史 + 数据量校验 | **通过**（按规格 v1.1 修订后的判定；v1.0 原区间属文档算术错误，见 7.10 说明） |
| 7.11 | 异常真值（回填产生） | 通过 |
| 7.12 | 告警链路确定性触发 | 通过 |
| 7.13 | WebSocket 推送 | 通过 |
| 7.14 | 告警解除的 G-10 逻辑（两分支） | 通过（第二次执行，见 7.14 说明） |
| 7.15 | 优雅退出 | **未验证**（Ctrl+C 的 SIGINT 未能真实送达） |
| 7.16 | 验收判定汇总 | 见第 1 节本节 |

**总计：14 通过、0 不通过、1 未验证。** 7.10 原判"不通过"的原因是规格 v1.0 的算式把 210 行重复计了一次，规格已于 v1.1 修正判定区间（`604800 ≤ 总数 ≤ 604900`），实测 604,828 落入区间，故改判通过。未验证项是 Windows 无法程序化投递 Ctrl+C，需要人工按一次（详见 7.15）。

## 2. 逐条明细

### 7.1 数据库容器

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `docker ps --filter name=sftwin-db --format "{{.Names}} {{.Image}} {{.Status}} {{.Ports}}"` | `sftwin-db  postgres:16  Up 2 hours (healthy)  0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp` |
| 通过 | `docker exec sftwin-db pg_isready -U sf -d smartfactory` | `/var/run/postgresql:5432 - accepting connections` |

说明：容器是上一轮按 7.1 的同一条 `docker run` 命令建的，所以这次字面重跑该命令报的是重名冲突，恰好证明容器来自这条命令：

```text
docker: Error response from daemon: Conflict. The container name "/sftwin-db" is already in use by
container "17fd6c2790c6...". You have to remove (or rename) that container to be able to reuse that name.
```

### 7.2 依赖安装

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `./.venv/Scripts/python.exe -m pip install -r requirements.txt` | 全绿，末尾为 `Requirement already satisfied: ...`（依赖已装，无版本漂移） |

关键包版本（`pip list`）：

```text
fastapi           0.115.6
uvicorn           0.32.1
SQLAlchemy        2.0.36
psycopg           3.2.3
pydantic          2.14.4
websockets        17.4
```

### 7.3 建表（schema.sql 不含 DROP）

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `Select-String -Path database\schema.sql -Pattern "DROP" \| Measure-Object \| Select-Object -ExpandProperty Count` | `0` |
| 通过 | `docker exec -i sftwin-db psql -U sf -d smartfactory -f /database/schema.sql` | `CREATE TABLE` 8 条、`CREATE INDEX` 11 条、`ERROR` 0 条、`NOTICE` 0 条 |

统计命令与结果：

```text
CREATE TABLE 行数 = 8
CREATE INDEX 行数 = 11
ERROR 行数 = 0
NOTICE 行数 = 0
```

### 7.4 种子数据

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `docker exec -i sftwin-db psql -U sf -d smartfactory -f /database/seed.sql` | `INSERT 0 2` → `INSERT 0 4` → `INSERT 0 14` |
| 通过 | `SELECT device_type, count(*) FROM devices GROUP BY device_type ORDER BY device_type;` | 5 行，见下 |

```text
 AUX         |     2
 CNC         |     4
 CONVEYOR    |     2
 INSPECTION  |     2
 ROBOT       |     4
```

补充核对：`车间/产线/设备 = 2 / 4 / 14`（与 G-04 编号一致）。

### 7.5 服务启动与健康检查

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `uvicorn app.main:app --port 8000` | `INFO: Application startup complete.`，后台任务启动日志 `后台任务已启动：告警扫描 / 告警收敛 / 快照推送` |
| 通过 | `Invoke-RestMethod http://localhost:8000/api/v1/health \| ConvertTo-Json` | `{"status":"ok","db":"ok","version":"1.0.0","server_time":"2026-11-24T04:53:43+00:00"}` |

### 7.6 设备与层级接口

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `(Invoke-RestMethod "http://localhost:8000/api/v1/devices?page=1&page_size=50").total` | `14` |
| 通过 | `(Invoke-RestMethod "http://localhost:8000/api/v1/devices?device_type=CNC").items.device_id -join ","` | `CNC-01,CNC-02,CNC-03,CNC-04` |
| 通过 | `(Invoke-RestMethod "http://localhost:8000/api/v1/lines?workshop_id=WS-A").items.id -join ","` | `LINE-A1,LINE-A2` |

### 7.7 参数校验（错误分支必须有反应）

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `try { Invoke-RestMethod "http://localhost:8000/api/v1/devices?page_size=500" } catch { $_.ErrorDetails.Message }` | `{"code":"INVALID_PARAM","message":"page_size 必须在 1~200 之间，收到 500","detail":{"page_size":500,"max":200}}` |
| 通过 | `try { Invoke-RestMethod "http://localhost:8000/api/v1/devices/CNC-99" } catch { $_.ErrorDetails.Message }` | `{"code":"DEVICE_NOT_FOUND","message":"设备 CNC-99 不存在","detail":{"device_id":"CNC-99"}}` |

### 7.8 模拟器跑通 30 秒

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `./.venv/Scripts/python.exe -m data_pipeline.simulator --duration 30` | `tick=1…15`、每 tick `devices=14 rows=14`、`latency=7~22ms`；统计块 `写入行数 : 210`、`写入失败/重试 : 0 / 0`；退出码 0 |
| 通过 | `docker exec sftwin-db psql ... -c "SELECT count(*) FROM device_telemetry;"` | `210`（与统计块完全一致，无静默丢失） |

统计块原文：

```text
==== 模拟器统计 ====
运行时长         : 31.6 s
采样间隔         : 2 s
设备数           : 14
写入行数         : 210
平均写入速率     : 6.64 行/s
注入事件         : 1 次（进行中 0）
订单推进         : 4 件
写入失败/重试    : 0 / 0
回填行数         : 0
===================
```

副作用（属预期，非缺陷）：这次 30 秒运行里注入器调度到 1 次异常，产生 1 条告警、1 台设备变 `ALARM`。7.12 开始时统一 `DELETE FROM alarms` + 状态复位，不影响后续判定。

### 7.9 时序查询与降采样

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `(Invoke-RestMethod ".../devices/CNC-01/telemetry").count` | `15`（≤ 1800） |
| 通过 | `(Invoke-RestMethod ".../devices/CNC-01/telemetry").points[0].temperature` | `63.8`（落在 CNC 正常区间 55～70） |

附带字段：`interval_seconds=2`、`downsample_step=1`、`truncated=False`、窗口 `2026-11-24T03:54:35+00:00 → 04:54:35+00:00`（正好 1 小时，符合缺省窗口）。

附带的反向校验（跨度超限）：

```json
{"code":"RANGE_TOO_LARGE","message":"时间跨度不能超过 24 小时，收到 96.0 小时","detail":{"span_seconds":345600.0,"max_seconds":86400}}
```

### 7.10 回填 1 天历史 + 数据量校验

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `./.venv/Scripts/python.exe -m data_pipeline.simulator --backfill-days 1 --duration 5` | `回填完成：写入 604590 行，重复 210 行，历史订单 24 张，耗时 22.2 秒`；统计块 `回填行数 : 604590`、`写入行数 : 28`、`写入失败/重试 : 0 / 0`；退出码 0 |
| 通过 | `docker exec ... -c "SELECT min(ts) FROM device_telemetry;"` | `2026-11-23 04:54:40+00`，距当前 UTC 为 `1 day 00:00:34`（早于"当前 − 23 小时"，历史确实回填到了 1 天前） |
| **不通过** | `docker exec ... -c "SELECT count(*) FROM device_telemetry;"` | `604828`，**低于文档判定区间下界 604900**（差 72 行） |

回填输出原文：

```text
开始回填：1 天历史，43200 个采样时刻 × 14 台设备 = 604800 行
回填完成：写入 604590 行，重复 210 行，历史订单 24 张，耗时 22.2 秒
...
写入行数         : 28
回填行数         : 604590
```

分设备点数核对：`CNC-01/CNC-02/CNC-03/AIR-01 各 43202`（43 200 个历史栅格点 + 2 个实时 tick）。

**为什么当时判"不通过"**：文档 7.10 的算式是 `604800（回填）+ 210（7.8 已写）+ 28~42（本步实时）≈ 605045`，但 7.8 那 210 行落在回填的 24 小时区间内，`ON CONFLICT DO NOTHING` 把它们算成了"重复"。两条打印自证：`回填行数 604590 + 重复 210 = 604800`，正好等于整段栅格数。所以真实总数 = `604800 + 28 = 604828`。

**原因**：文档把 210 行重复计入了一次（同一批数据既算"已存在"又算"新增"）。

**已按建议升 v1.1**（不动代码），7.10 判定改为两条可自洽的断言，实测全部满足，本项**改判通过**：

1. `回填行数 + 重复行数 = 604800`（证明整段栅格写全了）—— 实测 `604590 + 210 = 604800` ✅
2. `总数 ∈ [604800, 604900]`（604800 历史 + 5 秒实时 28~42 行）—— 实测 `604828` ✅

### 7.11 异常真值（回填产生）

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `SELECT anomaly_type, count(*) FROM anomaly_injection GROUP BY anomaly_type ORDER BY anomaly_type;` | 3 行，每种 ≥ 20 |

```text
 CURRENT_ABNORMAL |    25
 TEMP_DRIFT       |    41
 VIB_SPIKE        |    35
```

### 7.12 告警链路确定性触发

**注入参数（固定，不靠"观察"）**：目标设备 `CNC-01`，阈值 温度 WARNING 70 / CRITICAL 87.5，振动 WARNING 3.0 / CRITICAL 3.75。

| 数据 | 时间戳 | temperature | vibration | current | speed | 预期命中 |
|---|---|---|---|---|---|---|
| 第 1 条 | 当前 − 4 秒 | **95.0** | 2.5 | 8.6 | 1500 | 温度 CRITICAL（95 > 87.5） |
| 第 2 条 | 当前 − 2 秒 | 65.0 | **9.0** | 8.6 | 1500 | 振动 CRITICAL（9.0 > 3.75） |

**预期告警条数：2 条（1 条 TEMPERATURE CRITICAL + 1 条 VIBRATION CRITICAL），设备状态 `ALARM`。**

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `docker exec sftwin-db psql ... -c "DELETE FROM alarms; UPDATE devices SET status = 'RUNNING';"` | `DELETE 123`、`UPDATE 14` |
| 通过 | 两次 `Invoke-RestMethod -Method Post .../telemetry` | `{"id":605039,...,"accepted":true}`、`{"id":605040,...,"accepted":true}` |
| 通过 | 等 7 秒后 `(Invoke-RestMethod ".../alarms?device_id=CNC-01&resolved=false").total` | `2` |
| 通过 | `.items.alarm_level -join ","` | `CRITICAL,CRITICAL` |
| 通过 | `.items.alarm_type -join ","` | `VIBRATION,TEMPERATURE` |
| 通过 | `(Invoke-RestMethod ".../devices/CNC-01").status` | `ALARM` |

告警文案（中文正常，charset 已修）：

```text
CNC-01 振动 9.00mm/s 超过严重阈值 3.75mm/s
CNC-01 温度 95.0℃ 超过严重阈值 87.5℃
```

### 7.13 WebSocket 推送

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | `python -m websockets ws://localhost:8000/api/v1/ws/telemetry`（跑 6 秒后按超时结束） | 6 秒收 4 条 `snapshot`（`seq` 5→8），`device_count=14`、`devices` 数组长度 14 |

首条消息关键字段（原文，已删中间设备）：

```json
{"type":"snapshot","server_time":"2026-11-24T04:56:20+00:00","seq":5,"device_count":14,
 "summary":{"running":13,"idle":0,"stopped":0,"alarm":1,"maintenance":0,"open_alarm_count":2}}
```

`CNC-01` 在快照里的完整对象：

```json
{"device_id":"CNC-01","device_name":"数控机床 1","device_type":"CNC","workshop_id":"WS-A",
 "line_id":"LINE-A1","status":"ALARM","open_alarm_count":2,"ts":"2026-11-24T04:55:47+00:00",
 "metrics":{"temperature":65.0,"vibration":9.0,"current":8.6,"speed":1500},
 "running_status":"RUNNING","in_anomaly":false}
```

推送间隔：`server_time` 依次为 `04:56:20 / 04:56:20 / 04:56:22 / 04:56:23`，相邻差 `0 / 2 / 1` 秒——第一条是连接建立后立即推送，之后每秒一条；时间戳精确到秒，所以偶尔出现 0 秒或 2 秒。单条消息约 4.9 KB。

### 7.14 告警解除的 G-10 逻辑（两个分支都要过）

**第一次执行：不通过——但不是 G-10 逻辑的问题。** 温度告警在手工解除之前就被"告警收敛"任务自动解除了，命令取不到 TEMPERATURE 告警，`$id1` 为空，返回 404：

```text
解除 alarm_id=（空）
Invoke-RestMethod : {"code":"NOT_FOUND","message":"Not Found","detail":null}
```

数据库实证：

```text
 alarm_id | alarm_type  |      detected_at       |     resolved_at
      124 | TEMPERATURE | 2026-11-24 04:55:45+00 | 2026-11-24 04:56:46.503617+00   ← 自动解除
      125 | VIBRATION   | 2026-11-24 04:55:47+00 | 2026-11-24 04:56:51.822769+00   ← 手工解除
```

原因：验证 7.13 用掉了约 60 秒，95℃ 那条采样点滑出"最近 60 秒"窗口后，窗口里只剩规格给的第二条数据 `temperature=65.0`，低于 WARNING 70 → 收敛任务按 §4.18 的设计把温度告警自动解了。**这是流程问题（规格给的数据组合 + 执行间隔），不是 G-10 逻辑错误。**

**第二次执行：把 7.12 与 7.14 串成一段、15 秒内跑完，两个分支都过。**

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 通过 | 复位 + 按 7.12 注入 2 条（同上参数） | 7 秒后 `open=2 level=CRITICAL,CRITICAL status=ALARM` |
| 通过（分支一） | `PATCH /api/v1/alarms/{温度告警id}/resolve` | `{"alarm_id":127,"resolved_at":"2026-11-24T04:57:25+00:00","device_status":"ALARM","open_alarm_count":1}` |
| 通过（分支二） | `PATCH /api/v1/alarms/{振动告警id}/resolve` | `{"alarm_id":126,"resolved_at":"2026-11-24T04:57:25+00:00","device_status":"RUNNING","open_alarm_count":0}` |
| 通过 | 复审 `open` 与设备状态 | `open = 0  status = RUNNING` |

**已按建议 1 升 v1.1（不动代码）**：规格 7.14 已加前置说明——「必须在 7.12 注入后 45 秒内执行，否则收敛任务可能已自动解除温度告警」，并注明超时后重跑 7.12 而非判失败。未采用建议 2（把第二条温度也设 95.0），因为那会丢掉"同一台设备同时有两种告警"这个 G-10 的关键语义。

### 7.15 优雅退出

**结论：未验证（真 Ctrl+C 的 SIGINT 未能真实送达）。** 我尝试用 `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 子进程pid)` 程序化投递 Ctrl+C，API 返回 1 表示调用成功，但子进程 30 秒内没有退出——Windows 的 `CTRL_C_EVENT` 不能定向投递到指定进程组，这是系统限制，不是模拟器的问题。降级为 `CTRL_BREAK_EVENT` 后收尾正常：

| 结论 | 命令 | 实际输出 |
|---|---|---|
| 未验证 | `GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid)` | 返回 `1`，但子进程未退出（30 秒超时）→ 无法证明 SIGINT 路径 |
| （参考） | 降级 `send_signal(CTRL_BREAK_EVENT)` | 退出码 `0`、无 `Traceback`、打印完整统计块（见下） |

降级方式下的统计块（证明收尾逻辑本身是好的）：

```text
==== 模拟器统计 ====
运行时长         : 34.7 s
设备数           : 14
写入行数         : 238
注入事件         : 1 次（进行中 0）
写入失败/重试    : 0 / 0
回填行数         : 0
===================
```

已具备的证据：`data_pipeline/simulator.py:136-139` 把 `SIGINT` 与 `SIGBREAK` 绑到同一个 `_handle_sigint`，所以 Ctrl+Break 跑通的收尾逻辑与 Ctrl+C 是同一段代码，差别只在信号号。但这不等于"真 Ctrl+C 验证过"，所以本条按你的要求写"未验证"。

**手工验证命令（约 15 秒，需要你按一次键盘）**：

```powershell
cd D:\wbproject\2026-11-24-10-02-56
.\.venv\Scripts\Activate.ps1
python -m data_pipeline.simulator
# 等 10 秒左右，按 Ctrl+C
```

期望：打印上面的 `==== 模拟器统计 ====` 统计块、`注入事件 ... （进行中 0）`、进程正常结束、**没有 Traceback**、退出码 0。

## 3. 裁定结果（2026-11-24 已处理）

| 编号 | 性质 | 处理 |
|---|---|---|
| 7.10 | 规格算术错误 | **已升 v1.1**：判定改为 `回填+重复 = 604800` 且 `总数 ∈ [604800, 604900]`，实测 604,828 落入区间，本项改判通过。代码零改动 |
| 7.14 | 验收时序缺陷 | **已升 v1.1**：7.14 补「必须在 7.12 注入后 45 秒内执行」前置说明 + 超时补救动作。代码零改动 |
| 7.15 | 验收方式不可自动化 | **待人工验证**：需作者手工按一次 Ctrl+C；确认后本条由「未验证」改「通过」 |

**代码层面没有发现需要修的问题**：7.10 的数字自洽、7.14 的逻辑正确、7.15 的收尾正常，三者都是文档/流程口径问题。

## 4. 附：最小测试网（第 3 步）

| 项 | 内容 |
|---|---|
| 依赖文件 | `requirements-dev.txt`（`-r requirements.txt` + `pytest==9.2.0` + `httpx==0.28.1`），不污染运行依赖 |
| 用例文件 | `tests/conftest.py`、`tests/test_phase2_api.py`（8 个用例） |
| 运行命令 | `./.venv/Scripts/python.exe -m pytest tests -v` |
| 结果 | **8 passed, 1 warning in 26.70s**（连续两次运行均 8 passed，无 flaky） |

用例覆盖对照：

| # | 用例 | 覆盖点 |
|---|---|---|
| 1 | `test_health_ok_and_json_is_utf8` | 健康检查 + 响应头 `charset=utf-8`（规格 4.0） |
| 2 | `test_device_list_has_14_seeded_devices` | 设备列表 14 台、5 类设备齐全 |
| 3 | `test_invalid_page_size_is_rejected_not_silently_clamped` | 非法 `page_size=500` → 400 `INVALID_PARAM` |
| 4 | `test_time_range_start_after_end_is_rejected` | `start > end` → 400 `INVALID_PARAM` |
| 5 | `test_telemetry_without_range_uses_last_hour_window` | 缺时间范围 → 默认最近 1 小时、`interval_seconds=2` |
| 6 | `test_over_5000_points_is_downsampled` | 造 5100 点 → `downsample_step=2`、`count ≤ 5000`、`truncated=true` |
| 7 | `test_alarm_cooldown_suppresses_duplicate_within_5_minutes` | 冷却窗内重复超限不新增；超出 5 分钟才再写一条 |
| 8 | `test_resolve_alarm_follows_g10_two_branches` | 只解一条 → `ALARM/open=1`；全解 → `RUNNING/open=0` |

两处测试专用设置（不改任何业务代码）：

1. **首扫回看窗**：`tests/conftest.py` 用环境变量 `ALARM_SCAN_INITIAL_LOOKBACK_SECONDS=30` 覆盖默认 600 秒。否则每次 pytest 启动都会重扫最近 10 分钟写入的全部遥测（回填场景下 60 万行），既慢又会把历史异常重判成告警，污染"恰好 N 条"的断言。
2. **数据清理**：2020 年固定区间的用例按 `ts < 2021-01-01` 清理；告警用例按精确时间窗清理，并在结束时把设备状态复位为 `RUNNING`。测试跑完后核对：`ts < 2021-01-01` 的行数为 0、`status <> 'RUNNING'` 的设备数为 0。
