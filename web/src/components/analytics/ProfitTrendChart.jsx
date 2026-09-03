import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from "recharts";

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="recharts-default-tooltip analytics-tooltip">
      <div className="recharts-tooltip-label">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="recharts-tooltip-item">
          {p.name}: <strong className="tooltip-value">P{typeof p.value === "number" ? p.value.toLocaleString() : p.value}</strong>
        </div>
      ))}
    </div>
  );
}

export default function ProfitTrendChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="profit-empty"><p className="muted">No profit data available.</p></div>;
  }

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#10B981" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `P${(v / 1000).toFixed(0)}k`}
            width={48}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar
            dataKey="expenses"
            name="Expenses"
            fill="#EF4444"
            opacity={0.6}
            radius={[2, 2, 0, 0]}
          />
          <Line
            type="monotone"
            dataKey="profit"
            name="Profit"
            stroke="#10B981"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "#10B981" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
