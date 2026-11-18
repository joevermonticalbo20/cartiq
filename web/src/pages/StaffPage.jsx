import { useEffect, useState, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { Trophy, Plus, Clock, Calendar, CalendarDays, Pencil, Copy, Eraser, CalendarCheck, FileText, Download } from "lucide-react";
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

/** "06:00" -> "6:00 AM" (12-hour display). */
function to12h(hhmm) {
  if (!hhmm) return "Off";
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  let h = Number(m[1]);
  const min = m[2];
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${period}`;
}

/** CSV escaping per RFC 4180 (quote when the value has separators/quotes/newlines). */
function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cols) => cols.map(csvEscape).join(",");

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
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Attendance report in Shift History (OWNER): a summary + per-staff
  // breakdown for the last N days, downloadable as CSV.
  const [reportDays, setReportDays] = useState(28);
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportError, setReportError] = useState("");

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

  const fetchReport = useCallback(async () => {
    setReportLoading(true);
    setReportError("");
    try {
      const res = await api.get(
        `/shifts/report?days=${reportDays}${loc ? `&code=${encodeURIComponent(loc)}` : ""}`,
      );
      setReport(res.data ?? null);
    } catch (err) {
      setReport(null);
      setReportError(getFriendlyError(err, "Could not load the attendance report."));
    } finally {
      setReportLoading(false);
    }
  }, [reportDays, loc]);

  useEffect(() => {
    if (!isOwner) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial report load on mount/window change
    fetchReport();
  }, [isOwner, fetchReport]);

  function downloadReportCsv() {
    if (!report) return;
    const head = [
      "Name", "Username", "Cart", "Scheduled days", "Clock-ins", "Clock-outs",
      "On-time", "Tardy", "Early out", "Overtime (min)", "Hours worked",
      "On-time %", "Half days", "Absences", "Status",
    ];
    const lines = [csvRow(head)];
    for (const s of report.staff ?? []) {
      lines.push(csvRow([
        s.name, s.username, s.locationCode ?? "", s.scheduled_days,
        s.clock_ins, s.clock_outs, s.on_time, s.tardy, s.early_out,
        s.overtime_min, s.hours_worked, s.on_time_pct ?? "", s.half_days, s.absences,
        s.active === false ? "inactive" : "active",
      ]));
    }
    const t = report.totals ?? {};
    lines.push(csvRow([
      "TOTAL", "", "", "",
      t.clock_ins, t.clock_outs, t.on_time, t.tardy, t.early_out,
      t.overtime_min, t.hours_worked, t.on_time_pct ?? "", t.half_days, t.absences, "",
    ]));
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance-report-last-${report.period_days}d.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Attendance report downloaded", "success");
  }

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
    setRemoveConfirm(false);
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
  async function removeSchedule() {
    if (!editStaff) return;
    setRemoving(true);
    try {
      await api.del(`/staff/${editStaff.id}/schedule`);
      setSchedules((prev) =>
        (prev ?? []).map((row) => (row.id === editStaff.id ? { ...row, schedule: null } : row)),
      );
      toast("Schedule removed - time in/out is unrestricted again", "success");
      setRemoveConfirm(false);
      closeScheduleEditor();
    } catch (err) {
      setEditError(getFriendlyError(err, "Could not remove the schedule."));
      setRemoveConfirm(false);
    } finally {
      setRemoving(false);
    }
  }

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
              <div className="schedule-cards">
                {schedules.map((row) => (
                  <article
                    key={row.id}
                    className={`schedule-card${row.active === false ? " schedule-card-inactive" : ""}${row.schedule ? "" : " schedule-card-empty"}`}
                  >
                    <header className="schedule-card-head">
                      <span className="staff-avatar schedule-avatar">{initials(row.name)}</span>
                      <div className="flex flex-col" style={{ minWidth: 0 }}>
                        <strong className="flex items-center gap-2">
                          {row.name}
                          {row.active === false && <Badge variant="danger">Inactive</Badge>}
                        </strong>
                        <span className="muted small">@{row.username}{row.locationCode ? ` · ${row.locationCode}` : ""}</span>
                      </div>
                      <span className="schedule-card-status">
                        <Badge variant={row.schedule ? "ok" : "neutral"}>
                          {row.schedule ? "Scheduled" : "No schedule"}
                        </Badge>
                      </span>
                    </header>

                    <div className="schedule-week" aria-label={`Weekly roster of ${row.name}`}>
                      {(row.schedule?.days ?? new Array(7).fill(null)).map((d, i) => (
                        <div key={i} className={`schedule-day${d ? "" : " off"}`}>
                          <span className="schedule-day-label">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i]}</span>
                          {d ? (
                            <span className="schedule-day-times">
                              <span className="schedule-day-in">{to12h(d.start)}</span>
                              <span className="schedule-day-out">{to12h(d.end)}</span>
                            </span>
                          ) : (
                            <span className="schedule-day-off">Off</span>
                          )}
                        </div>
                      ))}
                    </div>

                    <footer className="schedule-card-foot">
                      <span className="muted small schedule-audit">
                        {row.schedule?.updatedByName
                          ? `Edited by ${row.schedule.updatedByName}${row.schedule.updatedAt ? ` · ${new Date(row.schedule.updatedAt).toLocaleString([], { month: "short", day: "numeric" })}` : ""}`
                          : "No changes yet"}
                      </span>
                      <button type="button" className="small-btn ghost" onClick={() => openScheduleEditor(row)}>
                        <Pencil size={13} /> Edit
                      </button>
                    </footer>
                  </article>
                ))}
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

          {/* 3a. ATTENDANCE REPORT (summary over the roster) */}
          {isOwner && (
            <div className="report-panel">
              <div className="report-panel-head">
                <div className="flex items-center gap-2 flex-wrap">
                  <FileText size={16} className="muted" />
                  <strong>Attendance report</strong>
                  <span className="muted small">
                    vs the current weekly roster{loc ? ` · assigned to ${loc}` : ""}
                    {report?.generated_at
                      ? ` · generated ${new Date(report.generated_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                      : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select
                    value={String(reportDays)}
                    onChange={(val) => setReportDays(Number(val))}
                    options={[7, 14, 28, 90].map((d) => ({ value: String(d), label: `Last ${d} days` }))}
                    ariaLabel="Report window"
                  />
                  <button
                    type="button"
                    className="small-btn danger"
                    onClick={downloadReportCsv}
                    disabled={!report}
                    title="Download the report as CSV"
                  >
                    <Download size={13} /> CSV
                  </button>
                </div>
              </div>
              {reportLoading ? (
                <TableSkeleton
                  ariaLabel="Loading attendance report"
                  rows={3}
                  fixedLayout
                  columns={[
                    { key: "staff", label: "Staff", skeletonWidth: "58%" },
                    { key: "in", label: "Clock-ins", width: 100, skeletonType: "badge" },
                    { key: "ontime", label: "On-time %", width: 100, skeletonType: "badge" },
                    { key: "tardy", label: "Tardy", width: 80, skeletonType: "badge" },
                    { key: "absence", label: "Absences", width: 100, skeletonType: "badge" },
                  ]}
                />
              ) : reportError ? (
                <ErrorBox message={reportError} onRetry={fetchReport} />
              ) : !report ? null : (
                <>
                  <div className="report-kpis">
                    {[
                      { label: "On-time", value: report.totals.on_time_pct == null ? "—" : `${report.totals.on_time_pct}%` },
                      { label: "Clock-ins", value: report.totals.clock_ins },
                      { label: "Tardy", value: report.totals.tardy },
                      { label: "Early out", value: report.totals.early_out },
                      { label: "Overtime", value: `${report.totals.overtime_hours}h` },
                      { label: "Half days", value: report.totals.half_days },
                      { label: "Absences", value: report.totals.absences },
                    ].map((kpi) => (
                      <div className="report-kpi" key={kpi.label}>
                        <span className="report-kpi-label">{kpi.label}</span>
                        <span className="report-kpi-value">{kpi.value}</span>
                      </div>
                    ))}
                  </div>
                  <div className="table-wrap">
                    <table className="data table-fixed report-table">
                      <thead>
                        <tr>
                          <th>Staff</th>
                          <th className="t-right">Clock-ins</th>
                          <th className="t-right">Clock-outs</th>
                          <th className="t-right" title="Share of scheduled clock-ins that were on time">On-time %</th>
                          <th className="t-right">Tardy</th>
                          <th className="t-right">Early out</th>
                          <th className="t-right">OT hrs</th>
                          <th className="t-right">Worked h</th>
                          <th className="t-right" title="A day with an IN but no OUT after the day ends (hours credited: half of the scheduled shift)">Half days</th>
                          <th className="t-right">Absent</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.staff.map((s) => (
                          <tr key={s.staff_id} className={s.active === false ? "schedule-row-inactive" : undefined}>
                            <td>
                              <div className="flex items-center gap-2">
                                <span className="staff-avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                                  {initials(s.name)}
                                </span>
                                <strong>{s.name}</strong>
                              </div>
                            </td>
                            <td className="t-right">{s.clock_ins}</td>
                            <td className="t-right">{s.clock_outs}</td>
                            <td className="t-right">
                              {s.on_time_pct == null ? (
                                <span className="muted">—</span>
                              ) : (
                                <Badge variant={s.on_time_pct >= 90 ? "ok" : s.on_time_pct >= 70 ? "warn" : "danger"}>
                                  {s.on_time_pct}%
                                </Badge>
                              )}
                            </td>
                            <td className="t-right">{s.tardy}</td>
                            <td className="t-right">{s.early_out}</td>
                            <td className="t-right">{s.overtime_hours}</td>
                            <td className="t-right">{s.hours_worked}</td>
                            <td className="t-right">{s.half_days}</td>
                            <td className="t-right">{s.absences}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

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
                { key: "source", label: "Method", width: 100, skeletonType: "badge" },
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
                  label: "Method",
                  width: 100,
                  render: (s) => {
                    // Server attaches `method` (RFID/APP/MANUAL); legacy rows
                    // derive from the old deviceId heuristic.
                    const method = s.method
                      ?? ((s.source ?? s.deviceId) === "MANUAL" ? "MANUAL" : "RFID");
                    return (
                      <Badge variant={method === "MANUAL" ? "danger" : method === "APP" ? "info" : "neutral"}>
                        {method}
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
              <div className="flex items-center justify-between gap-2" style={{ marginTop: "var(--space-3)" }}>
                {editStaff.schedule ? (
                  <button type="button" className="small-btn ghost schedule-remove" onClick={() => setRemoveConfirm(true)} disabled={editSaving || removing}>
                    Remove schedule
                  </button>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">
                  <button type="button" className="small-btn ghost" onClick={closeScheduleEditor} disabled={editSaving || removing}>
                    Cancel
                  </button>
                  <button type="button" className="small-btn" onClick={saveSchedule} disabled={editSaving || removing}>
                    {editSaving ? "Saving…" : "Save schedule"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        <ConfirmDialog
          open={removeConfirm}
          title="Remove schedule?"
          message={`Time in/out for ${editStaff?.name ?? "this staff member"} becomes unrestricted again. The saved weekly template and its edit history are erased. Time logs already recorded are not affected.`}
          confirmLabel="Remove schedule"
          danger
          pending={removing}
          pendingLabel="Removing…"
          onConfirm={removeSchedule}
          onCancel={() => setRemoveConfirm(false)}
        />

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