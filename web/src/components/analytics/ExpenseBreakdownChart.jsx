import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
} from "recharts";
import { expenseCategoryColor } from "../../constants/expenseCategories.js";

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="recharts-default-tooltip analytics-tooltip">
      <div className="recharts-tooltip-label">{p.name}</div>
      <div className="recharts-tooltip-item">
        Amount: <strong className="tooltip-value">P{Number(p.value).toLocaleString()}</strong>
      </div>
      {p.payload?.pct != null && (
        <div className="recharts-tooltip-item">
          Share: <strong className="tooltip-value">{p.payload.pct}%</strong>
        </div>
      )}
    </div>
  );
}

export default function ExpenseBreakdownChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="profit-empty"><p className="muted">No expense data.</p></div>;
  }

  const total = data.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  // Sort biggest-first and fold slivers (<2%) into Other so the donut stays
  // readable instead of growing hairline slices.
  const sorted = [...data].sort(
    (a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)
  );
  const main = [];
  let other = 0;
  for (const d of sorted) {
    const pct = total > 0 ? ((Number(d.amount) || 0) / total) * 100 : 0;
    if (pct < 2) {
      other += Number(d.amount) || 0;
    } else {
      main.push({ name: d.category, value: Number(d.amount) || 0, pct });
    }
  }
  if (other > 0) {
    main.push({
      name: "Other",
      value: other,
      pct: total > 0 ? (other / total) * 100 : 0,
    });
  }
  const pieData = main.map((d) => ({
    ...d,
    pct: typeof d.pct === "number" ? d.pct.toFixed(1) : d.pct,
  }));

  return (
    <div className="expense-charts">
      <div className="expense-donut">
        <ResponsiveContainer width="100%" height={190}>
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
              nameKey="name"
            >
              {pieData.map((entry, idx) => (
                <Cell
                  key={`cell-${idx}`}
                  fill={expenseCategoryColor(entry.name)}
                />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
            <text
              x="50%"
              y="46%"
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--text-muted)"
              fontSize={11}
              fontWeight={600}
            >
              TOTAL
            </text>
            <text
              x="50%"
              y="56%"
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--text)"
              fontSize={18}
              fontWeight={800}
            >
              P{total.toLocaleString()}
            </text>
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="expense-list">
        {pieData.map((d) => (
          <div key={d.name} className="expense-list-item">
            <div className="expense-list-label">
              <span
                className="expense-dot"
                style={{ backgroundColor: expenseCategoryColor(d.name) }}
              />
              <span>{d.name}</span>
            </div>
            <div className="expense-list-bar" aria-hidden="true">
              <span
                style={{
                  width: `${Math.min(100, Number(d.pct) || 0)}%`,
                  backgroundColor: expenseCategoryColor(d.name),
                }}
              />
            </div>
            <div className="expense-list-value">
              <strong>P{Number(d.value).toLocaleString()}</strong>
              <span className="muted small"> · {d.pct}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
