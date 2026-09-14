import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { KeyRound, Plus, RefreshCw, Eye, EyeOff, Edit2, Trash2, Cpu } from "lucide-react";
import api, { getErrorMessage } from "../api.js";
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
  const [profileError, setProfileError] = useState("");
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  
  const [devices, setDevices] = useState([]);
  const [staff, setStaff] = useState([]);
  const [locations, setLocations] = useState([]);
  
  // -- STAFF STATES --
  const [addOpen, setAddOpen] = useState(false);
  const [addClosing, setAddClosing] = useState(false);
  
  const [resetting, setResetting] = useState(null);
  const [resetClosing, setResetClosing] = useState(false);
  const [resetPw, setResetPw] = useState("");
  
  const [disabling, setDisabling] = useState(null);
  
  const [staffEditing, setStaffEditing] = useState(null);
  const [staffEditClosing, setStaffEditClosing] = useState(false);
  const [isStaffEditing, setIsStaffEditing] = useState(false);

  const [pwError, setPwError] = useState("");
  const [staffError, setStaffError] = useState("");
  const [resetError, setResetError] = useState("");
  
  const [showPw, setShowPw] = useState({ current: false, next: false, confirm: false });
  const [showNewStaffPw, setShowNewStaffPw] = useState(false);
  const [showResetPw, setShowResetPw] = useState(false);
  
  const [newStaff, setNewStaff] = useState({
    name: "",
    username: "",
    password: "",
    locationCode: "",
    rfidUid: "",
  });

  // -- IOT DEVICE STATES --
  const [deviceAddOpen, setDeviceAddOpen] = useState(false);
  const [deviceAddClosing, setDeviceAddClosing] = useState(false);
  const [isDeviceAdding, setIsDeviceAdding] = useState(false);
  const [deviceError, setDeviceError] = useState("");
  const [newDevice, setNewDevice] = useState({ deviceId: "", locationCode: "" });

  const [deviceEditing, setDeviceEditing] = useState(null);
  const [deviceEditClosing, setDeviceEditClosing] = useState(false);
  const [isDeviceEditing, setIsDeviceEditing] = useState(false);
  const [deviceDeleting, setDeviceDeleting] = useState(null);

  // Modal Closers
  function closeAddModal() {
    setAddClosing(true);
    setTimeout(() => { setAddOpen(false); setAddClosing(false); }, 150);
  }
  function closeResetModal() {
    setResetClosing(true);
    setTimeout(() => { setResetting(null); setResetClosing(false); }, 150);
  }
  function closeStaffEditModal() {
    setStaffEditClosing(true);
    setTimeout(() => { setStaffEditing(null); setStaffEditClosing(false); }, 150);
  }
  function closeDeviceAddModal() {
    setDeviceAddClosing(true);
    setTimeout(() => { setDeviceAddOpen(false); setDeviceAddClosing(false); }, 150);
  }
  function closeDeviceEditModal() {
    setDeviceEditClosing(true);
    setTimeout(() => { setDeviceEditing(null); setDeviceEditClosing(false); }, 150);
  }

  // Background Scroll Lock
  const isAnyModalOpen = 
    addOpen || addClosing || 
    resetting || resetClosing || 
    Boolean(disabling) || 
    staffEditing || staffEditClosing ||
    deviceAddOpen || deviceAddClosing ||
    deviceEditing || deviceEditClosing ||
    Boolean(deviceDeleting);

  useEffect(() => {
    if (isAnyModalOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [isAnyModalOpen]);

  function loadOwnerData() {
    if (!isOwner) return;
    api.get("/devices").then(({ data }) => setDevices(data?.data ?? [])).catch(() => {});
    api.get("/auth/staff").then(({ data }) => setStaff(data?.data ?? [])).catch(() => {});
  }

  function loadProfile() {
    setProfileError("");
    api.get("/auth/me").then(({ data }) => setProfile(data?.user ?? null)).catch(() => {
      setProfileError("Unable to load profile.");
    });
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional init: profile + catalog defaults on mount/role change
    loadProfile();
    api.get("/catalog").then(({ data }) => {
      const locs = data?.locations ?? [];
      setLocations(locs);
      if (locs.length > 0) {
        setNewStaff((prev) => ({ ...prev, locationCode: locs[0].code }));
        setNewDevice((prev) => ({ ...prev, locationCode: locs[0].code }));
      }
    }).catch(() => {});
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
      setShowPw({ current: false, next: false, confirm: false });
    } catch (err) {
      setPwError(getErrorMessage(err, "Change failed - is the current password correct?"));
    }
  }

  // --- STAFF ACTIONS ---
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
      closeAddModal();
      setNewStaff({ name: "", username: "", password: "", locationCode: safeLocations[0]?.code || "", rfidUid: "" });
      setShowNewStaffPw(false);
      loadOwnerData();
    } catch (err) {
      setStaffError(getErrorMessage(err, "Create failed - is the username or RFID already taken?"));
    }
  }

  async function handleEditStaff(e) {
    e.preventDefault();
    setStaffError("");
    setIsStaffEditing(true);
    try {
      await api.patch(`/auth/staff/${staffEditing.id}`, {
        name: staffEditing.name,
        username: staffEditing.username,
        locationCode: staffEditing.location?.code || null,
        rfidUid: staffEditing.rfidUid || null
      });
      toast(`Staff account "${staffEditing.username}" updated`, "success");
      closeStaffEditModal();
      loadOwnerData();
    } catch (err) {
      setStaffError(getErrorMessage(err, "Update failed - username or RFID may already exist."));
    } finally {
      setIsStaffEditing(false);
    }
  }

  async function toggleActive(s) {
    try {
      await api.patch(`/auth/staff/${s.id}`, { active: !s.active });
      toast(`${s.username} ${s.active ? "disabled" : "enabled"}`, "success");
      loadOwnerData();
    } catch (err) {
      toast(getErrorMessage(err, "Update failed"), "error");
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
      closeResetModal();
      setResetPw("");
      setShowResetPw(false);
    } catch (err) {
      setResetError(getErrorMessage(err, "Reset failed - try again."));
    }
  }

  // --- IOT DEVICE ACTIONS (gawa niya) ---
  async function handleAddDevice(e) {
    e.preventDefault();
    setDeviceError("");
    setIsDeviceAdding(true);
    try {
      await api.post("/devices", {
        deviceId: newDevice.deviceId,
        cart: newDevice.locationCode
      });
      toast(`Device ${newDevice.deviceId} registered`, "success");
      closeDeviceAddModal();
      setNewDevice({ deviceId: "", locationCode: safeLocations[0]?.code || "" });
      loadOwnerData();
    } catch (err) {
      setDeviceError(getErrorMessage(err, "Registration failed. Device ID may already exist."));
    } finally {
      setIsDeviceAdding(false);
    }
  }

  const safeLocations = Array.isArray(locations) ? locations : [];
  const safeDevices = Array.isArray(devices) ? devices : [];
  const safeStaff = Array.isArray(staff) ? staff : [];
  const locationOptions = safeLocations.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }));

  async function handleEditDevice(e) {
    e.preventDefault();
    setDeviceError("");
    setIsDeviceEditing(true);
    try {
      await api.patch(`/devices/${deviceEditing.id}`, {
        cart: deviceEditing.cart,
        active: deviceEditing.active
      });
      toast(`Device reassigned successfully`, "success");
      closeDeviceEditModal();
      loadOwnerData();
    } catch (err) {
      setDeviceError(getErrorMessage(err, "Update failed."));
    } finally {
      setIsDeviceEditing(false);
    }
  }

  async function handleDeleteDevice() {
    if (!deviceDeleting) return;
    try {
      await api.del(`/devices/${deviceDeleting.id}`);
      toast(`Device ${deviceDeleting.device_id} deleted`, "success");
      loadOwnerData();
    } catch (err) {
      toast(getErrorMessage(err, "Failed to delete device"), "error");
    } finally {
      setDeviceDeleting(null);
    }
  }

  // (duplicate locationOptions removed — safe version above is used)
  
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
              profileError ? (
                <div className="error-box" role="alert">
                  {profileError}{" "}
                  <button type="button" className="linklike" onClick={loadProfile}>
                    Retry
                  </button>
                </div>
              ) : (
                <Skeleton rows={3} />
              )
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
                <div className="flex items-center gap-2">
                  <button className="ghost small-btn" onClick={loadOwnerData}>
                    <RefreshCw size={13} /> Refresh
                  </button>
                  <button className="small-btn" onClick={() => { setDeviceError(""); setDeviceAddOpen(true); }}>
                    <Plus size={13} /> Register Device
                  </button>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data table-fixed">
                  <thead>
                    <tr>
                      <th style={{ width: 200 }}>Device ID</th>
                      <th style={{ width: 140 }}>Cart</th>
                      <th style={{ width: 140 }}>Status</th>
                      <th>Last heartbeat</th>
                      <th className="t-center" style={{ width: 140 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {safeDevices.map((d) => (
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
                        <td className="t-center nowrap">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              className="ghost small-btn"
                              onClick={() => { setDeviceEditing(d); setDeviceError(""); }}
                              title="Edit/Reassign Device"
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              className="danger-ghost small-btn"
                              onClick={() => setDeviceDeleting(d)}
                              title="Delete Device"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {safeDevices.length === 0 && (
                      <tr>
                        <td colSpan="5" className="muted t-center" style={{ padding: "var(--space-4)" }}>No devices registered.</td>
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
                      <th style={{ width: 120 }}>Cart</th>
                      <th style={{ width: 140 }}>RFID UID</th>
                      <th style={{ width: 120 }}>Status</th>
                      <th className="t-center" style={{ width: 220 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Nilagyan ng filter para hindi na ipakita ang OWNER */}
                    {safeStaff.filter((s) => s.role !== "OWNER").map((s) => (
                      <tr key={s.id} className={!s.active ? "row-disabled" : undefined}>
                        <td><strong>{s.name}</strong></td>
                        <td>{s.username}</td>
                        <td>{s.location ? s.location.code : "-"}</td>
                        <td className="muted small">{s.rfidUid ?? "-"}</td>
                        <td>
                          <Badge variant={s.active ? "ok" : "danger"}>
                            {s.active ? "ACTIVE" : "DISABLED"}
                          </Badge>
                        </td>
                        <td className="t-center nowrap">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              className="ghost small-btn"
                              onClick={() => { setStaffEditing({...s}); setStaffError(""); }}
                              title="Edit Staff Details"
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              className="ghost small-btn"
                              onClick={() => {
                                setResetting(s);
                                setResetPw("");
                                setResetError("");
                                setShowResetPw(false);
                              }}
                              title="Reset Password"
                            >
                              <KeyRound size={13} />
                            </button>
                            <button
                              className={`small-btn ${s.active ? "danger-ghost" : "ghost"}`}
                              onClick={() => setDisabling(s)}
                              title={s.active ? "Disable" : "Enable"}
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

        {/* --- MODALS --- */}
        
        {/* ADD STAFF MODAL */}
        {(addOpen || addClosing) && (
          <div className={`modal-backdrop ${addClosing ? "is-closing" : ""}`}>
            <div className={`modal ${addClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
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
                  <button type="button" className="ghost" onClick={closeAddModal} disabled={addClosing}>
                    Cancel
                  </button>
                  <button type="submit" disabled={addClosing}>Create account</button>
                </div>
                {staffError && <p className="error-box" role="alert">{staffError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* EDIT STAFF MODAL */}
        {(staffEditing || staffEditClosing) && (
          <div className={`modal-backdrop ${staffEditClosing ? "is-closing" : ""}`}>
            <div className={`modal ${staffEditClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted"/> Edit Staff Account</h3>
              <form onSubmit={handleEditStaff} className="flex flex-col gap-3" style={{ marginTop: "var(--space-3)" }}>
                <label className="field">
                  Full name *
                  <input
                    required
                    value={staffEditing?.name || ""}
                    onChange={(e) => setStaffEditing({ ...staffEditing, name: e.target.value })}
                    style={{ height: "36px" }}
                  />
                </label>
                <label className="field">
                  Username *
                  <input
                    required
                    value={staffEditing?.username || ""}
                    onChange={(e) => setStaffEditing({ ...staffEditing, username: e.target.value })}
                    style={{ height: "36px" }}
                  />
                </label>
                
                <label className="field">
                  Cart assignment
                  <Select
                    value={staffEditing?.location?.code || ""}
                    onChange={(val) => setStaffEditing({ ...staffEditing, location: { code: val } })}
                    options={locationOptions}
                    placeholder="Select cart..."
                  />
                </label>
                <label className="field">
                  RFID UID (optional)
                  <input
                    placeholder="e.g. 04A2B3C4"
                    value={staffEditing?.rfidUid || ""}
                    onChange={(e) => setStaffEditing({ ...staffEditing, rfidUid: e.target.value })}
                    style={{ height: "36px" }}
                  />
                </label>
                <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
                  <button type="button" className="ghost" onClick={closeStaffEditModal} disabled={isStaffEditing || staffEditClosing}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isStaffEditing || staffEditClosing}>
                    {isStaffEditing ? "Saving..." : "Save Changes"}
                  </button>
                </div>
                {staffError && <p className="error-box" role="alert">{staffError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* RESET PASSWORD MODAL */}
        {(resetting || resetClosing) && (
          <div className={`modal-backdrop ${resetClosing ? "is-closing" : ""}`}>
            <div className={`modal ${resetClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3>Reset password - {resetting?.username}</h3>
              
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
                <button className="ghost" onClick={closeResetModal} disabled={resetClosing}>Cancel</button>
                <button onClick={doResetPassword} disabled={resetClosing}>Save new password</button>
              </div>
              {resetError && <p className="error-box" role="alert">{resetError}</p>}
            </div>
          </div>
        )}

        {/* DISABLE/ENABLE STAFF CONFIRMATION */}
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

        {/* ADD IOT DEVICE MODAL */}
        {(deviceAddOpen || deviceAddClosing) && (
          <div className={`modal-backdrop ${deviceAddClosing ? "is-closing" : ""}`}>
            <div className={`modal ${deviceAddClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Cpu size={22} className="muted"/> Register IoT Device</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Add a new ESP32 Node device and assign it to a cart.
              </p>
              <form onSubmit={handleAddDevice} className="flex flex-col gap-3">
                <label className="field">
                  Device ID (e.g. ESP32-A1B2) *
                  <input
                    required
                    value={newDevice.deviceId}
                    onChange={(e) => setNewDevice({ ...newDevice, deviceId: e.target.value })}
                    style={{ height: "36px" }}
                    placeholder="Enter unique hardware ID"
                  />
                </label>
                <label className="field">
                  Cart assignment
                  <Select
                    value={newDevice.locationCode}
                    onChange={(val) => setNewDevice({ ...newDevice, locationCode: val })}
                    options={locationOptions}
                    placeholder="Assign to cart..."
                  />
                </label>
                <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
                  <button type="button" className="ghost" onClick={closeDeviceAddModal} disabled={isDeviceAdding || deviceAddClosing}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isDeviceAdding || deviceAddClosing}>
                    {isDeviceAdding ? "Registering..." : "Register Device"}
                  </button>
                </div>
                {deviceError && <p className="error-box" role="alert">{deviceError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* EDIT IOT DEVICE MODAL */}
        {(deviceEditing || deviceEditClosing) && (
          <div className={`modal-backdrop ${deviceEditClosing ? "is-closing" : ""}`}>
            <div className={`modal ${deviceEditClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted"/> Edit Device - {deviceEditing?.device_id}</h3>
              <form onSubmit={handleEditDevice} className="flex flex-col gap-3" style={{ marginTop: "var(--space-3)" }}>
                <label className="field">
                  Cart assignment
                  <Select
                    value={deviceEditing?.cart || ""}
                    onChange={(val) => setDeviceEditing({ ...deviceEditing, cart: val })}
                    options={locationOptions}
                    placeholder="Assign to cart..."
                  />
                </label>
                <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={deviceEditing?.active || false}
                    onChange={(e) => setDeviceEditing({ ...deviceEditing, active: e.target.checked })}
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  Device is active
                </label>
                <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
                  <button type="button" className="ghost" onClick={closeDeviceEditModal} disabled={isDeviceEditing || deviceEditClosing}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isDeviceEditing || deviceEditClosing}>
                    {isDeviceEditing ? "Saving..." : "Save Changes"}
                  </button>
                </div>
                {deviceError && <p className="error-box" role="alert">{deviceError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* DELETE IOT DEVICE CONFIRMATION */}
        <ConfirmDialog
          open={Boolean(deviceDeleting)}
          title="Delete IoT Device?"
          message={`Are you sure you want to unregister device "${deviceDeleting?.device_id}"? This will stop it from syncing data to the system.`}
          confirmLabel="Delete Device"
          danger={true}
          onConfirm={handleDeleteDevice}
          onCancel={() => setDeviceDeleting(null)}
        />
        
      </div>
    </PageErrorBoundary>
  );
}