import { useEffect, useState } from "react";
import { Trophy, Users } from "lucide-react";
import api from "../api.js";
import Badge from "../components/Badge.jsx";
import { usePagedData } from "../hooks/usePagedData.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import Skeleton from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";

export default function StaffPage() {
  const [onShift, setOnShift] = useState([]);
  const [recent, setRecent] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loc, setLoc] = useState("");
  const [performance, setPerformance] = useState(null);
  const [perfLoading, setPerfLoading] = useState(true);

  useEffect(() => {
    api.get("/staff/on-shift").then(({ data }) => {
      setOnShift(data.on_shift);
      setRecent(data.recent_today);
    }).catch(() => {});
    api.get("/catalog").then(({ data }) => setLocations(data.locations)).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPerfLoading(true);
      api.get("/analytics/staff-performance?days=28")
        .then(({ data }) => setPerformance(data))
        .catch(() => setPerformance({ staff: [] }))
        .finally(() => setPerfLoading(false));
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const { rows, meta, loading, error, page, gotoPage } = usePagedData(
    (p) => `/shifts/history?page=${p}&pageSize=10` + (loc ? `&code=${loc}` : ""),
    [loc]
  );

  return (
    <PageErrorBoundary>
    <div className="page-container">
      <PageHeader
        eyebrow="Operations"
        title="Staff & Shifts"
        sub="Who tapped in, who sold what, and the full tap log."
      />
      <section className="panel">
        <div className="panel-head">
          <h3>Currently on shift (RFID)</h3>
          <Badge variant="brand">{onShift.length} on duty</Badge>
        </div>
        {onShift.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody tapped IN"
            subtitle="Shift events appear when staff tap RFID cards at a cart node."
            compact
          />
        ) : (
          <div className="flex flex-wrap gap-3">
            {onShift.map((s) => (
              <div key={`${s.name}-${s.location_code}`} className="staff-chip">
                <span className="staff-avatar">{s.name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("")}</span>
                <div>
                  <div className="fw-semibold">{s.name}</div>
                  <div className="muted text-xs">{s.location_name}</div>
                </div>
                <Badge variant={s.registered ? "ok" : "danger"}>
                  {s.registered ? "ON" : "UNREG"}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel" >
        <div className="panel-head">
          <h3 className="section-title flex items-center gap-2">
            <Trophy size={16} />
            Staff performance (last 28 days)
          </h3>
          <span className="muted small">
            {performance?.staff?.length ?? 0} staff tracked
          </span>
        </div>
        {perfLoading ? (
          <Skeleton rows={4} />
        ) : !performance?.staff?.length ? (
          <div className="empty-state">
            <strong>No performance data yet</strong>
            Staff performance is calculated from completed sales and shift events.
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {performance.staff.map((s, i) => (
              <div key={s.staff_id} className="card staff-perf-card">
                <div className="flex items-center justify-between gap-2">
                  <strong>{s.name}</strong>
                  {i === 0 && <Badge variant="brand" title="Top performer"><Trophy size={11} /></Badge>}
                </div>
                <div className="muted text-xs" style={{ marginTop: "var(--space-1)" }}>
                  {s.orders} order{s.orders !== 1 ? "s" : ""} · avg P{s.avg_ticket}
                </div>
                <div className="fw-semibold" style={{ fontSize: "var(--fs-md)", marginTop: "var(--space-1)" }}>
                  P{Number(s.total_sales).toLocaleString()}
                </div>
                {s.shifts_completed > 0 && (
                  <div className="muted text-xs" style={{ marginTop: "var(--space-1)" }}>
                    {s.shifts_completed} shift{s.shifts_completed !== 1 ? "s" : ""} completed
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel" >
        <div className="panel-head">
          <h3>Shift event history</h3>
          <select className="cart-select" value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">All carts</option>
            {locations.map((l) => (
              <option key={l.id} value={l.code}>{l.code}</option>
            ))}
          </select>
        </div>

        {error ? (
          <div className="error-box">{error}</div>
        ) : !loading && (!rows || rows.length === 0) ? (
          <EmptyState
            icon={Users}
            title="No shift events found"
            subtitle="Tap an RFID card at a cart node and the IN/OUT event will appear here."
          />
        ) : (
          <DataTable
            loading={loading}
            emptyMessage="No shift events found"
            columns={[
              {
                key: "ts",
                label: "Date & time",
                render: (s) =>
                  new Date(s.ts).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
              },
              {
                key: "staffName",
                label: "Staff",
                render: (s) =>
                  s.staffName ?? (
                    <Badge variant="danger">UNREGISTERED</Badge>
                  ),
              },
              {
                key: "staffUid",
                label: "RFID UID",
                render: (s) => <span className="muted small">{s.staffUid}</span>,
              },
              {
                key: "event",
                label: "Event",
                render: (s) => (
                  <Badge variant={s.event === "IN" ? "ok" : "neutral"}>
                    {s.event}
                  </Badge>
                ),
              },
              {
                key: "location",
                label: "Cart",
                render: (s) => <Badge variant="info">{s.location?.code}</Badge>,
              },
            ]}
            data={rows}
            pagination={meta ? { ...meta, onPageChange: gotoPage } : null}
          />
        )}
      </section>
    </div>
    </PageErrorBoundary>
  );
}
