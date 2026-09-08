import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { KeyRound, Plus, RefreshCw, Eye, EyeOff } from "lucide-react";
import api from "../api.js";
import Badge from "../components/Badge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import Skeleton from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import PasswordStrengthMeter from "../components/PasswordStrengthMeter.jsx";
import { useToast } from "../components/Toast.jsx";
import Select from "../components/Select.jsx"; 

export default function SettingsPage() {
  const toast = useToast();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";
  
  const [profile, setProfile] = useState(user ?? null);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [devices, setDevices] = useState([]);
  const [staff, setStaff] = useState([]);
  const [locations, setLocations] = useState([]);
  
  const [addOpen, setAddOpen] = useState(false);
  const [resetting, setResetting] = useState(null);
  const [resetPw, setResetPw] = useState("");
  const [disabling, setDisabling] = useState(null);
  
  const [pwError, setPwError] = useState("");
  const [staffError, setStaffError] = useState("");
  const [resetError, setResetError] = useState("");
  
  // Mga states para sa Eye Toggle (Show/Hide Password)
  const [showPw, setShowPw] = useState({ current: false, next: false, confirm: false });
  const [showNewStaffPw, setShowNewStaffPw] = useState(false);
  const [showResetPw, setShowResetPw] = useState(false);
  
  const [newStaff, setNewStaff] = useState({
    name: "",
    username: "",
    password: "",
    locationCode: "CART-01",
    rfidUid: "",
  });

  function loadOwnerData() {
    if (!isOwner) return;
    api.get("/devices").then(({ data }) => setDevices(data.data)).catch(() => {});
    api.get("/auth/staff").then(({ data }) => setStaff(data.data)).catch(() => {});
  }

  useEffect(() => {
    api.get("/auth/me").then(({ data }) => setProfile(data.user));
    api.get("/catalog").then(({ data }) => setLocations(data.locations));
    loadOwnerData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);

  async function changePassword(e) {
    e.preventDefault();
    if (pw.next !== pw.confirm) {
      setPwError("New passwords do not match - check the confirmation field.");
      return;
    }
    if (pw.next.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    setPwError("");
    try {
      await api.post("/auth/change-password", {
        currentPassword: pw.current,
        newPassword: pw.next,
      });
      toast("Password updated successfully", "success");
      setPw({ current: "", next: "", confirm: "" });
      setShowPw({ current: false, next: false, confirm: false }); // Reset eye toggles
    } catch (err) {
      setPwError(err.response?.data?.error || "Change failed - is the current password correct?");
    }
  }

  async function createStaff(e) {
    e.preventDefault();
    if (newStaff.password.length < 8) {
      setStaffError("Password must be at least 8 characters.");
      return;
    }
    setStaffError("");
    try {
      await api.post("/auth/staff", {
        ...newStaff,
        rfidUid: newStaff.rfidUid || null,
      });
      toast(`Staff account "${newStaff.username}" created`, "success");
      setAddOpen(false);
      setNewStaff({ name: "", username: "", password: "", locationCode: "CART-01", rfidUid: "" });
      setShowNewStaffPw(false);
      loadOwnerData();
    } catch (err) {
      setStaffError(err.response?.data?.error || "Create failed - is the username or RFID already taken?");
    }
  }

  async function toggleActive(s) {
    try {
      await api.patch(`/auth/staff/${s.id}`, { active: !s.active });
      toast(`${s.username} ${s.active ? "disabled" : "enabled"}`, "success");
      loadOwnerData();
    } catch (err) {
      toast(err.response?.data?.error || "Update failed", "error");
    }
    setDisabling(null);
  }

  async function doResetPassword() {
    if (!resetting) return;
    if (resetPw.length < 8) {
      setResetError("New password must be at least 8 characters.");
      return;
    }
    setResetError("");
    try {
      await api.patch(`/auth/staff/${resetting.id}`, { password: resetPw });
      toast(`Password reset for ${resetting.username}`, "success");
      setResetting(null);
      setResetPw("");
      setShowResetPw(false);
    } catch (err) {
      setResetError(err.response?.data?.error || "Reset failed - try again.");
    }
  }

  const locationOptions = locations.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }));

  // Reusable inline style para sa mata (eye icon)
  const toggleBtnStyle = {
    position: "absolute",
    right: "10px",
    top: "50%",
    transform: "translateY(-50%)",
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  };

  return (
    <PageErrorBoundary>
      <div className="page-container wide">
        <PageHeader
          eyebrow="Administration"
          title="Settings"
          sub="Your profile, password, devices, and staff accounts."
        />

        <div className="settings-grid" style={{ gap: "var(--space-4)", alignItems: "start" }}>
          
          {/* PROFILE PANEL */}
          <section className="panel" style={{ padding: "var(--space-5)" }}>
            <h3 className="section-title" style={{ padding: 0, borderBottom: "none", marginBottom: "var(--space-4)" }}>
              Profile
            </h3>
            {!profile ? (
              <Skeleton rows={3} />
            ) : (
              <div className="flex flex-col" aria-label="Profile details">
                <div className="flex items-center justify-between" style={{ padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="muted text-sm">Name</span>
                  <strong className="text-right">{profile.name}</strong>
                </div>
                <div className="flex items-center justify-between" style={{ padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="muted text-sm">Username</span>
                  <span className="text-right">{profile.username}</span>
                </div>
                <div className="flex items-center justify-between" style={{ padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="muted text-sm">Role</span>
                  <Badge variant="brand">{profile.role}</Badge>
                </div>
                <div className="flex items-center justify-between" style={{ padding: "14px 0" }}>
                  <span className="muted text-sm">Cart assignment</span>
                  <span className="text-right">{profile.location ? `${profile.location.code} - ${profile.location.name}` : "All carts"}</span>
                </div>
              </div>
            )}
          </section>

          {/* CHANGE PASSWORD PANEL */}
          <section className="panel" style={{ padding: "var(--space-5)" }}>
            <h3 className="section-title" style={{ padding: 0, borderBottom: "none", marginBottom: "var(--space-4)" }}>
              Change password
            </h3>
            <form onSubmit={changePassword} className="flex flex-col gap-3">
              
              {/* CURRENT PASSWORD */}
              <label className="field">
                Current password
                <div style={{ position: "relative" }}>
                  <input
                    type={showPw.current ? "text" : "password"}
                    value={pw.current}
                    onChange={(e) => setPw({ ...pw, current: e.target.value })}
                    required
                    autoComplete="current-password"
                    style={{ height: "36px", width: "100%", paddingRight: "36px" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw({ ...showPw, current: !showPw.current })}
                    style={toggleBtnStyle}
                    aria-label={showPw.current ? "Hide password" : "Show password"}
                  >
                    {showPw.current ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
              
              {/* NEW PASSWORD */}
              <label className="field">
                New password (min 8 chars)
                <div style={{ position: "relative" }}>
                  <input
                    type={showPw.next ? "text" : "password"}
                    value={pw.next}
                    onChange={(e) => {
                      setPw({ ...pw, next: e.target.value });
                      if (pwError.includes("match") && pw.confirm === e.target.value) {
                        setPwError("");
                      }
                    }}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    style={{ height: "36px", width: "100%", paddingRight: "36px" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw({ ...showPw, next: !showPw.next })}
                    style={toggleBtnStyle}
                    aria-label={showPw.next ? "Hide password" : "Show password"}
                  >
                    {showPw.next ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <PasswordStrengthMeter value={pw.next} minLevel="good" />
              </label>
              
              {/* CONFIRM NEW PASSWORD */}
              <label className="field">
                Confirm new password
                <div style={{ position: "relative" }}>
                  <input
                    type={showPw.confirm ? "text" : "password"}
                    value={pw.confirm}
                    onChange={(e) => {
                      const val = e.target.value;
                      setPw({ ...pw, confirm: val });
                      if (pwError.includes("match") && pw.next === val) {
                        setPwError("");
                      }
                    }}
                    onBlur={() => {
                      if (pw.confirm && pw.confirm !== pw.next) {
                        setPwError("New passwords do not match - check the confirmation field.");
                      }
                    }}
                    required
                    autoComplete="new-password"
                    style={{ height: "36px", width: "100%", paddingRight: "36px" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw({ ...showPw, confirm: !showPw.confirm })}
                    style={toggleBtnStyle}
                    aria-label={showPw.confirm ? "Hide password" : "Show password"}
                  >
                    {showPw.confirm ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
              
              <button type="submit" className="self-start mt-2">
                <KeyRound size={15} /> Update password
              </button>
              {pwError && <p className="error-box" role="alert" style={{ marginTop: "var(--space-2)" }}>{pwError}</p>}
            </form>
          </section>

        </div>

        {!isOwner && (
          <p className="muted small" style={{ marginTop: "var(--space-2)" }}>
            Staff management and device registry are visible to OWNER accounts only.
          </p>
        )}

        {isOwner && (
          <div className="flex flex-col gap-4 mt-4">
            
            {/* IOT DEVICE REGISTRY */}
            <section className="panel" style={{ padding: "var(--space-5)" }}>
              <div className="flex items-center justify-between" style={{ marginBottom: "var(--space-4)" }}>
                <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>IoT device registry</h3>
                <button className="ghost small-btn" onClick={loadOwnerData}>
                  <RefreshCw size={13} /> Refresh
                </button>
              </div>
              <div className="table-wrap">
                <table className="data table-fixed">
                  <thead>
                    <tr>
                      <th style={{ width: 200 }}>Device ID</th>
                      <th style={{ width: 140 }}>Cart</th>
                      <th style={{ width: 140 }}>Status</th>
                      <th>Last heartbeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => (
                      <tr key={d.id}>
                        <td><strong>{d.device_id}</strong></td>
                        <td><Badge variant="info">{d.cart}</Badge></td>
                        <td>
                          <Badge variant={d.online ? "ok" : "neutral"}>
                            {d.active ? (d.online ? "ONLINE" : "IDLE") : "DISABLED"}
                          </Badge>
                        </td>
                        <td className="muted small">
                          {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never"}
                        </td>
                      </tr>
                    ))}
                    {devices.length === 0 && (
                      <tr>
                        <td colSpan="4" className="muted t-center" style={{ padding: "var(--space-4)" }}>No devices registered.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="muted small" style={{ marginTop: "var(--space-3)" }}>
                ONLINE = heard from the node in the last 5 minutes. Run <code>iot/simulator.mjs</code> to bring nodes online.
              </p>
            </section>

            {/* STAFF ACCOUNTS */}
            <section className="panel" style={{ padding: "var(--space-5)" }}>
              <div className="flex items-center justify-between" style={{ marginBottom: "var(--space-4)" }}>
                <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>Staff accounts</h3>
                <button onClick={() => { setStaffError(""); setAddOpen(true); setShowNewStaffPw(false); }}>
                  <Plus size={15} /> Add staff
                </button>
              </div>
              <div className="table-wrap">
                <table className="data table-fixed">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th style={{ width: 160 }}>Username</th>
                      {/* Tinanggal ang Role Column dito */}
                      <th style={{ width: 120 }}>Cart</th>
                      <th style={{ width: 140 }}>RFID UID</th>
                      <th style={{ width: 120 }}>Status</th>
                      <th className="t-right" style={{ width: 220 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Nilagyan ng filter para hindi na ipakita ang OWNER */}
                    {staff.filter((s) => s.role !== "OWNER").map((s) => (
                      <tr key={s.id} className={!s.active ? "row-disabled" : undefined}>
                        <td><strong>{s.name}</strong></td>
                        <td>{s.username}</td>
                        {/* Tinanggal ang Role Column value dito */}
                        <td>{s.location ? s.location.code : "-"}</td>
                        <td className="muted small">{s.rfidUid ?? "-"}</td>
                        <td>
                          <Badge variant={s.active ? "ok" : "danger"}>
                            {s.active ? "ACTIVE" : "DISABLED"}
                          </Badge>
                        </td>
                        <td className="t-right nowrap">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              className="ghost small-btn"
                              onClick={() => {
                                setResetting(s);
                                setResetPw("");
                                setResetError("");
                                setShowResetPw(false);
                              }}
                            >
                              Reset password
                            </button>
                            <button
                              className={`small-btn ${s.active ? "danger-ghost" : "ghost"}`}
                              onClick={() => setDisabling(s)}
                            >
                              {s.active ? "Disable" : "Enable"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

          </div>
        )}

        {/* MODALS */}
        
        {/* Add staff modal */}
        {addOpen && (
          <div className="modal-backdrop" onClick={() => setAddOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Add staff account</h3>
              <form onSubmit={createStaff} className="flex flex-col gap-3" style={{ marginTop: "var(--space-3)" }}>
                <label className="field">
                  Full name *
                  <input
                    required
                    value={newStaff.name}
                    onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
                    style={{ height: "36px" }}
                  />
                </label>
                <label className="field">
                  Username *
                  <input
                    required
                    value={newStaff.username}
                    onChange={(e) => setNewStaff({ ...newStaff, username: e.target.value })}
                    style={{ height: "36px" }}
                  />
                </label>
                
                {/* NEW STAFF PASSWORD */}
                <label className="field">
                  Password * (min 8)
                  <div style={{ position: "relative" }}>
                    <input
                      required
                      minLength={8}
                      type={showNewStaffPw ? "text" : "password"}
                      value={newStaff.password}
                      onChange={(e) => setNewStaff({ ...newStaff, password: e.target.value })}
                      autoComplete="new-password"
                      style={{ height: "36px", width: "100%", paddingRight: "36px" }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewStaffPw(!showNewStaffPw)}
                      style={toggleBtnStyle}
                      aria-label={showNewStaffPw ? "Hide password" : "Show password"}
                    >
                      {showNewStaffPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <PasswordStrengthMeter value={newStaff.password} minLevel="fair" />
                </label>
                
                <label className="field">
                  Cart assignment
                  <Select
                    value={newStaff.locationCode}
                    onChange={(val) => setNewStaff({ ...newStaff, locationCode: val })}
                    options={locationOptions}
                    placeholder="Select cart..."
                  />
                </label>
                <label className="field">
                  RFID UID (optional)
                  <input
                    placeholder="e.g. 04A2B3C4"
                    value={newStaff.rfidUid}
                    onChange={(e) => setNewStaff({ ...newStaff, rfidUid: e.target.value })}
                    style={{ height: "36px" }}
                  />
                </label>
                <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
                  <button type="button" className="ghost" onClick={() => setAddOpen(false)}>
                    Cancel
                  </button>
                  <button type="submit">Create account</button>
                </div>
                {staffError && <p className="error-box" role="alert">{staffError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* Reset password modal */}
        {resetting && (
          <div className="modal-backdrop" onClick={() => setResetting(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Reset password - {resetting.username}</h3>
              
              {/* RESET PASSWORD */}
              <label className="field" style={{ marginTop: "var(--space-3)" }}>
                New temporary password
                <div style={{ position: "relative" }}>
                  <input
                    autoFocus
                    type={showResetPw ? "text" : "password"}
                    value={resetPw}
                    onChange={(e) => setResetPw(e.target.value)}
                    placeholder="min 8 characters"
                    style={{ height: "36px", width: "100%", marginBottom: "4px", paddingRight: "36px" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowResetPw(!showResetPw)}
                    style={toggleBtnStyle}
                    aria-label={showResetPw ? "Hide password" : "Show password"}
                  >
                    {showResetPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <PasswordStrengthMeter value={resetPw} minLevel="fair" />
              </label>
              
              <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
                <button className="ghost" onClick={() => setResetting(null)}>Cancel</button>
                <button onClick={doResetPassword}>Save new password</button>
              </div>
              {resetError && <p className="error-box" role="alert">{resetError}</p>}
            </div>
          </div>
        )}

        {/* Disable/enable confirmation */}
        <ConfirmDialog
          open={Boolean(disabling)}
          title={disabling?.active ? "Disable account?" : "Enable account?"}
          message={
            disabling?.active
              ? `"${disabling?.username}" will no longer be able to log in. Their sales history is kept.`
              : `"${disabling?.username}" will regain POS access immediately.`
          }
          confirmLabel={disabling?.active ? "Disable" : "Enable"}
          danger={Boolean(disabling?.active)}
          onConfirm={() => toggleActive(disabling)}
          onCancel={() => setDisabling(null)}
        />
      </div>
    </PageErrorBoundary>
  );
}