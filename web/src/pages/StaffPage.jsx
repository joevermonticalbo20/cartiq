import { useEffect, useState, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { Trophy, Users, RefreshCw, X } from "lucide-react";
import api from "../api.js";
import Badge from "../components/Badge.jsx";
import { usePagedData } from "../hooks/usePagedData.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import Skeleton from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import Select from "../components/Select.jsx";

export default function StaffPage() {
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  const [onShift, setOnShift] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loc, setLoc] = useState("");
  const [performance, setPerformance] = useState(null);
  const [perfLoading, setPerfLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  const { rows, meta, loading: tableLoading, error, gotoPage, refresh: refreshTable } = usePagedData(
    (p) => `/shifts/history?page=${p}&pageSize=10` + (loc ? `&code=${loc}` : ""),
    [loc]
  );

  // Pinagsama natin sa isang function ang pag-fetch ng top data para iisang Refresh button lang
  const fetchTopData = useCallback(() => {
    setPerfLoading(true);
    Promise.all([
      api.get("/staff/on-shift").catch(() => ({ data: { on_shift: [] } })),
      // Leaderboard is owner-only server-side: don't request it as staff.
      isOwner
        ? api.get("/analytics/staff-performance?days=28").catch(() => ({ data: { staff: [] } }))
        : Promise.resolve({ data: { staff: [] } }),
      api.get("/catalog").catch(() => ({ data: { locations: [] } }))
    ]).then(([shiftRes, perfRes, catRes]) => {
      setOnShift(shiftRes.data.on_shift || []);
      setPerformance(perfRes.data || { staff: [] });
      if (catRes.data.locations) {
        setLocations(catRes.data.locations);
      }
      setPerfLoading(false);
      setLastUpdated(new Date());
    });
  }, [isOwner]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial mount fetch via stable callback
    fetchTopData();
  }, [fetchTopData]);

  // I-update ang time kapag natapos na ang table mag-load automatically
  useEffect(() => {
    if (!tableLoading && !perfLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional clock sync when loading flips
      setLastUpdated(new Date());
    }
  }, [tableLoading, perfLoading]);

  function handleRefreshAll() {
    fetchTopData();
    refreshTable();
  }

  const locationOptions = [
    { value: "", label: "All carts" },
    ...locations.map((l) => ({ value: l.code, label: l.code }))
  ];

  const isLoading = tableLoading || perfLoading;

  return (
    <PageErrorBoundary>
      <div className="page-container wide staff-page">
        <PageHeader
          eyebrow="Operations"
          title="Staff & Shifts"
          sub="Who tapped in, who sold what, and the full tap log."
          actions={
            <>
              <span className="muted small" style={{ marginRight: "4px" }}>
                Last updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "just now"}
              </span>
              <button
                className="ghost small-btn"
                onClick={handleRefreshAll}
                disabled={isLoading}
                title="Refresh staff data"
              >
                <RefreshCw size={14} className={isLoading ? "spin" : ""} /> Refresh
              </button>
            </>
          }
        />

        <div className="dashboard-top-row" style={{ gridTemplateColumns: "1fr 2fr", marginBottom: "var(--space-5)" }}>
          {/* SECTION 1: Currently On Shift */}
          <section className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="panel-head">
              <h3>Currently on shift</h3>
              <Badge variant="brand">{onShift.length} on duty</Badge>
            </div>
            {perfLoading ? (
              <Skeleton rows={3} height={36} />
            ) : onShift.length === 0 ? (
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
                    <span className="staff-avatar">
                      {s.name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("")}
                    </span>
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

          {/* SECTION 2: Staff Performance (owner-only data) */}
          {isOwner && (
          <section className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="panel-head">
              <h3 className="section-title flex items-center gap-2" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
                <Trophy size={16} />
                Staff performance (last 28 days)
              </h3>
              <span className="muted small">
                {performance?.staff?.length ?? 0} staff tracked
              </span>
            </div>
            {perfLoading ? (
              <div style={{ display: 'flex', gap: '14px' }}>
                <div style={{ flex: 1 }}><Skeleton rows={4} /></div>
                <div style={{ flex: 1 }}><Skeleton rows={4} /></div>
              </div>
            ) : !performance?.staff?.length ? (
              <EmptyState
                icon={Trophy}
                title="No performance data yet"
                subtitle="Staff performance is calculated from completed sales and shift events."
                compact
              />
            ) : (
              <div className="flex flex-wrap gap-4">
                {performance.staff.map((s, i) => (
                  <div key={s.staff_id} className="staff-perf-card">
                    <div className="flex items-center justify-between gap-2">
                      <strong>{s.name}</strong>
                      {i === 0 && <Badge variant="brand" title="Top performer"><Trophy size={11} /></Badge>}
                    </div>
                    <div className="muted text-xs" style={{ marginTop: "var(--space-1)" }}>
                      {s.orders} order{s.orders !== 1 ? "s" : ""} - avg P{s.avg_ticket}
                    </div>
                    <div className="fw-semibold" style={{ fontSize: "var(--fs-xl)", marginTop: "var(--space-2)" }}>
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
          )}
        </div>

        {/* SECTION 3: Shift Event History (Long Panel) */}
        <section className="panel staff-panel">
          <div className="staff-filters-row">
            <h3 className="section-title" style={{ borderBottom: "none", padding: 0, margin: 0 }}>
              Shift event history
            </h3>
            <div className="flex items-center gap-2">
              <Select 
                value={loc} 
                onChange={(val) => setLoc(val)} 
                options={locationOptions} 
                placeholder="Select a cart..."
              />
              {loc && (
                <button
                  className="danger-ghost small-btn"
                  onClick={() => setLoc("")}
                >
                  <X size={14} /> Clear filter
                </button>
              )}
            </div>
          </div>

          {error ? (
            <div className="error-box">{error}</div>
          ) : !tableLoading && (!rows || rows.length === 0) ? (
            <EmptyState
              icon={Users}
              title="No shift events found"
              subtitle={
                loc 
                ? "Try clearing the filter to see events from other carts." 
                : "Tap an RFID card at a cart node and the IN/OUT event will appear here."
              }
            />
          ) : (
            <DataTable
              loading={tableLoading}
              fixedLayout={true}
              emptyMessage="No shift events found"
              columns={[
                {
                  key: "ts",
                  label: "Date & time",
                  width: 160,
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
                    s.staffName ? <strong>{s.staffName}</strong> : (
                      <Badge variant="danger">UNREGISTERED</Badge>
                    ),
                },
                {
                  key: "staffUid",
                  label: "RFID UID",
                  width: 150,
                  render: (s) => <span className="muted small">{s.staffUid}</span>,
                },
                {
                  key: "event",
                  label: "Event",
                  width: 100,
                  render: (s) => (
                    <Badge variant={s.event === "IN" ? "ok" : "neutral"}>
                      {s.event}
                    </Badge>
                  ),
                },
                {
                  key: "location",
                  label: "Cart",
                  width: 150,
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