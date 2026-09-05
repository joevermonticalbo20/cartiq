import { useEffect, useState, useRef, useCallback } from "react";
import {
  Activity,
  AlertCircle,
  Droplet,
  Thermometer,
  Wifi,
  WifiOff,
  TrendingDown,
  TrendingUp,
  Minus,
  Clock,
  Zap,
} from "lucide-react";
import api from "../api.js";
import { clockTicks, timeX, formatTick, formatLastReading } from "./sensorTimeScale.js";

const CHANNELS = [
  { id: "LPG_TANK", label: "LPG Tank", unit: "kg", icon: Zap, color: "var(--accent)", lowThreshold: 5, criticalThreshold: 2 },
  { id: "CHEESE_BIN", label: "Cheese Bin", unit: "kg", icon: Droplet, color: "var(--highlight-strong)", lowThreshold: 2, criticalThreshold: 0.5 },
];

export default function SensorPanel({ code = "CART-01" }) {
  const [series, setSeries] = useState([]);
  const [channel, setChannel] = useState("LPG_TANK");
  const [error, setError] = useState("");
  const [isLive, setIsLive] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);
  const intervalRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const { data } = await api.get(
        `/readings/recent?code=${code}&channel=${channel}&limit=60`
      );
      setSeries(data.readings);
      setError("");
      setLastFetch(new Date());
    } catch (err) {
      setError(err.response?.data?.error || "No readings yet");
      setIsLive(false);
    }
  }, [code, channel]);

  useEffect(() => {
    const timer = setTimeout(fetchData, 0);
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (isLive) {
      intervalRef.current = setInterval(fetchData, 5000);
    }
    return () => {
      clearTimeout(timer);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData, isLive]);

  const channelConfig = CHANNELS.find((c) => c.id === channel);
  const Icon = channelConfig.icon;

  // Stats
  const values = series.map((r) => r.kg);
  const latest = series[series.length - 1];
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const firstVal = values[0] ?? 0;
  const lastVal = values[values.length - 1] ?? 0;
  const delta = lastVal - firstVal;
  const trend = delta > 0.5 ? "up" : delta < -0.5 ? "down" : "stable";

  // Status
  let status = "ok";
  if (lastVal <= channelConfig.criticalThreshold) status = "critical";
  else if (lastVal <= channelConfig.lowThreshold) status = "low";

  // SVG sparkline dimensions
  const W = 600;
  const H = 160;
  const padX = 8;
  const padTop = 16;
  const padBottom = 28;

  // Time scale: x-position is clock time (sorted copy), never sample
  // order, so bursts compress honestly and gaps read as gaps.
  // Readings with unparseable timestamps (e.g. "" from an NTP-unsynced
  // node) are dropped from the chart — one bad ts must never stretch
  // the whole axis back to 1970.
  const ordered = [...series]
    .filter((r) => Number.isFinite(new Date(r.ts).getTime()))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const startMs = ordered.length ? new Date(ordered[0].ts).getTime() : 0;
  const endMs = ordered.length ? new Date(ordered[ordered.length - 1].ts).getTime() : 0;
  const hasSpan = endMs > startMs;
  const xOfTime = (ts) =>
    hasSpan
      ? timeX(new Date(ts).getTime(), startMs, endMs, padX, W)
      : (W - padX * 2) / 2 + padX;
  const pts = (hasSpan ? ordered : series).map((r) => {
    const x = hasSpan
      ? xOfTime(r.ts)
      : (ordered.indexOf(r) / Math.max(ordered.length - 1, 1)) * (W - padX * 2) + padX;
    const y = H - padBottom - ((r.kg - min) / (max - min || 1)) * (H - padTop - padBottom);
    return [x, y, r.ts];
  });

  const pointsStr = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaStr = pts.length
    ? `${padX},${H - padBottom} ${pointsStr} ${W - padX},${H - padBottom}`
    : "";

  // Y-axis labels
  const yLabels = [max, (max + min) / 2, min].map((v) => v.toFixed(1));

  // X-axis: round clock ticks across the true time span — distinct
  // labels by construction, so "12:29 AM" can never repeat.
  const xTicks = hasSpan ? clockTicks(startMs, endMs) : [];

  return (
    <section className="panel sensor-panel">
      <div className="panel-head">
        <h3>
          <Activity size={16} style={{ verticalAlign: "middle", marginRight: 6 }} />
          Live sensor
        </h3>
        <div className="seg">
          {CHANNELS.map((c) => {
            const Ic = c.icon;
            return (
              <button
                key={c.id}
                className={`ghost small-btn ${channel === c.id ? "active" : ""}`}
                onClick={() => setChannel(c.id)}
              >
                <Ic size={13} style={{ marginRight: 4, verticalAlign: "middle" }} />
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {error ? (
        <div className="sensor-error">
          <WifiOff size={32} strokeWidth={1.4} />
          <strong>Sensor offline</strong>
          <p className="muted small">{error}</p>
          <button className="ghost small-btn" onClick={fetchData}>
            Retry
          </button>
        </div>
      ) : series.length === 0 ? (
        <div className="sensor-empty">
          <Icon size={36} strokeWidth={1.4} />
          <strong>Waiting for readings</strong>
          <p className="muted small">Start iot/simulator.mjs to see live data</p>
        </div>
      ) : (
        <>
          {/* Top stats row */}
          <div className="sensor-stats">
            <div className={`sensor-stat sensor-stat-main status-${status}`}>
              <div className="sensor-stat-head">
                <Icon size={18} />
                <span className="muted small">{channelConfig.label}</span>
                {isLive && (
                  <span className="live-dot" title="Live">
                    <span className="live-pulse" />
                    <span className="live-label">LIVE</span>
                  </span>
                )}
              </div>
              <div className="sensor-stat-value">
                <span className="big-num">{lastVal.toFixed(1)}</span>
                <span className="unit">{channelConfig.unit}</span>
              </div>
              <div className="sensor-stat-foot">
                {trend === "up" && (
                  <span className="trend-pill trend-up">
                    <TrendingUp size={12} /> +{delta.toFixed(2)}
                  </span>
                )}
                {trend === "down" && (
                  <span className="trend-pill trend-down">
                    <TrendingDown size={12} /> {delta.toFixed(2)}
                  </span>
                )}
                {trend === "stable" && (
                  <span className="trend-pill trend-stable">
                    <Minus size={12} /> stable
                  </span>
                )}
                <span className="muted small">
                  {status === "critical" && <span className="text-danger">● Critical</span>}
                  {status === "low" && <span className="text-warn">● Low</span>}
                  {status === "ok" && <span className="text-ok">● OK</span>}
                </span>
              </div>
            </div>

            <div className="sensor-stat-grid">
              <div className="sensor-stat-mini">
                <span className="muted small">Min</span>
                <strong>{min.toFixed(2)} <span className="unit-sm">{channelConfig.unit}</span></strong>
              </div>
              <div className="sensor-stat-mini">
                <span className="muted small">Avg</span>
                <strong>{avg.toFixed(2)} <span className="unit-sm">{channelConfig.unit}</span></strong>
              </div>
              <div className="sensor-stat-mini">
                <span className="muted small">Max</span>
                <strong>{max.toFixed(2)} <span className="unit-sm">{channelConfig.unit}</span></strong>
              </div>
              <div className="sensor-stat-mini">
                <span className="muted small">Samples</span>
                <strong>{series.length}</strong>
              </div>
            </div>
          </div>

          {/* Chart */}
          <div className="sensor-chart-wrap">
            <svg viewBox={`0 0 ${W} ${H}`} className="sensor-chart" preserveAspectRatio="none">
              <defs>
                <linearGradient id="sensorGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={channelConfig.color} stopOpacity="0.35" />
                  <stop offset="100%" stopColor={channelConfig.color} stopOpacity="0" />
                </linearGradient>
              </defs>

              {/* Threshold lines */}
              <line
                x1={padX}
                y1={H - padBottom - ((channelConfig.lowThreshold - min) / (max - min || 1)) * (H - padTop - padBottom)}
                x2={W - padX}
                y2={H - padBottom - ((channelConfig.lowThreshold - min) / (max - min || 1)) * (H - padTop - padBottom)}
                stroke="var(--warn)"
                strokeWidth="1"
                strokeDasharray="4 4"
                opacity="0.5"
              />
              <line
                x1={padX}
                y1={H - padBottom - ((channelConfig.criticalThreshold - min) / (max - min || 1)) * (H - padTop - padBottom)}
                x2={W - padX}
                y2={H - padBottom - ((channelConfig.criticalThreshold - min) / (max - min || 1)) * (H - padTop - padBottom)}
                stroke="var(--danger)"
                strokeWidth="1"
                strokeDasharray="4 4"
                opacity="0.5"
              />

              {/* Vertical gridlines at each clock tick */}
              {xTicks.map((ts) => (
                <line
                  key={`grid-${ts}`}
                  x1={xOfTime(ts)}
                  y1={padTop - 6}
                  x2={xOfTime(ts)}
                  y2={H - padBottom}
                  stroke="var(--border)"
                  strokeWidth="1"
                  opacity="0.7"
                />
              ))}

              {/* Area fill */}
              {pts.length > 0 && (
                <polygon fill="url(#sensorGrad)" points={areaStr} />
              )}

              {/* Line */}
              <polyline
                fill="none"
                stroke={channelConfig.color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={pointsStr}
              />

              {/* Latest point dot */}
              {pts.length > 0 && (
                <circle
                  cx={pts[pts.length - 1][0]}
                  cy={pts[pts.length - 1][1]}
                  r="5"
                  fill={channelConfig.color}
                  stroke="var(--surface)"
                  strokeWidth="2"
                >
                  <animate
                    attributeName="r"
                    values="5;7;5"
                    dur="1.5s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}

              {/* Y-axis labels */}
              {yLabels.map((label, i) => {
                const y = H - padBottom - (i / 2) * (H - padTop - padBottom);
                return (
                  <text
                    key={i}
                    x={W - padX - 2}
                    y={y - 2}
                    fontSize="9"
                    fill="var(--text-muted)"
                    textAnchor="end"
                  >
                    {label}
                  </text>
                );
              })}

              {/* X-axis labels */}
              {xTicks.map((ts, i) => {
                const x = xOfTime(ts);
                return (
                  <text
                    key={ts}
                    x={x}
                    y={H - 6}
                    fontSize="9"
                    fill="var(--text-muted)"
                    textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
                  >
                    {formatTick(ts, startMs, endMs)}
                  </text>
                );
              })}
            </svg>
          </div>

          {/* Footer */}
          <div className="sensor-footer">
            <span className="muted small">
              <Clock size={11} style={{ verticalAlign: "middle", marginRight: 3 }} />
              Last reading: {latest ? formatLastReading(latest.ts) : "—"}
            </span>
            <button
              className="ghost small-btn"
              onClick={() => setIsLive(!isLive)}
              title={isLive ? "Pause auto-refresh" : "Resume auto-refresh"}
            >
              {isLive ? <Wifi size={12} /> : <WifiOff size={12} />}
              {isLive ? "Live" : "Paused"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
