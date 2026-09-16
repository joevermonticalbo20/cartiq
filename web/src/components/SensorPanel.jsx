import { useState, useEffect, useRef } from "react";
import { Flame, Activity } from "lucide-react";
import { ResponsiveContainer, AreaChart, Area, YAxis } from "recharts";
import api from "../api.js";
import { useToast } from "./Toast.jsx";

export default function SensorPanel({ code = "CART-01" }) {
  const [lpg, setLpg] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const errorShownRef = useRef(false);

  // Fetch history para sa Sparkline Chart. API contract:
  // GET /readings/recent?code=&channel=&limit= -> { readings: [{kg, ts, ...}] }.
  // LPG-only panel (cheese channel removed by design).
  useEffect(() => {
    let alive = true;
    let timer = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch hydrates loading state
    setLoading(true);

    async function fetchData() {
      try {
        const { data } = await api.get(
          `/readings/recent?code=${encodeURIComponent(code)}&channel=LPG_TANK&limit=60`
        );
        if (!alive) return;
        const readings = data?.readings ?? [];

        // Paggawa ng graph points mula sa API data
        setHistory(readings.map((r, i) => ({ time: i, value: r.kg })));

        if (readings.length > 0) {
          setLpg(readings[readings.length - 1].kg);
        } else {
          setLpg(null); // Walang data
        }
        errorShownRef.current = false;
        setLoading(false);
      } catch (err) {
        if (!alive) return;
        setLoading(false);
        // Toast once per outage, not on every 15s poll.
        if (!errorShownRef.current) {
          errorShownRef.current = true;
          toast("Sensor offline - showing last known level", "error");
        }
      }
    }

    fetchData();
    // Live polling: the server emits no per-reading SSE events, so poll.
    timer = setInterval(fetchData, 15000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [code, toast]);

  // UI Status Handling (kg bands matching the LPG Tank inventory thresholds)
  const isCritical = lpg !== null && lpg < 2;
  const isLow = lpg !== null && lpg >= 2 && lpg < 5;

  const lpgStatusClass = isCritical ? "status-critical" : isLow ? "status-low" : "";
  const textStatusClass = isCritical ? "text-danger" : isLow ? "text-warn" : "text-ok";
  const statusLabel = isCritical ? "CRITICAL" : isLow ? "LOW" : "STABLE";

  return (
    <section className="panel sensor-panel" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header with Live Dot */}
      <div className="panel-head" style={{ marginBottom: "16px" }}>
        <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
          Live Sensor
        </h3>
        <div className="live-dot">
          <div className="live-pulse" />
          <span className="live-label">LIVE</span>
        </div>
      </div>

      {loading ? (
        <div className="muted small flex justify-center items-center" style={{ flex: 1 }}>
          Connecting to sensor...
        </div>
      ) : (
        <>
          <div className="sensor-stats" style={{ display: 'flex', flex: 1, marginBottom: 0 }}>
            {/* MAIN STAT: LPG Level Only (Spans the whole width now) */}
            <div className={`sensor-stat ${lpgStatusClass}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div className="sensor-stat-head">
                <Flame size={14} className="muted" />
                <span className="muted small font-bold">LPG Tank Level</span>
              </div>
              <div className="sensor-stat-value">
                <span className="big-num">{lpg !== null ? lpg.toFixed(1) : "--"}</span>
                <span className="unit">kg</span>
              </div>
              <div className="sensor-stat-foot">
                {lpg !== null && <span className={textStatusClass}>{statusLabel}</span>}
              </div>
            </div>
          </div>

          {/* SPARKLINE CHART */}
          <div className="sensor-chart-wrap mt-3" style={{ flex: 1, minHeight: '120px', display: 'flex', flexDirection: 'column' }}>
            <span className="muted small flex items-center gap-1 mb-2">
              <Activity size={12} /> Consumption Trend
            </span>
            <div className="sensor-chart" style={{ flex: 1, height: 'auto' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history.length > 0 ? history : [{ time: 0, value: 0 }]}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  {/* Nakatago ang YAxis para malinis ang sparkline style */}
                  <YAxis domain={['dataMin - 5', 'dataMax + 5']} hide />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorValue)"
                    isAnimationActive={false} // Disable animation to prevent glitching upon real-time update
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          
          {/* FOOTER */}
          <div className="sensor-footer mt-3">
             <span className="muted small font-mono">ID: ESP32-{code?.split("-")[1] || "01"}</span>
             <span className="muted small">Real-time IoT Sync</span>
          </div>
        </>
      )}
    </section>
  );
}