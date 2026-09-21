import { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { KeyRound, Plus, RefreshCw, Eye, EyeOff, Edit2, Trash2, Cpu, ShoppingCart, Users } from "lucide-react";

import api from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import Badge from "../components/Badge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import Skeleton from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import PasswordStrengthMeter from "../components/PasswordStrengthMeter.jsx";
import { useToast } from "../components/Toast.jsx";
import Select from "../components/Select.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { sanitizeTextInput, countLetters } from "../utils/text.js";

export default function SettingsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";

  const [profile, setProfile] = useState(user ?? null);
  const [profileError, setProfileError] = useState("");

  const [ownerError, setOwnerError] = useState([]);
  const [isLoadingOwner, setIsLoadingOwner] = useState(true);

  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });

  const [devices, setDevices] = useState([]);
  const [staff, setStaff] = useState([]);
  const [locations, setLocations] = useState([]);

  // -- STAFF STATES --
  const [addOpen, setAddOpen] = useState(false);
  const [addClosing, setAddClosing] = useState(false);
  const [isStaffAdding, setIsStaffAdding] = useState(false);

  const [resetting, setResetting] = useState(null);
  const [resetClosing, setResetClosing] = useState(false);
  const [resetPw, setResetPw] = useState("");
  const [isResetting, setIsResetting] = useState(false);

  const [disabling, setDisabling] = useState(null);
  const [isDisabling, setIsDisabling] = useState(false);

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
  const [isDeviceDeleting, setIsDeviceDeleting] = useState(false);

  // -- CART STATES --
  const [carts, setCarts] = useState([]);
  const [cartAddOpen, setCartAddOpen] = useState(false);
  const [cartAddClosing, setCartAddClosing] = useState(false);
  const [isCartAdding, setIsCartAdding] = useState(false);
  const [cartError, setCartError] = useState("");
  const [newCart, setNewCart] = useState({ code: "", name: "", address: "", seedInventory: true });
  
  const [cartToken, setCartToken] = useState(null);
  const [cartTokenCopied, setCartTokenCopied] = useState(false);
  const [deviceToken, setDeviceToken] = useState(null);
  const [deviceTokenCopied, setDeviceTokenCopied] = useState(false);

  const [cartEditing, setCartEditing] = useState(null);
  const [cartEditClosing, setCartEditClosing] = useState(false);
  const [isCartEditing, setIsCartEditing] = useState(false);

  const [cartToggling, setCartToggling] = useState(null);
  const [isCartToggling, setIsCartToggling] = useState(false);

  const [isChanging, setIsChanging] = useState(false);

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
  function closeCartAddModal() {
    setCartAddClosing(true);
    setTimeout(() => { setCartAddOpen(false); setCartAddClosing(false); }, 150);
  }
  function closeCartEditModal() {
    setCartEditClosing(true);
    setTimeout(() => { setCartEditing(null); setCartEditClosing(false); }, 150);
  }

  // Background Scroll Lock
  const isAnyModalOpen = 
    addOpen || addClosing || 
    resetting || resetClosing || 
    Boolean(disabling) || 
    staffEditing || staffEditClosing ||
    deviceAddOpen || deviceAddClosing ||
    deviceEditing || deviceEditClosing ||
    Boolean(deviceDeleting) ||
    cartAddOpen || cartAddClosing ||
    Boolean(cartToken) ||
    Boolean(deviceToken) ||
    cartEditing || cartEditClosing ||
    Boolean(cartToggling);

  useEffect(() => {
    if (isAnyModalOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [isAnyModalOpen]);

  function loadOwnerData() {
    if (!isOwner) return;
    setIsLoadingOwner(true);
    setOwnerError([]);
    
    const track = (key, promise, apply) => {
      return promise.then(apply).catch(() => {
        setOwnerError((prev) => (prev.includes(key) ? prev : [...prev, key]));
      });
    };

    Promise.all([
      track("devices", api.get("/devices"), ({ data }) => setDevices(data?.data ?? [])),
      track("staff", api.get("/auth/staff"), ({ data }) => setStaff(data?.data ?? [])),
      track("carts", api.get("/locations"), ({ data }) => setCarts(data?.data ?? []))
    ]).finally(() => {
      setIsLoadingOwner(false);
    });
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
    if (isChanging) return;

    setIsChanging(true);
    try {
      await api.post("/auth/change-password", {
        currentPassword: pw.current,
        newPassword: pw.next,
      });
      localStorage.removeItem("cartiq_token");
      localStorage.removeItem("cartiq_refresh_token");
      toast("Password updated - please log in again", "success");
      navigate("/login", { replace: true });
    } catch (err) {
      setPwError(getFriendlyError(err, "Change failed - is the current password correct?"));
    } finally {
      setIsChanging(false);
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
    if (isStaffAdding) return;

    setIsStaffAdding(true);
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
      setStaffError(getFriendlyError(err, "Create failed - is the username or RFID already taken?"));
    } finally {
      setIsStaffAdding(false);
    }
  }

  async function handleEditStaff(e) {
    e.preventDefault();
    setStaffError("");
    
    const original = staff.find((s) => s.id === staffEditing.id);
    if (
      original &&
      staffEditing.name === original.name &&
      (staffEditing.location?.code || null) === (original.location?.code || null) &&
      (staffEditing.rfidUid || null) === (original.rfidUid || null)
    ) {
      toast("No changes - staff details are already up to date.", "info");
      closeStaffEditModal();
      return;
    }

    setIsStaffEditing(true);
    try {
      await api.patch(`/auth/staff/${staffEditing.id}`, {
        name: staffEditing.name,
        locationCode: staffEditing.location?.code || null,
        rfidUid: staffEditing.rfidUid || null
      });
      
      toast(`Staff account "${staffEditing.username}" updated`, "success");
      closeStaffEditModal();
      loadOwnerData();
    } catch (err) {
      setStaffError(getFriendlyError(err, "Update failed - username or RFID may already exist."));
    } finally {
      setIsStaffEditing(false);
    }
  }

  async function toggleActive(s) {
    if (isDisabling) return;
    setIsDisabling(true);
    try {
      await api.patch(`/auth/staff/${s.id}`, { active: !s.active });
      toast(`${s.username} ${s.active ? "disabled" : "enabled"}`, "success");
      loadOwnerData();
    } catch (err) {
      toast(getFriendlyError(err, "Update failed"), "error");
    } finally {
      setIsDisabling(false);
    }
    setDisabling(null);
  }

  async function doResetPassword() {
    if (!resetting || isResetting) return;
    if (resetPw.length < 8) {
      setResetError("New password must be at least 8 characters.");
      return;
    }
    setResetError("");
    setIsResetting(true);
    try {
      await api.patch(`/auth/staff/${resetting.id}`, { password: resetPw });
      toast(`Password reset for ${resetting.username}`, "success");
      closeResetModal();
      setResetPw("");
      setShowResetPw(false);
    } catch (err) {
      setResetError(getFriendlyError(err, "Reset failed - try again."));
    } finally {
      setIsResetting(false);
    }
  }

  // --- IOT DEVICE ACTIONS ---
  async function handleAddDevice(e) {
    e.preventDefault();
    setDeviceError("");
    setIsDeviceAdding(true);
    try {
      const res = await api.post("/devices", {
        deviceId: newDevice.deviceId,
        cart: newDevice.locationCode
      });
      closeDeviceAddModal();
      setNewDevice({ deviceId: "", locationCode: safeLocations[0]?.code || "" });
      
      setDeviceToken({ deviceId: newDevice.deviceId, token: res.data?.deviceToken });
      setDeviceTokenCopied(false);

      toast(`Device ${newDevice.deviceId} registered`, "success");
      loadOwnerData();
    } catch (err) {
      setDeviceError(getFriendlyError(err, "Registration failed. Device ID may already exist."));
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
      setDeviceError(getFriendlyError(err, "Update failed."));
    } finally {
      setIsDeviceEditing(false);
    }
  }

  async function handleDeleteDevice() {
    if (!deviceDeleting || isDeviceDeleting) return;
    setIsDeviceDeleting(true);
    try {
      await api.del(`/devices/${deviceDeleting.id}`);
      toast(`Device ${deviceDeleting.device_id} deleted`, "success");
      loadOwnerData();
    } catch (err) {
      toast(getFriendlyError(err, "Failed to delete device"), "error");
    } finally {
      setIsDeviceDeleting(false);
      setDeviceDeleting(null);
    }
  }

  // --- CART ACTIONS (OWNER) ---
  function sanitizeCartCode(v) {
    return String(v ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
  }

  async function createCart(e) {
    e.preventDefault();
    setCartError("");
    
    const code = sanitizeCartCode(newCart.code);
    if (!/^[A-Z0-9-]{3,12}$/.test(code)) {
      setCartError("Code must be 3-12 chars: A-Z, 0-9, dash (e.g. CART-04).");
      return;
    }

    const name = sanitizeTextInput(newCart.name, 120).trim();
    if (name.length < 2 || countLetters(name) < 2) {
      setCartError("Name needs at least 2 letters.");
      return;
    }

    setIsCartAdding(true);
    try {
      const { data } = await api.post("/locations", {
        code,
        name,
        address: newCart.address.trim() || null,
        seedInventory: newCart.seedInventory,
      });
      toast(`Cart ${code} created with starter inventory`, "success");
      closeCartAddModal();
      setNewCart({ code: "", name: "", address: "", seedInventory: true });
      
      setCartTokenCopied(false);
      setCartToken({ code, deviceId: data?.device?.deviceId ?? "", token: data?.deviceToken ?? "" });
      loadOwnerData();
    } catch (err) {
      setCartError(getFriendlyError(err, "Create failed - is the code already taken?"));
    } finally {
      setIsCartAdding(false);
    }
  }

  async function copyCartToken() {
    if (!cartToken?.token) return;
    try {
      await navigator.clipboard.writeText(cartToken.token);
      setCartTokenCopied(true);
      toast("Device token copied", "success");
    } catch {
      toast("Copy failed - select the token manually.", "error");
    }
  }

  async function copyDeviceToken() {
    if (!deviceToken?.token) return;
    try {
      await navigator.clipboard.writeText(deviceToken.token);
      setDeviceTokenCopied(true);
      toast("Device token copied", "success");
    } catch {
      toast("Copy failed - select the token manually.", "error");
    }
  }

  async function handleEditCart(e) {
    e.preventDefault();
    setCartError("");
    
    const name = sanitizeTextInput(cartEditing.name, 120).trim();
    const address = sanitizeTextInput(cartEditing.address ?? "", 200).trim();
    const original = carts.find((c) => c.id === cartEditing.id);

    if (name.length < 2 || countLetters(name) < 2) {
      setCartError("Name needs at least 2 letters.");
      return;
    }

    if (original && name === original.name && (address || "") === (original.address || "")) {
      toast("No changes - nothing to update on this cart.", "info");
      closeCartEditModal();
      return;
    }

    setIsCartEditing(true);
    try {
      await api.patch(`/locations/${cartEditing.id}`, {
        name,
        address: address || null,
      });
      toast(`Cart ${original?.code ?? ""} updated`, "success");
      closeCartEditModal();
      loadOwnerData();
    } catch (err) {
      setCartError(getFriendlyError(err, "Update failed."));
    } finally {
      setIsCartEditing(false);
    }
  }

  async function toggleCart() {
    if (!cartToggling || isCartToggling) return;
    setIsCartToggling(true);
    
    const toInactive = cartToggling.status !== "INACTIVE";
    try {
      await api.patch(`/locations/${cartToggling.id}`, {
        status: toInactive ? "INACTIVE" : "ACTIVE",
      });
      toast(`Cart ${cartToggling.code} ${toInactive ? "deactivated" : "reactivated"}`, "success");
      loadOwnerData();
    } catch (err) {
      toast(getFriendlyError(err, "Update failed"), "error");
    } finally {
      setIsCartToggling(false);
      setCartToggling(null);
    }
  }

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
          sub="Your profile, password, carts, devices, and staff accounts."
        />
        
        <div className="settings-grid" style={{ gap: "var(--space-4)", alignItems: "stretch" }}>
          
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
            
            {!profile && !profileError ? (
              <div className="flex flex-col gap-3">
                <Skeleton rows={4} height={36} />
              </div>
            ) : (
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
                
                <button type="submit" className="self-start mt-2" disabled={isChanging}>
                  <KeyRound size={15} /> {isChanging ? "Updating..." : "Update password"}
                </button>
                
                {pwError && <p className="error-box" role="alert" style={{ marginTop: "var(--space-2)" }}>{pwError}</p>}
              </form>
            )}
          </section>

        </div>

        {!isOwner && (
          <p className="muted small" style={{ marginTop: "var(--space-2)" }}>
            Staff management and device registry are visible to OWNER accounts only.
          </p>
        )}

        {isOwner && (
          <div className="flex flex-col gap-4 mt-4">
            
            {ownerError.length > 0 && (
              <div className="error-box" role="alert">
                <span>Could not load {ownerError.join(", ")}. Showing cached data.</span>
                <button className="ghost" onClick={loadOwnerData}>Retry</button>
              </div>
            )}

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
              
              {isLoadingOwner ? (
                <div style={{ marginTop: "var(--space-4)" }}>
                  <Skeleton rows={4} height={40} />
                </div>
              ) : safeDevices.length === 0 ? (
                <EmptyState
                  icon={Cpu}
                  title="No devices registered"
                  subtitle="Register an ESP32 node to start syncing live data."
                  compact
                />
              ) : (
                <div className="table-wrap">
                  <table className="data table-fixed">
                    <thead>
                      <tr>
                        <th style={{ width: 180 }}>Device ID</th>
                        <th style={{ width: 120 }}>Cart</th>
                        <th style={{ width: 110 }}>Status</th>
                        <th style={{ width: 240 }}>Last heartbeat</th>
                        <th className="t-center" style={{ width: 160 }}>Actions</th>
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
                    </tbody>
                  </table>
                </div>
              )}
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

              {isLoadingOwner ? (
                <div style={{ marginTop: "var(--space-4)" }}>
                  <Skeleton rows={4} height={40} />
                </div>
              ) : safeStaff.filter((s) => s.role !== "OWNER").length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="No staff accounts"
                  subtitle="Add staff members to give them POS access."
                  compact
                />
              ) : (
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
              )}
            </section>

            <section className="panel" style={{ padding: "var(--space-5)" }}>
              <div className="flex items-center justify-between" style={{ marginBottom: "var(--space-4)" }}>
                <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>Carts</h3>
                <button onClick={() => { setCartError(""); setCartAddOpen(true); }}>
                  <Plus size={15} /> Add cart
                </button>
              </div>

              {isLoadingOwner ? (
                <div style={{ marginTop: "var(--space-4)" }}>
                  <Skeleton rows={4} height={40} />
                </div>
              ) : carts.length === 0 ? (
                <EmptyState
                  icon={ShoppingCart}
                  title="No carts yet"
                  subtitle="Provision a cart to start tracking sales and inventory."
                  compact
                />
              ) : (
                <div className="table-wrap">
                  <table className="data table-fixed">
                    <thead>
                      <tr>
                        <th style={{ width: 130 }}>Code</th>
                        <th>Name</th>
                        <th style={{ width: 90 }}>Items</th>
                        <th style={{ width: 130 }}>Status</th>
                        <th style={{ width: 170 }}>Node</th>
                        <th className="t-center" style={{ width: 170 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {carts.map((c) => (
                        <tr key={c.id} className={c.status === "INACTIVE" ? "row-disabled" : undefined}>
                          <td><strong>{c.code}</strong></td>
                          <td>{c.name}</td>
                          <td className="muted">{c.itemCount}</td>
                          <td>
                            <Badge variant={c.status === "INACTIVE" ? "danger" : "ok"}>
                              {c.status === "INACTIVE" ? "INACTIVE" : "ACTIVE"}
                            </Badge>
                          </td>
                          <td className="muted small">
                            {c.device ? (
                              <>{c.device.deviceId} - {c.device.online ? "ONLINE" : "IDLE"}</>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="t-center nowrap">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                className="ghost small-btn"
                                onClick={() => { setCartEditing({ ...c }); setCartError(""); }}
                                title="Rename cart"
                              >
                                <Edit2 size={13} />
                              </button>
                              <button
                                className={`small-btn ${c.status === "INACTIVE" ? "ghost" : "danger-ghost"}`}
                                onClick={() => setCartToggling(c)}
                                title={c.status === "INACTIVE" ? "Reactivate" : "Deactivate"}
                              >
                                {c.status === "INACTIVE" ? "Activate" : "Deactivate"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted small" style={{ marginTop: "var(--space-3)" }}>
                INACTIVE carts disappear from the POS and filters but keep their history.
              </p>
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
                  <button type="submit" disabled={addClosing || isStaffAdding}>{isStaffAdding ? "Creating..." : "Create account"}</button>
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
                  Username (immutable - set at creation)
                  <input
                    value={staffEditing?.username || ""}
                    disabled
                    readOnly
                    style={{ height: "36px", opacity: 0.7 }}
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
                <button onClick={doResetPassword} disabled={resetClosing || isResetting}>{isResetting ? "Saving..." : "Save new password"}</button>
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
          pending={isDisabling}
          pendingLabel="Updating..."
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

        {/* ADD CART MODAL */}
        {(cartAddOpen || cartAddClosing) && (
          <div className={`modal-backdrop ${cartAddClosing ? "is-closing" : ""}`}>
            <div className={`modal ${cartAddClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Plus size={22} className="muted"/> Add Cart</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Provision a cart with starter inventory and its ESP32 device token.
              </p>
              
              <form onSubmit={createCart} className="flex flex-col gap-4">
                <label className="field">
                  Cart Code
                  <input
                    type="text"
                    required
                    minLength={3}
                    maxLength={12}
                    placeholder="e.g. CART-04"
                    title="3-12 chars: A-Z, 0-9, dash"
                    value={newCart.code}
                    onChange={(e) => setNewCart({ ...newCart, code: sanitizeCartCode(e.target.value) })}
                    autoFocus
                  />
                </label>
                
                <label className="field">
                  Cart Name
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={120}
                    placeholder="e.g. New Canteen"
                    title="Min 2 letters"
                    value={newCart.name}
                    onChange={(e) => setNewCart({ ...newCart, name: sanitizeTextInput(e.target.value, 120) })}
                  />
                </label>
                
                <label className="field">
                  Address (Optional)
                  <input
                    type="text"
                    maxLength={200}
                    placeholder="e.g. Sta. Cruz, Laguna"
                    value={newCart.address}
                    onChange={(e) => setNewCart({ ...newCart, address: sanitizeTextInput(e.target.value, 200) })}
                  />
                </label>
                
                <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={newCart.seedInventory}
                    onChange={(e) => setNewCart({ ...newCart, seedInventory: e.target.checked })}
                    style={{ width: "16px", height: "16px", cursor: "pointer" }}
                  />
                  Seed starter inventory (6 template rows)
                </label>
                
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeCartAddModal} disabled={isCartAdding || cartAddClosing}>Cancel</button>
                  <button type="submit" disabled={isCartAdding || cartAddClosing}>
                    {isCartAdding ? "Creating..." : "Create Cart"}
                  </button>
                </div>
                {cartError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{cartError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* DEVICE TOKEN ONE-SHOT */}
        {cartToken && (
          <div className="modal-backdrop">
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Cart {cartToken.code} created</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Copy the ESP32 device token now - it is stored hashed and 
                <strong> will never be shown again</strong>.
              </p>
              
              <label className="field">
                Device Token ({cartToken.deviceId})
                <input type="text" readOnly value={cartToken.token} onFocus={(e) => e.target.select()} />
              </label>
              
              <div className="modal-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={copyCartToken}
                >
                  {cartTokenCopied ? "Copied!" : "Copy token"}
                </button>
                <button type="button" onClick={() => { setCartToken(null); setCartTokenCopied(false); }}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {/* DEVICE TOKEN ONE-SHOT */}
        {deviceToken && (
          <div className="modal-backdrop">
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Device {deviceToken.deviceId} registered</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Copy the ESP32 device token now - it is stored hashed and 
                <strong> will never be shown again</strong>.
              </p>
              
              <label className="field">
                Device Token ({deviceToken.deviceId})
                <input type="text" readOnly value={deviceToken.token ?? ""} onFocus={(e) => e.target.select()} />
              </label>
              
              <div className="modal-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={copyDeviceToken}
                >
                  {deviceTokenCopied ? "Copied!" : "Copy token"}
                </button>
                <button type="button" onClick={() => { setDeviceToken(null); setDeviceTokenCopied(false); }}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {/* EDIT CART MODAL */}
        {(cartEditing || cartEditClosing) && (
          <div className={`modal-backdrop ${cartEditClosing ? "is-closing" : ""}`}>
            <div className={`modal ${cartEditClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted"/> Edit Cart - {cartEditing?.code}</h3>
              
              <form onSubmit={handleEditCart} className="flex flex-col gap-4" style={{ marginTop: "var(--space-3)" }}>
                <label className="field">
                  Cart Name
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={120}
                    placeholder="e.g. New Canteen"
                    title="Min 2 letters"
                    value={cartEditing?.name || ""}
                    onChange={(e) => setCartEditing({ ...cartEditing, name: sanitizeTextInput(e.target.value, 120) })}
                    autoFocus
                  />
                </label>
                
                <label className="field">
                  Address (Optional)
                  <input
                    type="text"
                    maxLength={200}
                    placeholder="e.g. Sta. Cruz, Laguna"
                    value={cartEditing?.address || ""}
                    onChange={(e) => setCartEditing({ ...cartEditing, address: sanitizeTextInput(e.target.value, 200) })}
                  />
                </label>
                
                <div className="modal-actions">
                  <button type="button" className="ghost" onClick={closeCartEditModal} disabled={isCartEditing || cartEditClosing}>Cancel</button>
                  <button type="submit" disabled={isCartEditing || cartEditClosing}>
                    {isCartEditing ? "Saving..." : "Save Changes"}
                  </button>
                </div>
                {cartError && <p className="error-box" role="alert" style={{ marginTop: "12px" }}>{cartError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* DEACTIVATE / REACTIVATE CART CONFIRMATION */}
        <ConfirmDialog
          open={Boolean(cartToggling)}
          title={cartToggling?.status === "INACTIVE" ? `Reactivate ${cartToggling?.code}?` : `Deactivate ${cartToggling?.code}?`}
          message={cartToggling?.status === "INACTIVE"
            ? `"${cartToggling?.code}" will reappear in the POS and filters.`
            : `"${cartToggling?.code}" will disappear from the POS and filters. History is kept.`}
          confirmLabel={cartToggling?.status === "INACTIVE" ? "Reactivate" : "Deactivate"}
          danger={cartToggling?.status !== "INACTIVE"}
          pending={isCartToggling}
          pendingLabel="Updating..."
          onConfirm={toggleCart}
          onCancel={() => setCartToggling(null)}
        />

        {/* DELETE IOT DEVICE CONFIRMATION */}
        <ConfirmDialog
          open={Boolean(deviceDeleting)}
          title="Delete IoT Device?"
          message={`Are you sure you want to unregister device "${deviceDeleting?.device_id}"? This will stop it from syncing data to the system.`}
          confirmLabel="Delete Device"
          danger={true}
          pending={isDeviceDeleting}
          pendingLabel="Deleting..."
          onConfirm={handleDeleteDevice}
          onCancel={() => setDeviceDeleting(null)}
        />
      </div>
    </PageErrorBoundary>
  );
}