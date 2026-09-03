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

  const pieData = data.map((d) => ({
    name: d.category,
    value: d.amount,
    pct: d.pct,
  }));

  return (
    <div className="expense-charts">
      <div className="expense-donut">
        <ResponsiveContainer width="100%" height={140}>
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={65}
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
