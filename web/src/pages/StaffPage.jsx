import { useEffect, useState, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { Trophy, Plus, Clock, Calendar, CalendarDays, Pencil, Copy, Eraser, CalendarCheck } from "lucide-react";
import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import Badge from "../components/Badge.jsx";
import { usePagedData } from "../hooks/usePagedData.js";
import { LIVE_EVENTS, useLiveEvent } from "../hooks/useLiveStream.js";
import { useLiveList } from "../state/liveData.js";
import DataTable from "../components/DataTable.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ErrorBox from "../components/ErrorBox.jsx";
import { TableSkeleton } from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
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
  const [loc, setLoc] = useState("");
  const [performance, setPerformance] = useState(null);
  const [perfLoading, setPerfLoading] = useState(true);

  // Weekly staff schedules (OWNER): the roster the time clock honors.
  const [schedules, setSchedules] = useState(null);
  const [schedLoading, setSchedLoading] = useState(true);
  const [schedError, setSchedError] = useState("");
  const [editStaff, setEditStaff] = useState(null); // staff row being edited, or null
  const [editClosing, setEditClosing] = useState(false);
  const [editDays, setEditDays] = useState(new Array(7).fill(null));
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // One shared, live copy of the staff accounts and of the carts. A new
  // account, a disabled account or a deactivated cart shows up here at once,
  // in this tab and in the other tabs.
  const { data: cartList } = useLiveList("carts");
  const { data: staffAll } = useLiveList("staff", { enabled: isOwner });
  const locations = Array.isArray(cartList) ? cartList : [];
  // Deactivated carts disappear from dropdowns. Only ACTIVE carts may be picked here.
  const activeLocations = locations.filter((l) => l.status !== "INACTIVE");
  // Only active staff members may be picked in the Manual Log dropdown.
  const staffList = Array.isArray(staffAll)
    ? staffAll.filter((s) => s.role !== "OWNER" && s.active)
    : [];

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

  // Shift logs are an audit trail: appended only, never edited or deleted
  // from the web. The add flow above is the only write path.

  // Sections that fail to load must not masquerade as "empty": track which
  // top-section requests failed so the UI can say so with a retry.
  const [topErrors, setTopErrors] = useState([]);

  const { rows, meta, loading: tableLoading, error, gotoPage, refresh: refreshTable } = usePagedData(
    (p) => `/shifts/history?page=${p}&pageSize=10` + (loc ? `&code=${loc}` : ""),
    [loc]
  );

  const fetchTopData = useCallback(() => {
    setPerfLoading(true);
    setTopErrors([]);
    const track = async (key, promise, fallback) => {
      try {
        return await promise;
      } catch {
        setTopErrors((prev) => (prev.includes(key) ? prev : [...prev, key]));
        return fallback;
      }
    };
    Promise.all([
      track("shifts", api.get("/staff/on-shift"), { data: { on_shift: [] } }),
      isOwner
        ? track("performance", api.get("/analytics/staff-performance?days=28"), { data: { staff: [] } })
        : Promise.resolve({ data: { staff: [] } }),
      isOwner
        ? track("schedules", api.get("/staff/schedules"), { data: { data: [] } })
        : Promise.resolve({ data: { data: [] } }),
    ]).then(([shiftRes, perfRes, schedRes]) => {
      setOnShift(shiftRes.data?.on_shift ?? []);
      setPerformance(perfRes.data ?? { staff: [] });
      setSchedules(schedRes.data?.data ?? []);
      setSchedLoading(false);
      setPerfLoading(false);
    });
  }, [isOwner]);

  const fetchSchedules = useCallback(async () => {
    setSchedLoading(true);
    setSchedError("");
    try {
      const res = await api.get("/staff/schedules");
      setSchedules(res.data?.data ?? []);
    } catch (err) {
      setSchedError(getFriendlyError(err, "Could not load the staff schedules."));
    } finally {
      setSchedLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial top-data load on mount/filter change
    fetchTopData();
  }, [fetchTopData]);

  // A card tapped on the reader: refresh who is on shift right away instead of
  // waiting for the next poll. A schedule save in another tab refreshes the roster too.
  useLiveEvent(LIVE_EVENTS.shiftNew, () => {
    fetchTopData();
  });
  useLiveEvent(LIVE_EVENTS.staffUpdated, () => {
    if (!isOwner) return;
    fetchTopData();
  });

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

  const isAnyModalOpen = addOpen || addClosing || Boolean(editStaff);
  useEffect(() => {
    if (isAnyModalOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [isAnyModalOpen]);

  const WEEKDAY_ROWS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  // Fold a week's edits: every entry is null (off) or { start, end }.
  const blankWeek = () => new Array(7).fill(null);
  const firstSetEntry = (days, from = 0, to = 6) => {
    for (let i = from; i <= to; i++) if (days[i]) return { ...days[i] };
    return { start: "06:00", end: "14:00" };
  };
  const copyWeekdays = (days) => {
    const seed = firstSetEntry(days, 1, 5);
    return days.map((d, i) => (i >= 1 && i <= 5 ? { ...seed } : d));
  };
  const setAllDays = (days) => {
    const seed = firstSetEntry(days, 0, 6);
    return days.map(() => ({ ...seed }));
  };
  const openScheduleEditor = (staffRow) => {
    setSchedError("");
    setEditError("");
    setEditDays(
      Array.isArray(staffRow?.schedule?.days)
        ? staffRow.schedule.days.map((d) => (d ? { start: d.start, end: d.end } : null))
        : blankWeek()
    );
    setEditStaff(staffRow);
  };
  const closeScheduleEditor = () => {
    setEditClosing(true);
    setTimeout(() => { setEditStaff(null); setEditClosing(false); }, 150);
  };
  async function saveSchedule() {
    if (!editStaff) return;
    for (const [i, d] of editDays.entries()) {
      if (!d) continue;
      if (!d.start || !d.end) { setEditError(`${WEEKDAY_ROWS[i]}: set both a start and an end.`); return; }
      if (d.start >= d.end) { setEditError(`${WEEKDAY_ROWS[i]}: the start must be before the end.`); return; }
    }
    setEditSaving(true);
    setEditError("");
    try {
      const res = await api.put(`/staff/${editStaff.id}/schedule`, { days: editDays });
      const saved = res.data?.schedule ?? null;
      setSchedules((prev) => (prev ?? []).map((row) => (row.id === editStaff.id ? { ...row, schedule: saved } : row)));
      toast("Schedule saved", "success");
      closeScheduleEditor();
    } catch (err) {
      setEditError(getFriendlyError(err, "Could not save the schedule."));
    } finally {
      setEditSaving(false);
    }
  }

  function closeAddModal() {
    setAddClosing(true);
    setTimeout(() => { setAddOpen(false); setAddClosing(false); }, 150);
  }

  async function handleAddShift(e) {
    e.preventDefault();
    setAddError("");
    
    if (!newShift.staffId) {
      setAddError("Select a staff member.");
      return;
    }
    if (!newShift.locationCode) {
      setAddError("Select a cart.");
      return;
    }
    // The cart may have been deactivated after the modal opened - the list
    // of active carts is live, so a deactivated cart refuses to submit.
    const stillActive = activeLocations.some((l) => l.code === newShift.locationCode);
    if (!stillActive) {
      setAddError("Cart is deactivated. Pick an active cart.");
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
        locationCode: activeLocations[0]?.code || "",
        event: "IN",
        ts: toLocalISOString(new Date())
      });
      setTsTouched(false);
      handleRefreshAll();
    } catch (err) {
      setAddError(getFriendlyError(err, "Failed to log manual shift."));
    } finally {
      setIsAdding(false);
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
              {isOwner && (
                <button
                  className="small-btn"
                  onClick={() => {
                    setAddError("");
                    setNewShift({
                      staffId: "",
                      locationCode: activeLocations[0]?.code || "",
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
        {topErrors.length > 0 && !perfLoading && (
          <ErrorBox
            message={`Could not load ${topErrors.join(", ")}. Showing cached data.`}
            onRetry={handleRefreshAll}
            style={{ marginBottom: "var(--space-4)" }}
          />
        )}
        <section className="panel staff-panel">
          <div className="flex items-center justify-between" style={{ marginBottom: "var(--space-4)" }}>
            <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>Currently on shift</h3>
            <Badge variant={onShift.length > 0 ? "ok" : "neutral"}>{onShift.length} Active</Badge>
          </div>
          {perfLoading ? (
            <div className="staff-chip-list-skeleton" aria-hidden="true">
              {Array.from({ length: 3 }).map((_, index) => (
                <div className="staff-chip staff-chip-skeleton" key={index}>
                  <span className="staff-avatar skel" />
                  <span className="staff-chip-skeleton-copy">
                    <span className="skel" />
                    <span className="skel" />
                  </span>
                </div>
              ))}
            </div>
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
            <TableSkeleton
              ariaLabel="Loading top performers"
              rows={5}
              fixedLayout
              columns={[
                { key: "rank", label: "Rank", width: 80, skeletonType: "badge" },
                { key: "staff", label: "Staff name", skeletonWidth: "68%" },
                { key: "sales", label: "Sales", align: "right", skeletonWidth: "48%" },
                { key: "orders", label: "Orders", align: "right", skeletonWidth: "38%" },
                { key: "average", label: "Avg ticket", align: "right", skeletonWidth: "48%" },
                { key: "ontime", label: "On-time %", align: "right", skeletonType: "badge" },
              ]}
            />
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
                    <th className="t-right" title="Share of scheduled clock-ins that were on time (last 28 days)">On-time %</th>
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
                      <td className="t-right">
                        {s.on_time_pct == null ? (
                          <span className="muted" title="No scheduled clock-ins in the period">—</span>
                        ) : (
                          <Badge variant={s.on_time_pct >= 90 ? "ok" : s.on_time_pct >= 70 ? "warn" : "danger"}>
                            {s.on_time_pct}%
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 2.5. STAFF SCHEDULES (OWNER) */}
        {isOwner && (
          <section className="panel staff-panel">
            <div className="flex items-center justify-between flex-wrap gap-3" style={{ marginBottom: "var(--space-4)" }}>
              <div>
                <h3 className="section-title m-0 p-0 flex items-center gap-2" style={{ borderBottom: "none" }}>
                  <CalendarDays size={20} className="muted" /> Staff Schedules
                </h3>
                <p className="muted small" style={{ margin: "4px 0 0" }}>
                  The weekly roster the time clock and the card reader honor — time in/out is refused outside it.
                </p>
              </div>
              {!schedLoading && !schedError && Array.isArray(schedules) && (
                <Badge variant="neutral">
                  {schedules.filter((r) => r.schedule).length} of {schedules.length} with a schedule
                </Badge>
              )}
            </div>

            {schedLoading ? (
              <TableSkeleton
                ariaLabel="Loading staff schedules"
                rows={4}
                fixedLayout
                columns={[
                  { key: "staff", label: "Staff", skeletonWidth: "58%" },
                  { key: "cart", label: "Cart", width: 90, skeletonType: "badge" },
                  ...["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => ({ key: d, label: d, width: 74, skeletonWidth: "64%" })),
                  { key: "status", label: "Status", width: 120, skeletonType: "badge" },
                  { key: "edit", label: "", width: 90, skeletonType: "badge" },
                ]}
              />
            ) : schedError ? (
              <ErrorBox message={schedError} onRetry={fetchSchedules} />
            ) : !Array.isArray(schedules) || schedules.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title="No staff accounts yet."
                subtitle="Create staff accounts in Settings, then set their weekly roster here."
              />
            ) : (
              <div className="table-wrap">
                <table className="data table-fixed schedule-table">
                  <thead>
                    <tr>
                      <th>Staff</th>
                      <th style={{ width: 90 }}>Cart</th>
                      <th className="t-center" style={{ width: 74 }}>Sun</th>
                      <th className="t-center" style={{ width: 74 }}>Mon</th>
                      <th className="t-center" style={{ width: 74 }}>Tue</th>
                      <th className="t-center" style={{ width: 74 }}>Wed</th>
                      <th className="t-center" style={{ width: 74 }}>Thu</th>
                      <th className="t-center" style={{ width: 74 }}>Fri</th>
                      <th className="t-center" style={{ width: 74 }}>Sat</th>
                      <th style={{ width: 118 }}>Status</th>
                      <th style={{ width: 90 }} aria-label="Edit"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedules.map((row) => (
                      <tr key={row.id} className={row.active === false ? "schedule-row-inactive" : undefined}>
                        <td>
                          <div className="flex items-center gap-2">
                            <span className="staff-avatar" style={{ width: 24, height: 24, fontSize: 10 }}>
                              {initials(row.name)}
                            </span>
                            <div className="flex flex-col">
                              <strong className="flex items-center gap-2">
                                {row.name}
                                {row.active === false && <Badge variant="danger">Inactive</Badge>}
                              </strong>
                              <span className="muted small">@{row.username}</span>
                            </div>
                          </div>
                        </td>
                        <td className="muted">{row.locationCode ?? "—"}</td>
                        {(row.schedule?.days ?? new Array(7).fill(null)).map((d, i) => (
                          <td key={i} className={`schedule-cell${d ? "" : " off"}`}>
                            {d ? `${d.start}–${d.end}` : "Off"}
                          </td>
                        ))}
                        <td>
                          <Badge variant={row.schedule ? "ok" : "neutral"}>
                            {row.schedule ? "Scheduled" : "No schedule"}
                          </Badge>
                        </td>
                        <td>
                          <button type="button" className="small-btn ghost" onClick={() => openScheduleEditor(row)}>
                            <Pencil size={13} /> Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* 3. SHIFT HISTORY */}
        <section className="panel staff-panel">
          <div className="flex items-center justify-between flex-wrap gap-3" style={{ marginBottom: "var(--space-4)" }}>
            <div>
              <h3 className="section-title m-0 p-0 flex items-center gap-2" style={{ borderBottom: "none" }}>
                <Calendar size={20} className="muted" /> Shift History
              </h3>
              <p className="muted small" style={{ margin: "4px 0 0" }}>Logs are append-only — they cannot be edited or deleted.</p>
            </div>
            <Select
              value={loc}
              onChange={(val) => setLoc(val)}
              options={[
                { value: "", label: "All carts" },
                ...activeLocations.map((l) => ({ value: l.code, label: l.code })),
                // A cart the shift history was recorded for keeps its filter value visible.
                ...(loc && !activeLocations.some((l) => l.code === loc) ? [{ value: loc, label: loc }] : []),
              ]}
              placeholder="All carts"
            />
          </div>

          {tableLoading ? (
            <TableSkeleton
              ariaLabel="Loading shift history"
              rows={5}
              fixedLayout
              columns={[
                { key: "time", label: "Time", width: 150, skeletonWidth: "70%" },
                { key: "staff", label: "Staff", skeletonWidth: "58%" },
                { key: "cart", label: "Cart", width: 120, skeletonType: "badge" },
                { key: "event", label: "Event", width: 100, skeletonType: "badge" },
                { key: "source", label: "Source", width: 100, skeletonType: "badge" },
                { key: "punctuality", label: "Punctuality", width: 150, skeletonType: "badge" },
              ]}
            />
          ) : error ? (
            <ErrorBox message={error} onRetry={handleRefreshAll} />
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
                      {new Date(s.ts).toLocaleString([], {
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
                        {initials(s.staffName)}
                      </span>
                      <strong>{s.staffName ?? `Unregistered card ${s.staffUid}`}</strong>
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
                  render: (s) => {
                    // The API never wrote a `source` field: a reader tap stores
                    // the device id (e.g. esp32-cart-01) in deviceId, a manual
                    // log stores "MANUAL". Derive the audit label from either.
                    const isManual = (s.source ?? s.deviceId) === "MANUAL";
                    return (
                      <Badge variant={isManual ? "danger" : "neutral"}>
                        {isManual ? "MANUAL" : "RFID"}
                      </Badge>
                    );
                  },
                },
                {
                  key: "punctuality",
                  label: "Punctuality",
                  width: 150,
                  render: (s) => {
                    const p = s.punctuality;
                    if (!p) return <span className="muted">—</span>;
                    const variant = p.tone === "ok" ? "ok" : p.tone === "warn" ? "warn" : p.tone === "info" ? "info" : "neutral";
                    return <Badge variant={variant}>{p.label}</Badge>;
                  },
                },
              ]}
              data={rows}
              pagination={meta ? { ...meta, onPageChange: gotoPage } : null}
            />
          )}
        </section>

        {/* --- EDIT SCHEDULE MODAL --- */}
        {editStaff && (
          <div className={`modal-backdrop ${editClosing ? "is-closing" : ""}`}>
            <div className={`modal schedule-modal ${editClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Edit schedule for ${editStaff.name}`}>
              <h3><CalendarDays size={22} className="muted" /> Edit schedule — {editStaff.name}</h3>
              <p className="muted small" style={{ margin: "6px 0 0" }}>
                Sunday-first week. A day switched off means no time in/out is accepted — the card reader and the app both refuse.
              </p>
              {!editStaff.schedule && (
                <p className="schedule-unrestricted">No schedule yet — time in/out stays unrestricted until you save one.</p>
              )}

              <div className="schedule-quick">
                <button type="button" className="small-btn ghost" onClick={() => setEditDays((d) => copyWeekdays(d))}>
                  <Copy size={13} /> Copy to Mon–Fri
                </button>
                <button type="button" className="small-btn ghost" onClick={() => setEditDays((d) => setAllDays(d))}>
                  <CalendarCheck size={13} /> Set all days
                </button>
                <button type="button" className="small-btn ghost" onClick={() => setEditDays(blankWeek())}>
                  <Eraser size={13} /> Clear week
                </button>
              </div>

              <div className="schedule-day-list">
                {WEEKDAY_ROWS.map((label, i) => (
                  <div className="schedule-day-row" key={label}>
                    <span className="schedule-day-name">{label}</span>
                    <label className="schedule-off" title="This day is off">
                      <input
                        type="checkbox"
                        checked={!editDays[i]}
                        onChange={() =>
                          setEditDays((prev) => {
                            const next = [...prev];
                            next[i] = next[i] ? null : { start: "06:00", end: "14:00" };
                            return next;
                          })
                        }
                        aria-label={`${label} is off`}
                      />
                      Off
                    </label>
                    <input
                      type="time"
                      value={editDays[i]?.start ?? ""}
                      disabled={!editDays[i]}
                      onChange={(e) =>
                        setEditDays((prev) => {
                          const next = [...prev];
                          if (next[i]) next[i] = { ...next[i], start: e.target.value };
                          return next;
                        })
                      }
                      aria-label={`${label} start`}
                    />
                    <span className="muted">to</span>
                    <input
                      type="time"
                      value={editDays[i]?.end ?? ""}
                      disabled={!editDays[i]}
                      onChange={(e) =>
                        setEditDays((prev) => {
                          const next = [...prev];
                          if (next[i]) next[i] = { ...next[i], end: e.target.value };
                          return next;
                        })
                      }
                      aria-label={`${label} end`}
                    />
                  </div>
                ))}
              </div>

              {editStaff.schedule?.updatedAt && (
                <p className="muted small schedule-audit">
                  Last edited by {editStaff.schedule.updatedByName ?? "Owner"} ·{" "}
                  {new Date(editStaff.schedule.updatedAt).toLocaleString([], {
                    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                  })}
                </p>
              )}
              {editError && <ErrorBox message={editError} style={{ marginTop: "var(--space-2, 8px)" }} />}
              <div className="flex items-center justify-end gap-2" style={{ marginTop: "var(--space-3)" }}>
                <button type="button" className="small-btn ghost" onClick={closeScheduleEditor} disabled={editSaving}>
                  Cancel
                </button>
                <button type="button" className="small-btn" onClick={saveSchedule} disabled={editSaving}>
                  {editSaving ? "Saving…" : "Save schedule"}
                </button>
              </div>
            </div>
          </div>
        )}

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
                      options={activeLocations.map((l) => ({ value: l.code, label: l.code }))}
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

      </div>
    </PageErrorBoundary>
  );
}