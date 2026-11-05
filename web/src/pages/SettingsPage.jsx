import { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Cpu,
  Edit2,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Trash2,
  Users,
} from "lucide-react";

import api, { clearSession } from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import { useRfidEvents } from "../hooks/useRfidEvents.js";
import Badge from "../components/Badge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import Skeleton, { TableSkeleton } from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import PasswordStrengthMeter from "../components/PasswordStrengthMeter.jsx";
import { useToast } from "../components/Toast.jsx";
import Select from "../components/Select.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { sanitizeTextInput, countLetters } from "../utils/text.js";

// --- Time clock (owner-configured daily clock-in/out windows) ---
// Mirror of the server-side settings/timeClock document (Asia/Manila 24h wire
// format). The editor shows 12-hour values; weekday chips are 0 = Sun ... 6 = Sat.
const TIMECLOCK_DEFAULTS = {
  enabled: false,
  inOpen: "07:00",
  inClose: "09:00",
  outOpen: "17:00",
  outClose: "19:00",
  days: [0, 1, 2, 3, 4, 5, 6],
};
const TIMECLOCK_ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const HOURS_12 = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES_60 = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
const DAY_CHIPS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];
const TIMECLOCK_HM = /^\s*(\d{1,2}):(\d{2})\s*$/;
const hmToMinutes = (v) => {
  const m = TIMECLOCK_HM.exec(String(v ?? ""));
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
};
const canonicalHm = (v) => {
  const n = hmToMinutes(v);
  if (Number.isNaN(n)) return null;
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};
const normalizeDays = (d) => {
  if (!Array.isArray(d)) return TIMECLOCK_ALL_DAYS.slice();
  const set = new Set();
  for (const n of d) {
    const n2 = Number(n);
    if (Number.isInteger(n2) && n2 >= 0 && n2 <= 6) set.add(n2);
  }
  const arr = [...set].sort((a, b) => a - b);
  return arr.length ? arr : TIMECLOCK_ALL_DAYS.slice();
};
const normalizeTimeClock = (c) => {
  const snap = (v, fallback) => canonicalHm(v) ?? fallback;
  return {
    enabled: c?.enabled === true,
    inOpen: snap(c?.inOpen, TIMECLOCK_DEFAULTS.inOpen),
    inClose: snap(c?.inClose, TIMECLOCK_DEFAULTS.inClose),
    outOpen: snap(c?.outOpen, TIMECLOCK_DEFAULTS.outOpen),
    outClose: snap(c?.outClose, TIMECLOCK_DEFAULTS.outClose),
    days: normalizeDays(c?.days),
  };
};
/** "HH:MM" -> { hour, minute, ampm } for the 12h editor. */
const to12h = (time) => {
  const canon = canonicalHm(time) ?? "00:00";
  const [h, m] = canon.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return { hour: String(hour), minute: String(m).padStart(2, "0"), ampm };
};
/** The 12h editor -> "HH:MM". */
const from12h = (hour, minute, ampm) => {
  let h = Number(hour) % 12;
  if (ampm === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${minute}`;
};
/** "HH:MM" -> "7:05 AM". */
const format12h = (time) => {
  const { hour, minute, ampm } = to12h(time);
  return `${Number(hour)}:${minute} ${ampm}`;
};

/** One 12h time editor: hour : minute AM/PM, backed by a "HH:MM" value. */
function TimeField12h({ prefix, label, value, onChange, disabled }) {
  const { hour, minute, ampm } = to12h(value);
  const selectStyle = {
    height: "38px",
    padding: "2px 8px",
    fontSize: "0.95rem",
    fontWeight: 600,
    borderRadius: "10px",
    border: "1px solid var(--color-border, #e2e8f0)",
    background: disabled ? "#f1f5f9" : "#fff",
  };
  return (
    <div style={{ minWidth: 150 }}>
      <span
        className="field-label"
        style={{ display: "block", marginBottom: 4, fontSize: "0.8rem", color: "var(--color-text-2, #64748b)" }}
      >
        {label}
      </span>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          id={`${prefix}-hour`}
          aria-label={`${label} hour`}
          value={hour}
          disabled={disabled}
          onChange={(e) => onChange(from12h(e.target.value, minute, ampm))}
          style={selectStyle}
        >
          {HOURS_12.map((h) => <option key={h} value={String(h)}>{h}</option>)}
        </select>
        <span aria-hidden="true" style={{ fontWeight: 800, color: "var(--color-text-2, #64748b)" }}>:</span>
        <select
          id={`${prefix}-minute`}
          aria-label={`${label} minute`}
          value={minute}
          disabled={disabled}
          onChange={(e) => onChange(from12h(hour, e.target.value, ampm))}
          style={selectStyle}
        >
          {MINUTES_60.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          id={`${prefix}-ampm`}
          aria-label={`${label} AM or PM`}
          value={ampm}
          disabled={disabled}
          onChange={(e) => onChange(from12h(hour, minute, e.target.value))}
          style={selectStyle}
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useOutletContext();
  const isOwner = user?.role === "OWNER";

  const [profile, setProfile] = useState(user ?? null);
  const [profileError, setProfileError] = useState("");

  const [ownerError, setOwnerError] = useState([]);
  const [isLoadingOwner, setIsLoadingOwner] = useState(true);

  const [pw, setPw] = useState({ current: "", next: "", confirm: "", code: "" });
  const [pwCodeSent, setPwCodeSent] = useState(false);
  const [pwCodeEmail, setPwCodeEmail] = useState("");
  const [pwCodeCooldown, setPwCodeCooldown] = useState(0);
  const [isSendingPwCode, setIsSendingPwCode] = useState(false);

  const [emailEditing, setEmailEditing] = useState(false);
  const [emailEditClosing, setEmailEditClosing] = useState(false);
  const [emailForm, setEmailForm] = useState({ email: "", currentPassword: "" });
  const [emailError, setEmailError] = useState("");
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [showEmailPw, setShowEmailPw] = useState(false);

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
    email: "",
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

  // -- TIME CLOCK STATES --
  const [timeClock, setTimeClock] = useState(TIMECLOCK_DEFAULTS);
  const [clockLoading, setClockLoading] = useState(true);
  const [clockSaving, setClockSaving] = useState(false);
  const [clockError, setClockError] = useState("");

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
  function closeEmailModal() {
    setEmailEditClosing(true);
    setTimeout(() => { setEmailEditing(false); setEmailEditClosing(false); }, 150);
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
    emailEditing || emailEditClosing ||
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

  useEffect(() => {
    if (pwCodeCooldown <= 0) return undefined;
    const timer = setTimeout(
      () => setPwCodeCooldown((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [pwCodeCooldown]);

  function reloadStaff() {
    // A card is registered from the POS app at the cart, so this list goes
    // stale while the owner is sitting on this page. Refetch only the staff
    // list on a live event instead of reloading every owner table.
    api
      .get("/auth/staff")
      .then(({ data }) => setStaff(data?.data ?? []))
      .catch(() => {});
  }

  // Mounted here (not only in the shell) so a registration lands straight in
  // the card column of the table below.
  useRfidEvents({ onChange: reloadStaff });

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

  function loadTimeClock() {
    setClockLoading(true);
    api
      .get("/settings/timeclock")
      .then(({ data }) => setTimeClock(normalizeTimeClock(data?.clock)))
      .catch(() =>
        setClockError(
          "Could not load the time clock settings - defaults shown; you can still save.",
        ),
      )
      .finally(() => setClockLoading(false));
  }

  async function saveTimeClock(e) {
    e.preventDefault();
    const inOpen = canonicalHm(timeClock.inOpen);
    const inClose = canonicalHm(timeClock.inClose);
    const outOpen = canonicalHm(timeClock.outOpen);
    const outClose = canonicalHm(timeClock.outClose);
    if (!inOpen || !inClose || !outOpen || !outClose) {
      setClockError('Each time must be "HH:MM" (24h), e.g. "07:30".');
      return;
    }
    if (hmToMinutes(inOpen) >= hmToMinutes(inClose)) {
      setClockError("Time in: the opening time must be before the closing time.");
      return;
    }
    if (hmToMinutes(outOpen) >= hmToMinutes(outClose)) {
      setClockError("Time out: the opening time must be before the closing time.");
      return;
    }
    const days = [...timeClock.days].sort((a, b) => a - b);
    if (days.length === 0) {
      setClockError(
        "Select at least one day - an ON schedule needs a day when the buttons may open.",
      );
      return;
    }
    setClockError("");
    setClockSaving(true);
    try {
      const { data } = await api.put("/settings/timeclock", {
        enabled: timeClock.enabled,
        inOpen,
        inClose,
        outOpen,
        outClose,
        days,
      });
      setTimeClock(normalizeTimeClock(data?.clock));
      toast("Time clock saved", "success");
    } catch (err) {
      setClockError(getFriendlyError(err, "Could not save the time clock - try again."));
    } finally {
      setClockSaving(false);
    }
  }

  function toggleDay(day) {
    const has = timeClock.days.includes(day);
    const days = has
      ? timeClock.days.filter((d) => d !== day)
      : [...timeClock.days, day].sort((a, b) => a - b);
    setTimeClock({ ...timeClock, days });
  }

  const missingDayLabels = TIMECLOCK_ALL_DAYS.filter(
    (d) => !timeClock.days.includes(d),
  ).map((d) => DAY_CHIPS.find((x) => x.value === d)?.label ?? String(d));
  const daysCaption =
    missingDayLabels.length === 0
      ? "every day"
      : missingDayLabels.length === 1
        ? `every day except ${missingDayLabels[0]}s`
        : `every day except ${missingDayLabels.join(", ")}`;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional init: profile + catalog defaults on mount/role change
    loadProfile();
    loadTimeClock();
    api.get("/catalog", { cacheTtl: 60000 }).then(({ data }) => {
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

  const isPlaceholderEmail = (value) =>
    !value || String(value).toLowerCase().endsWith("@cartiq.local");
  const hasRealEmail = Boolean(profile?.email && !isPlaceholderEmail(profile.email));
  const displayEmail = hasRealEmail
    ? profile.email
    : `${profile?.username ?? "staff"}@cartiq.local`;
  const profileInitials = String(profile?.name ?? profile?.username ?? "?")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";

  function openEmailModal() {
    setEmailForm({
      email: hasRealEmail ? profile.email : "",
      currentPassword: "",
    });
    setEmailError("");
    setShowEmailPw(false);
    setEmailEditing(true);
  }

  async function saveEmail(e) {
    e.preventDefault();
    const cleanEmail = emailForm.email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes("@") || cleanEmail.endsWith("@cartiq.local")) {
      setEmailError("Enter a real email address, not a placeholder.");
      return;
    }
    if (!emailForm.currentPassword) {
      setEmailError("Enter your current password to confirm this change.");
      return;
    }
    setEmailError("");
    setIsSavingEmail(true);
    try {
      const { data } = await api.patch("/auth/me", {
        email: cleanEmail,
        currentPassword: emailForm.currentPassword,
      });
      setProfile(data?.user ?? profile);
      // Codes sent to the old inbox were just invalidated server-side.
      setPwCodeSent(false);
      setPwCodeEmail("");
      setPwCodeCooldown(0);
      toast("Recovery email updated", "success");
      closeEmailModal();
    } catch (err) {
      setEmailError(getFriendlyError(err, "Could not update your email - try again."));
    } finally {
      setIsSavingEmail(false);
    }
  }

  async function sendPwCode() {
    if (isSendingPwCode || pwCodeCooldown > 0) return;
    if (!hasRealEmail) {
      setPwError("Add a recovery email in your profile before changing your password.");
      return;
    }
    setPwError("");
    setIsSendingPwCode(true);
    try {
      const { data } = await api.post("/auth/change-password/otp", {});
      setPwCodeSent(true);
      setPwCodeEmail(data?.email ?? "");
      const seconds = data?.cooldown
        ? Math.ceil((data.retryAfterMs ?? 60000) / 1000)
        : 60;
      setPwCodeCooldown(Math.max(0, seconds));
      toast(data?.message ?? "Code sent - check your email.", "success");
    } catch (err) {
      setPwError(getFriendlyError(err, "Could not send the code - try again."));
    } finally {
      setIsSendingPwCode(false);
    }
  }

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
    if (!pwCodeSent) {
      setPwError("Send a 6-digit code to your recovery email first.");
      return;
    }
    if (!/^\d{6}$/.test(pw.code.trim())) {
      setPwError("Enter the 6-digit code from your email.");
      return;
    }
    setPwError("");
    if (isChanging) return;

    setIsChanging(true);
    try {
      await api.post("/auth/change-password", {
        currentPassword: pw.current,
        newPassword: pw.next,
        code: pw.code.trim(),
      });
      clearSession();
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
      setNewStaff({ name: "", username: "", password: "", locationCode: safeLocations[0]?.code || "", rfidUid: "", email: "" });
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
      (staffEditing.rfidUid || null) === (original.rfidUid || null) &&
      (staffEditing.email || "") === (original.email || "")
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
        rfidUid: staffEditing.rfidUid || null,
        email: staffEditing.email || null
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
        
        <div className="settings-grid settings-account-grid" style={{ gap: "var(--space-4)" }}>
          
          {/* PROFILE PANEL */}
          <section className="panel settings-profile-card" style={{ padding: "var(--space-5)" }}>
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
                <div className="settings-profile-skeleton" aria-hidden="true">
                  <div className="settings-profile-skeleton-identity">
                    <span className="skel settings-profile-skeleton-avatar" />
                    <span className="settings-profile-skeleton-name">
                      <span className="skel" />
                      <span className="skel" />
                    </span>
                    <span className="skel settings-profile-skeleton-role" />
                  </div>
                  <div className="settings-profile-skeleton-row">
                    <span className="skel" />
                    <span className="skel" />
                  </div>
                  <div className="settings-profile-skeleton-row">
                    <span className="skel" />
                    <span className="skel" />
                  </div>
                </div>
              )
            ) : (
              <div className="settings-profile" aria-label="Profile details">
                <div className="settings-profile-identity">
                  <span className="settings-profile-avatar" aria-hidden="true">{profileInitials}</span>
                  <div className="settings-profile-name">
                    <strong>{profile.name}</strong>
                    {profile.username && <span>@{profile.username}</span>}
                  </div>
                  <Badge variant="brand">{profile.role}</Badge>
                </div>
                <dl className="settings-profile-details">
                  <div className="settings-profile-row">
                    <dt>Cart assignment</dt>
                    <dd>{profile.location ? `${profile.location.code} - ${profile.location.name}` : "All carts"}</dd>
                  </div>
                  <div className="settings-profile-row">
                    <dt>Recovery email</dt>
                    <dd className="settings-profile-email">
                      <span>{displayEmail}</span>
                      {!hasRealEmail && <Badge variant="warn">Placeholder</Badge>}
                      <button type="button" className="ghost small-btn" onClick={openEmailModal} title="Edit recovery email">
                        <Edit2 size={13} /> Edit
                      </button>
                    </dd>
                  </div>
                </dl>
              </div>
            )}
          </section>

          {/* CHANGE PASSWORD PANEL */}
          <section className="panel settings-pw" style={{ padding: "var(--space-5)" }}>
            <div className="settings-pw-head">
              <span className="settings-pw-icon" aria-hidden="true">
                <ShieldCheck size={21} />
              </span>
              <div>
                <h3 className="settings-pw-title">Change password</h3>
              </div>
            </div>

            {!profile && !profileError ? (
              <div className="flex flex-col gap-3">
                <Skeleton rows={4} height={36} />
              </div>
            ) : (
              <form onSubmit={changePassword} className="settings-pw-form">
                {/* STEP 1 - VERIFY IDENTITY */}
                <div className="settings-pw-section">
                  <div className="settings-pw-section-head">
                    <span className="settings-pw-step" aria-hidden="true">1</span>
                    <div>
                      <h4 className="settings-pw-section-title">Verify your identity</h4>
                    </div>
                  </div>

                  <div className="settings-pw-grid">
                    <div className="settings-pw-field">
                      <label className="settings-pw-label" htmlFor="settings-pw-current">
                        Current password
                      </label>
                      <div className="settings-pw-input">
                        <Lock size={16} className="settings-pw-input-icon" aria-hidden="true" />
                        <input
                          id="settings-pw-current"
                          type={showPw.current ? "text" : "password"}
                          value={pw.current}
                          onChange={(e) => setPw({ ...pw, current: e.target.value })}
                          required
                          autoComplete="current-password"
                          placeholder="Enter current password"
                        />
                        <button
                          type="button"
                          className="settings-pw-eye"
                          onClick={() => setShowPw({ ...showPw, current: !showPw.current })}
                          aria-label={showPw.current ? "Hide password" : "Show password"}
                        >
                          {showPw.current ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </div>
                    </div>

                    <div className="settings-pw-field">
                      <div className="settings-pw-label-row">
                        <label className="settings-pw-label" htmlFor="settings-pw-code">
                          Recovery code
                        </label>
                        <button
                          type="button"
                          className="settings-pw-send"
                          onClick={sendPwCode}
                          disabled={isSendingPwCode || pwCodeCooldown > 0 || !hasRealEmail}
                        >
                          {isSendingPwCode
                            ? "Sending..."
                            : pwCodeCooldown > 0
                              ? `Resend in ${pwCodeCooldown}s`
                              : pwCodeSent
                                ? "Resend code"
                                : "Send code"}
                        </button>
                      </div>
                      <div className="settings-pw-input settings-pw-code-input">
                        <input
                          id="settings-pw-code"
                          value={pw.code}
                          onChange={(e) => setPw({ ...pw, code: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="6-digit code"
                          maxLength={6}
                          aria-describedby="settings-pw-code-hint"
                        />
                      </div>
                      {pwCodeSent ? (
                        <p className="settings-pw-hint is-sent" id="settings-pw-code-hint">
                          <CheckCircle2 size={13} aria-hidden="true" />
                          Sent to {pwCodeEmail || displayEmail}. It expires in 10 minutes.
                        </p>
                      ) : (
                        <p className="settings-pw-hint" id="settings-pw-code-hint">
                          <Info size={13} aria-hidden="true" />
                          We&apos;ll email a 6-digit code before the password can change.
                        </p>
                      )}
                      {!hasRealEmail && (
                        <div className="settings-pw-alert" role="status">
                          <span className="settings-pw-alert-text">
                            <AlertCircle size={14} aria-hidden="true" />
                            Your recovery email is a placeholder.
                          </span>
                          <button type="button" className="settings-pw-alert-btn" onClick={openEmailModal}>
                            Add email
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* STEP 2 - NEW PASSWORD */}
                <div className="settings-pw-section">
                  <div className="settings-pw-section-head">
                    <span className="settings-pw-step" aria-hidden="true">2</span>
                    <div>
                      <h4 className="settings-pw-section-title">Choose a new password</h4>
                    </div>
                  </div>

                  <div className="settings-pw-grid">
                    <div className="settings-pw-field">
                      <label className="settings-pw-label" htmlFor="settings-pw-next">
                        New password
                      </label>
                      <div className="settings-pw-input">
                        <KeyRound size={16} className="settings-pw-input-icon" aria-hidden="true" />
                        <input
                          id="settings-pw-next"
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
                          placeholder="At least 8 characters"
                          aria-describedby="settings-pw-strength"
                        />
                        <button
                          type="button"
                          className="settings-pw-eye"
                          onClick={() => setShowPw({ ...showPw, next: !showPw.next })}
                          aria-label={showPw.next ? "Hide password" : "Show password"}
                        >
                          {showPw.next ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </div>
                      <div id="settings-pw-strength">
                        <PasswordStrengthMeter value={pw.next} minLevel="good" />
                      </div>
                    </div>

                    <div className="settings-pw-field">
                      <label className="settings-pw-label" htmlFor="settings-pw-confirm">
                        Confirm new password
                      </label>
                      <div className="settings-pw-input">
                        <KeyRound size={16} className="settings-pw-input-icon" aria-hidden="true" />
                        <input
                          id="settings-pw-confirm"
                          type={showPw.confirm ? "text" : "password"}
                          value={pw.confirm}
                          onChange={(e) => {
                            const val = e.target.value;
                            setPw({ ...pw, confirm: val });
                            if (pwError.includes("match") && pw.next === val) {
                              setPwError("");
                            }
                          }}
                          required
                          autoComplete="new-password"
                          placeholder="Re-enter new password"
                        />
                        <button
                          type="button"
                          className="settings-pw-eye"
                          onClick={() => setShowPw({ ...showPw, confirm: !showPw.confirm })}
                          aria-label={showPw.confirm ? "Hide password" : "Show password"}
                        >
                          {showPw.confirm ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </div>
                      {pw.confirm && pw.next === pw.confirm ? (
                        <p className="settings-pw-hint is-sent" role="status">
                          <CheckCircle2 size={13} aria-hidden="true" /> Passwords match.
                        </p>
                      ) : pw.confirm ? (
                        <p className="settings-pw-hint is-warn" role="status">
                          <AlertCircle size={13} aria-hidden="true" /> Passwords don&apos;t match yet.
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>

                {pwError && <p className="error-box" role="alert" style={{ margin: 0 }}>{pwError}</p>}

                <div className="settings-pw-footer">
                  <p className="settings-pw-note">
                    <Info size={14} aria-hidden="true" /> You&apos;ll be signed out after the update.
                  </p>
                  <button type="submit" className="settings-pw-submit" disabled={isChanging || !pwCodeSent}>
                    <KeyRound size={15} /> {isChanging ? "Updating..." : "Update password"}
                  </button>
                </div>
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

            {/* TIME CLOCK */}
            <section className="panel" style={{ padding: "var(--space-5)" }}>
              <div className="settings-table-heading">
                <div>
                  <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>Time clock</h3>
                  <p className="muted small" style={{ margin: "var(--space-1) 0 0" }}>
                    Buttons open and close every day at these times (Manila time). Flip ON to use them.
                  </p>
                </div>
                <button className="ghost small-btn" onClick={loadTimeClock} disabled={clockLoading}>
                  <RefreshCw size={13} /> Refresh
                </button>
              </div>

              <form onSubmit={saveTimeClock} style={{ marginTop: "var(--space-3)" }}>
                {/* Big clear ON / OFF */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={timeClock.enabled}
                  id="timeclock-enabled-switch"
                  onClick={() => setTimeClock({ ...timeClock, enabled: !timeClock.enabled })}
                  style={{
                    display: "flex", alignItems: "center", gap: "14px", width: "100%",
                    marginTop: "var(--space-1)", padding: "12px 16px", borderRadius: "16px",
                    cursor: "pointer", textAlign: "left",
                    border: timeClock.enabled ? "2px solid #16a34a" : "2px dashed #cbd5e1",
                    background: timeClock.enabled ? "#f0fdf4" : "#f8fafc",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      width: 46, height: 46, borderRadius: 999, flexShrink: 0,
                      background: timeClock.enabled ? "#16a34a" : "#cbd5e1",
                      color: "#fff", fontWeight: 800, fontSize: "0.9rem", letterSpacing: "0.06em",
                    }}
                  >
                    {timeClock.enabled ? "ON" : "OFF"}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", color: "var(--color-text-1, #0f172a)" }}>
                      Schedule is {timeClock.enabled ? "ON" : "OFF"}
                    </strong>
                    <span className="muted small">
                      {timeClock.enabled
                        ? "The buttons open only on the days and times below — outside them, Time in / Time out cannot be tapped."
                        : "Both buttons always work. Turn ON to limit them to the days and times below."}
                    </span>
                  </span>
                </button>

                {/* Times, 12-hour */}
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "flex-end" }}>
                    <span style={{ minWidth: 66, fontWeight: 700, paddingBottom: 10 }}>Time in</span>
                    <TimeField12h prefix="timeclock-in-open" label="Time in opens" value={timeClock.inOpen}
                      onChange={(v) => setTimeClock({ ...timeClock, inOpen: v })} disabled={!timeClock.enabled} />
                    <span aria-hidden="true" style={{ paddingBottom: 10, color: "var(--color-text-2, #64748b)" }}>—</span>
                    <TimeField12h prefix="timeclock-in-close" label="Time in closes" value={timeClock.inClose}
                      onChange={(v) => setTimeClock({ ...timeClock, inClose: v })} disabled={!timeClock.enabled} />
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "flex-end" }}>
                    <span style={{ minWidth: 66, fontWeight: 700, paddingBottom: 10 }}>Time out</span>
                    <TimeField12h prefix="timeclock-out-open" label="Time out opens" value={timeClock.outOpen}
                      onChange={(v) => setTimeClock({ ...timeClock, outOpen: v })} disabled={!timeClock.enabled} />
                    <span aria-hidden="true" style={{ paddingBottom: 10, color: "var(--color-text-2, #64748b)" }}>—</span>
                    <TimeField12h prefix="timeclock-out-close" label="Time out closes" value={timeClock.outClose}
                      onChange={(v) => setTimeClock({ ...timeClock, outClose: v })} disabled={!timeClock.enabled} />
                  </div>
                </div>

                {/* Selling days */}
                <div style={{ marginTop: "var(--space-4)" }}>
                  <span style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text-2, #64748b)", marginBottom: 6 }}>
                    Selling days — uncheck the days when there are no sales; the buttons stay closed the whole day.
                  </span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {DAY_CHIPS.map(({ value, label }) => {
                      const active = timeClock.days.includes(value);
                      return (
                        <button
                          key={value}
                          type="button"
                          id={`timeclock-day-${value}`}
                          aria-pressed={active}
                          disabled={!timeClock.enabled}
                          onClick={() => toggleDay(value)}
                          style={{
                            minWidth: 56, padding: "8px 12px", borderRadius: 999, fontWeight: 700,
                            cursor: !timeClock.enabled ? "default" : "pointer",
                            opacity: !timeClock.enabled ? 0.55 : 1,
                            border: active ? "2px solid #16a34a" : "2px dashed #cbd5e1",
                            background: active ? "#f0fdf4" : "#f8fafc",
                            color: active ? "#15803d" : "#94a3b8",
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {clockError && (
                  <p className="error-box" role="alert" style={{ marginTop: "var(--space-3)" }}>{clockError}</p>
                )}

                <div className="flex items-center justify-between gap-2" style={{ marginTop: "var(--space-4)" }}>
                  <p className="muted small" style={{ margin: 0 }}>
                    {timeClock.enabled ? (
                      <>
                        Buttons open <strong>{daysCaption}</strong>: Time in{" "}
                        <strong>{format12h(timeClock.inOpen)}–{format12h(timeClock.inClose)}</strong> · Time out{" "}
                        <strong>{format12h(timeClock.outOpen)}–{format12h(timeClock.outClose)}</strong>.
                      </>
                    ) : (
                      "Schedule is OFF — both buttons always work (current behavior)."
                    )}
                  </p>
                  <button type="submit" className="small-btn" disabled={clockSaving || clockLoading}>
                    <Clock size={13} /> {clockSaving ? "Saving..." : "Save"}
                  </button>
                </div>
              </form>
            </section>

            {/* IOT DEVICE REGISTRY */}
            <section className="panel" style={{ padding: "var(--space-5)" }}>
              <div className="settings-table-heading">
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
                <TableSkeleton
                  className="settings-table-wrap"
                  tableClassName="settings-table settings-table-devices"
                  rows={4}
                  columns={[
                    { key: "device", label: "Device ID" },
                    { key: "cart", label: "Cart", className: "settings-hide-narrow" },
                    { key: "status", label: "Status", className: "settings-indicator-heading", skeletonType: "badge" },
                    { key: "heartbeat", label: "Last heartbeat" },
                    { key: "actions", label: "Actions", align: "center" },
                  ]}
                />
              ) : safeDevices.length === 0 ? (
                <EmptyState
                  icon={Cpu}
                  title="No devices registered"
                  subtitle="Register an ESP32 node to start syncing live data."
                  compact
                />
              ) : (
                <div className="table-wrap settings-table-wrap">
                  <table className="data table-fixed settings-table settings-table-devices">
                    <thead>
                      <tr>
                        <th>Device ID</th>
                        <th className="settings-hide-narrow">Cart</th>
                        <th className="settings-indicator-heading">Status</th>
                        <th>Last heartbeat</th>
                        <th className="t-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {safeDevices.map((d) => (
                        <tr key={d.id}>
                          <td><strong>{d.device_id}</strong></td>
                          <td className="settings-hide-narrow"><Badge variant="info">{d.cart}</Badge></td>
                          <td className="settings-indicator-cell">
                            <span className="settings-indicator">
                              <Badge variant={!d.active ? "danger" : d.online ? "ok" : "warn"}>
                                {d.active ? (d.online ? "ONLINE" : "IDLE") : "DISABLED"}
                              </Badge>
                            </span>
                          </td>
                          <td className="muted small">
                            {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never"}
                          </td>
                          <td className="t-center settings-actions-cell">
                            <div className="settings-table-actions">
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
              <div className="settings-table-heading">
                <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>Staff accounts</h3>
                <button onClick={() => { setStaffError(""); setAddOpen(true); setShowNewStaffPw(false); }}>
                  <Plus size={15} /> Add staff
                </button>
              </div>

              {isLoadingOwner ? (
                <TableSkeleton
                  className="settings-table-wrap"
                  tableClassName="settings-table settings-table-staff"
                  rows={4}
                  columns={[
                    { key: "name", label: "Name" },
                    { key: "username", label: "Username", className: "settings-hide-narrow" },
                    { key: "email", label: "Recovery email" },
                    { key: "cart", label: "Cart", className: "settings-hide-narrow" },
                    { key: "rfid", label: "RFID UID", className: "settings-hide-narrow" },
                    { key: "status", label: "Status", className: "settings-indicator-heading", skeletonType: "badge" },
                    { key: "actions", label: "Actions", align: "center" },
                  ]}
                />
              ) : safeStaff.filter((s) => s.role !== "OWNER").length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="No staff accounts"
                  subtitle="Add staff members to give them POS access."
                  compact
                />
              ) : (
                <div className="table-wrap settings-table-wrap">
                  <table className="data table-fixed settings-table settings-table-staff">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th className="settings-hide-narrow">Username</th>
                        <th>Recovery email</th>
                        <th className="settings-hide-narrow">Cart</th>
                        <th className="settings-hide-narrow">RFID UID</th>
                        <th className="settings-indicator-heading">Status</th>
                        <th className="t-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {safeStaff.filter((s) => s.role !== "OWNER").map((s) => (
                        <tr key={s.id} className={!s.active ? "row-disabled" : undefined}>
                          <td><strong>{s.name}</strong></td>
                          <td className="settings-hide-narrow">{s.username}</td>
                          <td className="muted small">
                            <span className="settings-email-cell">
                              <span>
                                {s.email && !String(s.email).toLowerCase().endsWith("@cartiq.local")
                                  ? s.email
                                  : `${s.username}@cartiq.local`}
                              </span>
                              {(!s.email || String(s.email).toLowerCase().endsWith("@cartiq.local")) && (
                                <Badge variant="warn">Placeholder</Badge>
                              )}
                            </span>
                          </td>
                          <td className="settings-hide-narrow">{s.location ? <Badge variant="info">{s.location.code}</Badge> : <span className="muted">-</span>}</td>
                          <td className="muted small settings-hide-narrow">{s.rfidUid ?? "-"}</td>
                          <td className="settings-indicator-cell">
                            <span className="settings-indicator">
                              <Badge variant={s.active ? "ok" : "danger"}>
                                {s.active ? "ACTIVE" : "DISABLED"}
                              </Badge>
                            </span>
                          </td>
                          <td className="t-center settings-actions-cell">
                            <div className="settings-table-actions">
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
              <div className="settings-table-heading">
                <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>Carts</h3>
                <button onClick={() => { setCartError(""); setCartAddOpen(true); }}>
                  <Plus size={15} /> Add cart
                </button>
              </div>

              {isLoadingOwner ? (
                <TableSkeleton
                  className="settings-table-wrap"
                  tableClassName="settings-table settings-table-carts"
                  rows={4}
                  columns={[
                    { key: "code", label: "Code" },
                    { key: "name", label: "Name" },
                    { key: "items", label: "Items", className: "settings-hide-narrow" },
                    { key: "status", label: "Status", className: "settings-indicator-heading", skeletonType: "badge" },
                    { key: "node", label: "Node", skeletonType: "badge" },
                    { key: "actions", label: "Actions", align: "center" },
                  ]}
                />
              ) : carts.length === 0 ? (
                <EmptyState
                  icon={ShoppingCart}
                  title="No carts yet"
                  subtitle="Provision a cart to start tracking sales and inventory."
                  compact
                />
              ) : (
                <div className="table-wrap settings-table-wrap">
                  <table className="data table-fixed settings-table settings-table-carts">
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Name</th>
                        <th className="settings-hide-narrow">Items</th>
                        <th className="settings-indicator-heading">Status</th>
                        <th>Node</th>
                        <th className="t-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {carts.map((c) => (
                        <tr key={c.id} className={c.status === "INACTIVE" ? "row-disabled" : undefined}>
                          <td><strong>{c.code}</strong></td>
                          <td>{c.name}</td>
                          <td className="muted settings-hide-narrow">{c.itemCount}</td>
                          <td className="settings-indicator-cell">
                            <span className="settings-indicator">
                              <Badge variant={c.status === "INACTIVE" ? "danger" : "ok"}>
                                {c.status === "INACTIVE" ? "INACTIVE" : "ACTIVE"}
                              </Badge>
                            </span>
                          </td>
                          <td className="settings-node-cell">
                            {c.device ? (
                              <>
                                <span>{c.device.deviceId}</span>
                                <Badge className="settings-node-status" variant={c.device.online ? "ok" : "warn"}>
                                  {c.device.online ? "ONLINE" : "IDLE"}
                                </Badge>
                              </>
                            ) : (
                              <Badge variant="neutral">UNASSIGNED</Badge>
                            )}
                          </td>
                          <td className="t-center settings-actions-cell">
                            <div className="settings-table-actions">
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
        
        {/* RECOVERY EMAIL MODAL */}
        {(emailEditing || emailEditClosing) && (
          <div
            className={`modal-backdrop ${emailEditClosing ? "is-closing" : ""}`}
            onClick={closeEmailModal}
          >
            <div
              className={`modal ${emailEditClosing ? "is-closing" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-label="Recovery email"
              onClick={(e) => e.stopPropagation()}
            >
              <h3>Recovery email</h3>
              <p className="muted small">
                Password reset codes and password-change codes are sent here.
                Use an inbox you can open on this device.
              </p>
              <form onSubmit={saveEmail} className="flex flex-col gap-3" style={{ marginTop: "var(--space-3)" }}>
                <label className="field">
                  Email address
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    placeholder={`${profile?.username ?? "staff"}@cartiq.local`}
                    value={emailForm.email}
                    onChange={(e) => setEmailForm({ ...emailForm, email: e.target.value })}
                    style={{ height: "36px" }}
                  />
                </label>
                <label className="field">
                  Current password
                  <div style={{ position: "relative" }}>
                    <input
                      type={showEmailPw ? "text" : "password"}
                      required
                      autoComplete="current-password"
                      value={emailForm.currentPassword}
                      onChange={(e) => setEmailForm({ ...emailForm, currentPassword: e.target.value })}
                      style={{ height: "36px", width: "100%", paddingRight: "36px" }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowEmailPw((visible) => !visible)}
                      style={toggleBtnStyle}
                      aria-label={showEmailPw ? "Hide password" : "Show password"}
                    >
                      {showEmailPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <span className="muted small">Required so a stolen session cannot redirect your recovery.</span>
                </label>
                {emailError && (
                  <p className="error-box" role="alert" style={{ margin: 0 }}>{emailError}</p>
                )}
                <div className="flex items-center justify-end gap-2" style={{ marginTop: "var(--space-2)" }}>
                  <button type="button" className="ghost" onClick={closeEmailModal} disabled={isSavingEmail}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isSavingEmail}>
                    {isSavingEmail ? "Saving..." : "Save email"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

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
                <label className="field">
                  Recovery email (optional - enables password reset)
                  <input
                    type="email"
                    placeholder="staff@example.com"
                    value={newStaff.email}
                    onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
                    autoComplete="email"
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
                <label className="field">
                  Recovery email (optional - enables password reset)
                  <input
                    type="email"
                    placeholder={`${staffEditing?.username ?? "staff"}@cartiq.local`}
                    value={staffEditing?.email || ""}
                    onChange={(e) => setStaffEditing({ ...staffEditing, email: e.target.value })}
                    autoComplete="email"
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