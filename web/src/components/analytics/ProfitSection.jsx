import { TrendingUp, TrendingDown, DollarSign, MinusCircle } from "lucide-react";
import ProfitTrendChart from "./ProfitTrendChart.jsx";
import ExpenseBreakdownChart from "./ExpenseBreakdownChart.jsx";

export default function ProfitSection({ profit }) {
  if (!profit) {
    return (
      <div className="analytics-section">
        <div className="analytics-section-header">
          <h2 className="analytics-section-title">Profit & Expenses</h2>
        </div>
        <p className="muted">No profit data available.</p>
      </div>
    );
  }

  const {
    revenue,
    total_expenses,
    gross_profit,
    margin_pct,
    expenses_by_category,
    daily_profit,
  } = profit;

  const nonZeroCategories = (expenses_by_category ?? []).filter((c) => c.amount > 0);

  return (
    <div className="analytics-section">
      <div className="analytics-section-header">
        <h2 className="analytics-section-title">Profit & Expenses</h2>
        <p className="muted small">Revenue minus recorded expenses for this period</p>
      </div>

      <div className="analytics-kpis">
        <div className="kpi-card">
          <div className="kpi-card-header">
            <span className="kpi-card-label">Revenue</span>
            <div className="kpi-card-icon"><DollarSign size={18} /></div>
          </div>
          <div className="kpi-card-value">P{revenue.toLocaleString()}</div>
          <div className="kpi-card-trend">From {profit.order_count} orders</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-header">
            <span className="kpi-card-label">Total Expenses</span>
            <div className="kpi-card-icon"><MinusCircle size={18} /></div>
          </div>
          <div className="kpi-card-value">P{total_expenses.toLocaleString()}</div>
          <div className="kpi-card-trend">{profit.expense_count} recorded</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-header">
            <span className="kpi-card-label">Gross Profit</span>
            <div className="kpi-card-icon">
              {gross_profit >= 0 ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
            </div>
          </div>
          <div className="kpi-card-value">P{gross_profit.toLocaleString()}</div>
          <div className="kpi-card-trend">
            Revenue - Expenses
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-card-header">
            <span className="kpi-card-label">Profit Margin</span>
            <div className="kpi-card-icon"><TrendingUp size={18} /></div>
          </div>
          <div className="kpi-card-value">{margin_pct.toFixed(1)}%</div>
          <div className={`kpi-card-trend ${margin_pct >= 50 ? "up" : margin_pct < 20 ? "down" : ""}`}>
            {margin_pct >= 50 ? "Healthy margin" : margin_pct < 20 ? "Low margin" : "Moderate margin"}
          </div>
        </div>
      </div>

      <div className="profit-charts-row">
        <div className="profit-chart-half">
          <h3 className="profit-chart-title">Daily Profit Trend</h3>
          <ProfitTrendChart data={daily_profit ?? []} />
        </div>

        <div className="profit-chart-half">
          <h3 className="profit-chart-title">Expense Breakdown</h3>
          {nonZeroCategories.length > 0 ? (
            <ExpenseBreakdownChart data={nonZeroCategories} />
          ) : (
            <div className="profit-empty">
              <p className="muted">No expenses recorded for this period.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
