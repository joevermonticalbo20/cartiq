import ProfitTrendChart from "./ProfitTrendChart.jsx";
import ExpenseBreakdownChart from "./ExpenseBreakdownChart.jsx";
import EmptyState from "../EmptyState.jsx";
import Badge from "../Badge.jsx";
import { Wallet } from "lucide-react";

export default function ProfitSection({ profit }) {
  if (!profit) {
    return (
      <div className="analytics-section" id="section-profit">
        <div className="analytics-section-header">
          <div>
            <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">7</span> Profit & Expenses</h2>
            <p className="analytics-section-sub">What you keep after recorded expenses</p>
          </div>
        </div>
        <EmptyState
          icon={Wallet}
          title="No profit data available"
          subtitle="Record sales and expenses to see profit here."
        />
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

  const marginLabel =
    margin_pct >= 50 ? "Healthy margin" : margin_pct < 20 ? "Low margin" : "Watch margin";
  const marginChip = margin_pct >= 50 ? "ok" : margin_pct < 20 ? "danger" : "warn";

  const burnPct = revenue > 0 ? (total_expenses / revenue) * 100 : 0;
  const topCost = [...(expenses_by_category ?? [])]
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount)[0];

  return (
    <div className="analytics-section" id="section-profit">
      <div className="analytics-section-header">
        <div>
          <h2 className="analytics-section-title"><span className="section-num" aria-hidden="true">7</span> Profit & Expenses</h2>
          <p className="analytics-section-sub">What you keep after recorded expenses</p>
        </div>
      </div>

      <div className="profit-strip" aria-label="Profit summary">
        <span><span className="muted">Revenue</span> <strong>P{revenue.toLocaleString()}</strong></span>
        <span><span className="muted">− Expenses</span> <strong>P{total_expenses.toLocaleString()}</strong></span>
        <span><span className="muted">= Profit</span> <strong>P{gross_profit.toLocaleString()}</strong></span>
        <span>
          <span className="muted">Margin</span> <strong>{margin_pct.toFixed(1)}%</strong>{" "}
          <Badge variant={marginChip}>{marginLabel}</Badge>
          <span className="muted small"> · {profit.order_count} orders · {profit.expense_count} expenses</span>
        </span>
      </div>

      <div className="profit-strip" aria-label="Cost burn">
        {burnPct === 0 ? (
          <span className="muted">
            No expenses recorded yet.
          </span>
        ) : (
          <span>
            <strong>Cost Breakdown:</strong> For every ₱1 you make, <strong>{Math.round(burnPct)}¢</strong> goes to expenses.
            {topCost && <span className="muted small"> (Biggest cost: {topCost.category})</span>}
          </span>
        )}
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
            <div className="expense-empty-state">
              <EmptyState
                icon={Wallet}
                title="No expenses recorded"
                subtitle="Snap a vendor receipt from the POS app to see the breakdown."
                compact
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
