import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Legend,
} from "recharts";
import { fmtMoneyAxis, fmtMoney } from "../../utils/format.js";
import AnalyticsTooltip, { TooltipItem } from "./AnalyticsTooltip.jsx";
import EmptyState from "../EmptyState.jsx";
import { TrendingUp } from "lucide-react";

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const byName = Object.fromEntries(payload.map((p) => [p.name, p.value]));
  const revenue =
    typeof byName.Revenue === "number"
      ? byName.Revenue
      : (Number(byName.Profit) || 0) + (Number(byName.Expenses) || 0);
  return (
    <AnalyticsTooltip label={label}>
      {payload.map((p, i) => (
        <TooltipItem key={i}>
          {p.name}: <strong className="tooltip-value">{fmtMoney(p.value)}</strong>
        </TooltipItem>
      ))}
      <TooltipItem muted>
        Revenue − Expenses = Profit · {fmtMoney(revenue)}
      </TooltipItem>
    </AnalyticsTooltip>
  );
}

export default function ProfitTrendChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No profit data available"
        subtitle="Daily profit appears here once sales are recorded."
        compact
      />
    );
  }

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--primary)" stopOpacity={0.02} />
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
            tickFormatter={fmtMoneyAxis}
            width={52}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            iconSize={10}
            wrapperStyle={{ fontSize: 12 }}
          />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          <Bar
            dataKey="expenses"
            name="Expenses"
            fill="var(--accent)"
            opacity={0.55}
            radius={[2, 2, 0, 0]}
          />
          <Line
            type="monotone"
            dataKey="profit"
            name="Profit"
            stroke="var(--primary)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "var(--primary)" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
