import { useEffect, useState, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { Trophy, Users, RefreshCw, X, Plus, Edit2, Trash2, Clock, Calendar } from "lucide-react";
import api, { getErrorMessage } from "../api.js";
import Badge from "../components/Badge.jsx";
import { usePagedData } from "../hooks/usePagedData.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import Skeleton from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import Select from "../components/Select.jsx";
import { useToast } from "../components/Toast.jsx";

// Helper para ma-format ang Date object sa "YYYY-MM-DDThh:mm" (local time) para sa datetime-local input
function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date - tzOffset).toISOString().slice(0, 16);
}

// Helper para sa initials sa Avatar
function initials(name) {
  if (!name) return "?";
  return name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

export default function StaffPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  
  const [onShift, setOnShift] = useState([]);
  const [locations, setLocations] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [loc, setLoc] = useState("");
  const [performance, setPerformance] = useState(null);
  const [perfLoading, setPerfLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  // --- NEW STATES FOR MANUAL ENTRY & EDIT ---
  const [addOpen, setAddOpen] = useState(false);
  const [addClosing, setAddClosing] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [newShift, setNewShift] = useState({
    staffId: "",
    locationCode: "",
    event: "IN",
    ts: toLocalISOString(new Date())
  });
  const [tsTouched, setTsTouched] = useState(false);

  const [editing, setEditing] = useState(null);
  const [editClosing, setEditClosing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState("");

  const [deleting, setDeleting] = useState(null);

  const { rows, meta, loading: tableLoading, error, gotoPage, refresh: refreshTable } = usePagedData(
    (p) => `/shifts/history?page=${p}&pageSize=10` + (loc ? `&code=${loc}` : ""),
    [loc]
  );

  const fetchTopData = useCallback(() => {
    setPerfLoading(true);
    Promise.all([
      api.get("/staff/on-shift").catch(() => ({ data: { on_shift: [] } })),
      isOwner
        ? api.get("/analytics/staff-performance?days=28").catch(() => ({ data: { staff: [] } }))
        : Promise.resolve({ data: { staff: [] } }),
      api.get("/catalog").catch(() => ({ data: { locations: [] } })),
      isOwner
        ? api.get("/auth/staff").catch(() => ({ data: { data: [] } }))
        : Promise.resolve({ data: { data: [] } })
    ]).then(([shiftRes, perfRes, catRes, staffRes]) => {
      setOnShift(shiftRes.data?.on_shift ?? []);
      setPerformance(perfRes.data ?? { staff: [] });
      setLocations(catRes.data?.locations ?? []);
      if (staffRes?.data?.data) {
        setStaffList(staffRes.data.data.filter((s) => s.role !== "OWNER"));
      }
      setPerfLoading(false);
      setLastUpdated(new Date());
    });
  }, [isOwner]);

  useEffect(() => {
    fetchTopData();
  }, [fetchTopData]);

  useEffect(() => {
    if (tableLoading || perfLoading) return;
    setLastUpdated(new Date());
  }, [tableLoading, perfLoading]);

  useEffect(() => {
    if (!addOpen || tsTouched) return undefined;
    const timer = setInterval(() => {
      setNewShift((prev) => ({ ...prev, ts: toLocalISOString(new Date()) }));
    }, 1000);
    return () => clearInterval(timer);
  }, [addOpen, tsTouched]);

  function handleRefreshAll() {
    fetchTopData();
    refreshTable();
  }

  const isAnyModalOpen = addOpen || addClosing || editing || editClosing || Boolean(deleting);
  useEffect(() => {
    if (isAnyModalOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [isAnyModalOpen]);

  function closeAddModal() {
    setAddClosing(true);
    setTimeout(() => { setAddOpen(false); setAddClosing(false); }, 150);
  }

  function closeEditModal() {
    setEditClosing(true);
    setTimeout(() => { setEditing(null); setEditClosing(false); }, 150);
  }

  async function handleAddShift(e) {
    e.preventDefault();
    setAddError("");
    
    if (!newShift.staffId) {
      setAddError("Select a staff member.");
      return;
    }
    const at = newShift.ts ? new Date(newShift.ts) : null;
    if (!at || !Number.isFinite(at.getTime())) {
      setAddError("Enter a valid date and time.");
      return;
    }
    
    setIsAdding(true);
    try {
      await api.post("/shifts/manual", {
        staffId: Number(newShift.staffId),
        locationCode: newShift.locationCode,
        event: newShift.event,
        ts: at.toISOString()
      });
      toast(`Manual shift entry saved`, "success");
      closeAddModal();
      setNewShift({
        staffId: "",
        locationCode: locations[0]?.code || "",
        event: "IN",
        ts: toLocalISOString(new Date())
      });
      setTsTouched(false);
      handleRefreshAll();
    } catch (err) {
      setAddError(getErrorMessage(err, "Failed to log manual shift."));
    } finally {
      setIsAdding(false);
    }
  }

  async function handleEditShift(e) {
    e.preventDefault();
    setEditError("");

    const at = editing?.ts ? new Date(editing.ts) : null;
    if (!at || !Number.isFinite(at.getTime())) {
      setEditError("Enter a valid date and time.");
      return;
    }

    setIsEditing(true);
    try {
      await api.patch(`/shifts/${editing.id}`, {
        locationCode: editing.locationCode,
        event: editing.event,
        ts: at.toISOString()
      });
      toast(`Shift log updated successfully`, "success");
      closeEditModal();
      handleRefreshAll();
    } catch (err) {
      setEditError(getErrorMessage(err, "Failed to update shift log."));
    } finally {
      setIsEditing(false);
    }
  }

  async function handleDeleteShift() {
    if (!deleting) return;
    try {
      await api.del(`/shifts/${deleting.id}`);
      toast("Shift log deleted successfully", "success");
      handleRefreshAll();
    } catch (err) {
      toast(getErrorMessage(err, "Failed to delete shift log"), "error");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <PageErrorBoundary>
      {/* INO-MODIFIED: Added staff-page-layout class for CSS scoping */}
      <div className="page-container wide staff-page-layout">
        <PageHeader
          eyebrow="Operations"
          title="Staff Activity"
          sub="Track shifts, monitor top performers, and manage manual logs."
          actions={
            <div className="flex items-center gap-3 flex-wrap">
              <span className="muted small" style={{ marginLeft: "4px" }}>
                Last updated {lastUpdated?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "just now"}
              </span>
              <button
                className="ghost small-btn"
                onClick={handleRefreshAll}
                disabled={tableLoading || perfLoading}
                title="Refresh data"
              >
                <RefreshCw size={14} className={tableLoading || perfLoading ? "spin" : ""} /> Refresh
              </button>
              {isOwner && (
                <button
                  className="small-btn"
                  onClick={() => {
                    setAddError("");
                    setNewShift({
                      staffId: "",
                      locationCode: locations[0]?.code || "",
                      event: "IN",
                      ts: toLocalISOString(new Date())
                    });
                    setTsTouched(false);
                    setAddOpen(true);
                  }}
                  title="Manually log a shift"
                >
                  <Plus size={14} /> Manual Log
                </button>
              )}
            </div>
          }
        />

        {/* 1. CURRENTLY ON SHIFT */}
        <section className="panel staff-panel">
          <div className="flex items-center justify-between" style={{ marginBottom: "var(--space-4)" }}>
            <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>Currently on shift</h3>
            <Badge variant={onShift.length > 0 ? "ok" : "neutral"}>{onShift.length} Active</Badge>
          </div>
          {perfLoading ? (
            <Skeleton rows={3} />
          ) : onShift.length === 0 ? (
            <EmptyState 
              icon={Clock} 
              title="There are no active shifts at the moment." 
              subtitle="When your staff taps in, their active sessions will be displayed here." 
            />
          ) : (
            <div className="flex flex-wrap gap-3">
              {onShift.map((s) => (
                <div key={`${s.name}-${s.location_code}`} className="staff-chip">
                  <span className="staff-avatar">{initials(s.name)}</span>
                  <div className="flex flex-col">
                    <strong>{s.name}</strong>
                    <span className="muted small">
                      {s.location_name} - {new Date(s.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 2. TOP PERFORMERS */}
        <section className="panel staff-panel">
          <div className="flex items-center gap-2" style={{ marginBottom: "var(--space-4)" }}>
            <h3 className="section-title m-0 p-0 flex items-center gap-2" style={{ borderBottom: "none" }}>
              <Trophy size={20} color="var(--primary)" /> Top Performers
            </h3>
            <span className="muted small">(Last 28 Days)</span>
          </div>
          {perfLoading ? (
            <Skeleton rows={3} />
          ) : !performance || performance.staff.length === 0 ? (
            <EmptyState 
              icon={Trophy} 
              title="No performance data is currently available." 
              subtitle="Top performers will be ranked here once enough sales and orders are recorded." 
            />
          ) : (
            <div className="table-wrap">
              <table className="data table-fixed">
                <thead>
                  <tr>
                    <th style={{ width: 80 }}>Rank</th>
                    <th>Staff Name</th>
                    <th className="t-right">Sales</th>
                    <th className="t-right">Orders</th>
                    <th className="t-right">Avg Ticket</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.staff.map((s, idx) => (
                    <tr key={s.name}>
                      <td>
                        <Badge variant={idx === 0 ? "danger" : idx === 1 ? "warn" : "neutral"}>
                          #{idx + 1}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span className="staff-avatar" style={{ width: 24, height: 24, fontSize: 10 }}>
                            {initials(s.name)}
                          </span>
                          <strong>{s.name}</strong>
                        </div>
                      </td>
                      <td className="t-right"><strong>P{Number(s.total_sales).toLocaleString()}</strong></td>
                      <td className="t-right">{s.orders}</td>
                      <td className="t-right muted">P{Math.round(s.total_sales / (s.orders || 1))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 3. SHIFT HISTORY */}
        <section className="panel staff-panel">
          <div className="flex items-center justify-between flex-wrap gap-3" style={{ marginBottom: "var(--space-4)" }}>
            <h3 className="section-title m-0 p-0 flex items-center gap-2" style={{ borderBottom: "none" }}>
              <Calendar size={20} className="muted" /> Shift History
            </h3>
            <Select
              value={loc}
              onChange={(val) => setLoc(val)}
              options={[
                { value: "", label: "All carts" },
                ...locations.map((l) => ({ value: l.code, label: l.code }))
              ]}
              placeholder="All carts"
            />
          </div>

          {tableLoading ? (
            <div className="table-wrap" style={{ padding: "var(--space-5)" }}>
              <Skeleton rows={5} />
            </div>
          ) : error ? (
            <div className="error-box">{error}</div>
          ) : (!rows || rows.length === 0) ? (
            <EmptyState 
              icon={Calendar} 
              title="We couldn't find any shift history for your current selection." 
              subtitle="Try adjusting your cart filters, or wait for your staff to complete their shifts." 
            />
          ) : (
            <DataTable
              loading={tableLoading}
              fixedLayout={true}
              emptyMessage="No shift history found."
              columns={[
                {
                  key: "time",
                  label: "Time",
                  width: 150,
                  render: (s) => (
                    <span className="muted">
                      {new Date(s.timestamp).toLocaleString([], {
                        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                      })}
                    </span>
                  ),
                },
                {
                  key: "staff",
                  label: "Staff",
                  render: (s) => (
                    <div className="flex items-center gap-2">
                      <span className="staff-avatar" style={{ width: 24, height: 24, fontSize: 10 }}>
                        {initials(s.staff?.name)}
                      </span>
                      <strong>{s.staff?.name ?? "Unknown"}</strong>
                    </div>
                  ),
                },
                {
                  key: "cart",
                  label: "Cart",
                  width: 120,
                  render: (s) => <Badge variant="info">{s.location?.code}</Badge>,
                },
                {
                  key: "event",
                  label: "Event",
                  width: 100,
                  render: (s) => (
                    <Badge variant={s.event === "IN" ? "ok" : "warn"}>
                      {s.event}
                    </Badge>
                  ),
                },
                {
                  key: "source",
                  label: "Source",
                  width: 100,
                  render: (s) => (
                    <Badge variant={s.source === "MANUAL" ? "danger" : "neutral"}>
                      {s.source}
                    </Badge>
                  ),
                },
                ...(isOwner
                  ? [
                      {
                        key: "actions",
                        label: "",
                        width: 80,
                        align: "right",
                        render: (s) => (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              className="ghost small-btn"
                              onClick={() => {
                                setEditing({ ...s, ts: toLocalISOString(new Date(s.timestamp)) });
                                setEditError("");
                              }}
                              title="Edit Log"
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              className="danger-ghost small-btn"
                              onClick={() => setDeleting(s)}
                              title="Delete Log"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ),
                      },
                    ]
                  : []),
              ]}
              data={rows}
              pagination={meta ? { ...meta, onPageChange: gotoPage } : null}
            />
          )}
        </section>

        {/* --- ADD SHIFT MODAL --- */}
        {(addOpen || addClosing) && (
          <div className={`modal-backdrop ${addClosing ? "is-closing" : ""}`}>
            <div className={`modal ${addClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Clock size={22} className="muted"/> Log Manual Shift</h3>
              <form onSubmit={handleAddShift} className="flex flex-col gap-4" style={{ marginTop: "var(--space-3)" }}>
                <label className="field">
                  Staff Member
                  <Select
                    value={newShift.staffId}
                    onChange={(val) => setNewShift({ ...newShift, staffId: val })}
                    options={[
                      { value: "", label: "Select staff..." },
                      ...staffList.map((st) => ({ value: st.id, label: `${st.name} (${st.username})` }))
                    ]}
                  />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Cart
                    <Select
                      value={newShift.locationCode}
                      onChange={(val) => setNewShift({ ...newShift, locationCode: val })}
                      options={locations.map((l) => ({ value: l.code, label: l.code }))}
                    />
                  </label>
                  <label className="field">
                    Event
                    <Select
                      value={newShift.event}
                      onChange={(val) => setNewShift({ ...newShift, event: val })}
                      options={[
                        { value: "IN", label: "Clock IN" },
                        { value: "OUT", label: "Clock OUT" }
                      ]}
                    />
                  </label>
                </div>
                <label className="field">
                  Date & Time
                  <input
                    type="datetime-local"
                    required
                    value={newShift.ts}
                    onChange={(e) => {
                      setNewShift({ ...newShift, ts: e.target.value });
                      setTsTouched(true);
                    }}
                    style={{ height: "36px" }}
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeAddModal} disabled={isAdding || addClosing}>Cancel</button>
                  <button type="submit" disabled={isAdding || addClosing}>
                    {isAdding ? "Saving..." : "Log Shift"}
                  </button>
                </div>
                {addError && <p className="error-box" role="alert">{addError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* --- EDIT SHIFT MODAL --- */}
        {(editing || editClosing) && (
          <div className={`modal-backdrop ${editClosing ? "is-closing" : ""}`}>
            <div className={`modal ${editClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted"/> Edit Shift Log</h3>
              <form onSubmit={handleEditShift} className="flex flex-col gap-4" style={{ marginTop: "var(--space-3)" }}>
                <p className="muted small">Updating log for <strong>{editing?.staff?.name}</strong>.</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Cart
                    <Select
                      value={editing?.locationCode}
                      onChange={(val) => setEditing({ ...editing, locationCode: val })}
                      options={locations.map((l) => ({ value: l.code, label: l.code }))}
                    />
                  </label>
                  <label className="field">
                    Event
                    <Select
                      value={editing?.event}
                      onChange={(val) => setEditing({ ...editing, event: val })}
                      options={[
                        { value: "IN", label: "Clock IN" },
                        { value: "OUT", label: "Clock OUT" }
                      ]}
                    />
                  </label>
                </div>
                <label className="field">
                  Date & Time
                  <input
                    type="datetime-local"
                    required
                    value={editing?.ts || ""}
                    onChange={(e) => setEditing({ ...editing, ts: e.target.value })}
                    style={{ height: "36px" }}
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeEditModal} disabled={isEditing || editClosing}>Cancel</button>
                  <button type="submit" disabled={isEditing || editClosing}>
                    {isEditing ? "Saving..." : "Save Changes"}
                  </button>
                </div>
                {editError && <p className="error-box" role="alert">{editError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* --- DELETE LOG CONFIRMATION --- */}
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete Shift Log?"
          message={`Are you sure you want to permanently delete the ${deleting?.event} log for ${deleting?.staff?.name}? This action cannot be undone.`}
          confirmLabel="Delete Log"
          danger
          onConfirm={handleDeleteShift}
          onCancel={() => setDeleting(null)}
        />
      </div>
    </PageErrorBoundary>
  );
}