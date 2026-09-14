import { useEffect, useState, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { Trophy, Users, RefreshCw, X, Plus, Edit2, Trash2, Clock } from "lucide-react";
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
  // Tracks whether the manager hand-edited the timestamp. The live clock
  // below only ticks an untouched field, so typing is never overwritten.
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial mount fetch via stable callback
    fetchTopData();
  }, [fetchTopData]);

  useEffect(() => {
    if (tableLoading || perfLoading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional clock sync when loading flips
    setLastUpdated(new Date());
  }, [tableLoading, perfLoading]);

  // Live clock for Exact Date & Time: ticks every second while the manual
  // entry modal is open, until the manager hand-edits the field.
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

  // --- MODAL UX & HELPERS ---
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

  // --- MANUAL ENTRY HANDLER (OWNER user-JWT endpoint; the device-only
  // POST /shifts would 401 a user token and must never be used here) ---
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

  // --- EDIT SHIFT HANDLER ---
  async function handleEditShift(e) {
    e.preventDefault();
    setEditError("");
    const at = editing.ts ? new Date(editing.ts) : null;
    if (!at || !Number.isFinite(at.getTime())) {
      setEditError("Enter a valid date and time.");
      return;
    }
    // Timestamps compare at minute precision (the input has no seconds).
    const sameMinute = (a, b) => Math.floor(new Date(a).getTime() / 60000) === Math.floor(new Date(b).getTime() / 60000);
    const original = rows.find((r) => r.id === editing.id);
    if (
      original &&
      editing.event === original.event &&
      editing.locationCode === (original.location?.code || "") &&
      sameMinute(editing.ts, original.ts)
    ) {
      toast("No changes — nothing to update on this shift log.", "info");
      closeEditModal();
      return;
    }
    setIsEditing(true);
    try {
      await api.patch(`/shifts/${editing.id}`, {
        locationCode: editing.locationCode,
        event: editing.event,
        ts: at.toISOString()
      });
      toast(`Shift event updated`, "success");
      closeEditModal();
      handleRefreshAll();
    } catch (err) {
      setEditError(getErrorMessage(err, "Failed to update shift log."));
    } finally {
      setIsEditing(false);
    }
  }

  // --- DELETE SHIFT HANDLER ---
  async function handleDeleteShift() {
    if (!deleting) return;
    try {
      await api.del(`/shifts/${deleting.id}`);
      toast(`Shift log deleted successfully`, "success");
      handleRefreshAll();
    } catch (err) {
      toast(getErrorMessage(err, "Failed to delete shift log."), "error");
    } finally {
      setDeleting(null);
    }
  }

  const safeLocations = Array.isArray(locations) ? locations : [];
  const locationOptions = [
    { value: "", label: "All carts" },
    ...safeLocations.map((l) => ({ value: l.code, label: l.code }))
  ];
  
  const formLocationOptions = safeLocations.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }));
  const formStaffOptions = [
    { value: "", label: "Select staff..." },
    ...staffList.map((s) => ({ value: s.id, label: s.name }))
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
              {isOwner && (
                <button
                  className="small-btn"
                  onClick={() => {
                    if(!newShift.locationCode && locations.length > 0) {
                      setNewShift(prev => ({ ...prev, locationCode: locations[0].code }));
                    }
                    // Fresh timestamp + re-arm the live clock on every open.
                    setNewShift(prev => ({ ...prev, ts: toLocalISOString(new Date()) }));
                    setTsTouched(false);
                    setAddOpen(true);
                  }}
                >
                  <Plus size={14} /> Manual Entry
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
                                setEditing({
                                  ...s,
                                  locationCode: s.location?.code || "",
                                  ts: toLocalISOString(new Date(s.ts))
                                });
                                setEditError("");
                              }}
                              title="Edit shift log"
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              className="danger-ghost small-btn"
                              onClick={() => setDeleting(s)}
                              title="Delete shift log"
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

        {/* --- MANUAL ENTRY MODAL --- */}
        {(addOpen || addClosing) && (
          <div className={`modal-backdrop ${addClosing ? "is-closing" : ""}`}>
            <div className={`modal ${addClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Clock size={22} className="muted"/> Manual Shift Entry</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Log an IN or OUT event if a staff member forgot to tap their RFID card.
              </p>
              
              <form onSubmit={handleAddShift} className="flex flex-col gap-4">
                <label className="field">
                  Staff Member
                  <Select
                    value={newShift.staffId}
                    onChange={(val) => setNewShift({ ...newShift, staffId: val })}
                    options={formStaffOptions}
                    placeholderValue=""
                  />
                </label>
                
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Event Type
                    <Select
                      value={newShift.event}
                      onChange={(val) => setNewShift({ ...newShift, event: val })}
                      options={[
                        { value: "IN", label: "Time IN" },
                        { value: "OUT", label: "Time OUT" }
                      ]}
                    />
                  </label>
                  
                  <label className="field">
                    Cart Assignment
                    <Select
                      value={newShift.locationCode}
                      onChange={(val) => setNewShift({ ...newShift, locationCode: val })}
                      options={formLocationOptions}
                    />
                  </label>
                </div>

                <label className="field">
                  Exact Date & Time
                  <input
                    type="datetime-local"
                    required
                    value={newShift.ts}
                    onChange={(e) => {
                      setTsTouched(true);
                      setNewShift({ ...newShift, ts: e.target.value });
                    }}
                    title="Live clock — edit to set a custom time"
                    style={{ height: "36px" }}
                  />
                </label>
                
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeAddModal} disabled={isAdding || addClosing}>Cancel</button>
                  <button type="submit" disabled={isAdding || addClosing || !newShift.staffId}>
                    {isAdding ? "Saving..." : "Log Shift"}
                  </button>
                </div>
                {addError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{addError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* --- EDIT SHIFT MODAL --- */}
        {(editing || editClosing) && (
          <div className={`modal-backdrop ${editClosing ? "is-closing" : ""}`}>
            <div className={`modal ${editClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted"/> Edit Shift Log</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Update the event details for <strong>{editing?.staffName || "Unregistered"}</strong>.
              </p>
              
              <form onSubmit={handleEditShift} className="flex flex-col gap-4">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
                  <label className="field">
                    Event Type
                    <Select
                      value={editing?.event || "IN"}
                      onChange={(val) => setEditing({ ...editing, event: val })}
                      options={[
                        { value: "IN", label: "Time IN" },
                        { value: "OUT", label: "Time OUT" }
                      ]}
                    />
                  </label>
                  
                  <label className="field">
                    Cart Assignment
                    <Select
                      value={editing?.locationCode || ""}
                      onChange={(val) => setEditing({ ...editing, locationCode: val })}
                      options={formLocationOptions}
                    />
                  </label>
                </div>

                <label className="field">
                  Exact Date & Time
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
                {editError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{editError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* --- DELETE SHIFT CONFIRMATION --- */}
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete shift log?"
          message={`Are you sure you want to delete the ${deleting?.event} event for "${deleting?.staffName}"? This action cannot be undone.`}
          confirmLabel="Delete Log"
          danger={true}
          onConfirm={handleDeleteShift}
          onCancel={() => setDeleting(null)}
        />
        
      </div>
    </PageErrorBoundary>
  );
}