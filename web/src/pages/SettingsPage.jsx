import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock,
  Cpu,
  Edit2,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  Plus,
  Power,
  Save,
  ShieldCheck,
  ShoppingCart,
  Trash2,
  Users,
  Nfc,
} from "lucide-react";

import api, { clearSession } from "../api.js";
import { getFriendlyError } from "../utils/errors.js";
import { timeClockScheduleError } from "../utils/timeClock.js";
import { useRfidEvents } from "../hooks/useRfidEvents.js";
import { useLiveEvent } from "../hooks/useLiveStream.js";
import { activeCarts, invalidateLiveList, useLiveList } from "../state/liveData.js";
import Badge from "../components/Badge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import Skeleton, { TableSkeleton } from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PageHeader from "../components/PageHeader.jsx";
import PasswordStrengthMeter, { meetsPasswordStrength } from "../components/PasswordStrengthMeter.jsx";
import { useToast } from "../components/Toast.jsx";
import Select from "../components/Select.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { sanitizeTextInput, countLetters, validatePersonName, validateUsername, validateEmail, validateRfidUid, validateDeviceId } from "../utils/text.js";

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
/**
 * Seconds left on the reader countdown.
 *
 * Module-level on purpose: reading the clock during render is impure, and the
 * countdown is a side effect of a click, not of a render.
 */
const readerSecondsLeft = (expiresAtIso, fallbackMs = 90000) => {
  const expires = expiresAtIso
    ? new Date(expiresAtIso).getTime()
    : Date.now() + fallbackMs;
  return Math.max(0, Math.round((expires - Date.now()) / 1000));
};

const DAY_CHIPS = [  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];
const DAY_FULL_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
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
const to12h = (time) => {  const canon = canonicalHm(time) ?? "00:00";
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

/** Minutes -> "2h" / "1h 30m" for the window length chip. */
const formatDuration = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || "0m";
};

/** One 12h time editor: hour : minute AM/PM, backed by a "HH:MM" value. */
function TimeField12h({ prefix, label, caption, value, onChange, disabled }) {
  const { hour, minute, ampm } = to12h(value);
  return (
    <div className="timefield">
      <span className="timefield-label">{caption ?? label}</span>
      <div className="timefield-row">
        <select
          id={`${prefix}-hour`}
          aria-label={`${label} hour`}
          className="timefield-select timefield-hour"
          value={hour}
          disabled={disabled}
          onChange={(e) => onChange(from12h(e.target.value, minute, ampm))}
        >
          {HOURS_12.map((h) => <option key={h} value={String(h)}>{h}</option>)}
        </select>
        <span aria-hidden="true" className="timefield-colon">:</span>
        <select
          id={`${prefix}-minute`}
          aria-label={`${label} minute`}
          className="timefield-select timefield-minute"
          value={minute}
          disabled={disabled}
          onChange={(e) => onChange(from12h(hour, e.target.value, ampm))}
        >
          {MINUTES_60.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          id={`${prefix}-ampm`}
          aria-label={`${label} AM or PM`}
          className="timefield-select timefield-ampm"
          value={ampm}
          disabled={disabled}
          onChange={(e) => onChange(from12h(hour, minute, e.target.value))}
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

  const [isLoadingOwner, setIsLoadingOwner] = useState(true);

  const [pw, setPw] = useState({ current: "", next: "", confirm: "", code: "" });
  const [pwCodeSent, setPwCodeSent] = useState(false);
  const [pwCodeEmail, setPwCodeEmail] = useState("");
  const [pwCodeCooldown, setPwCodeCooldown] = useState(0);
  const [isSendingPwCode, setIsSendingPwCode] = useState(false);

  const [emailEditing, setEmailEditing] = useState(false);
  const [emailEditClosing, setEmailEditClosing] = useState(false);
  const [emailForm, setEmailForm] = useState({ email: "", currentPassword: "", code: "" });
  const [emailError, setEmailError] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  // The server enforces a 60-second cooldown between code requests. The button
  // counts it down so nobody can spam it (and so the person knows when they can
  // try again).
  const [emailCodeCooldown, setEmailCodeCooldown] = useState(0);
  const [isSendingEmailCode, setIsSendingEmailCode] = useState(false);
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [showEmailPw, setShowEmailPw] = useState(false);

  // One shared, live copy of each list. The Carts table and the "Cart
  // assignment" dropdown read the SAME carts, so a cart the owner just
  // deactivated cannot keep showing up in one of them - and a change made in
  // another tab (or on the phone) lands here without a reload.
  const { data: devices, error: devicesError } = useLiveList("devices", { enabled: isOwner });
  const { data: staff, error: staffListError } = useLiveList("staff", { enabled: isOwner });
  const { data: carts, error: cartsError } = useLiveList("carts", { enabled: isOwner });

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

  // -- REGISTER A STAFF CARD AT THE READER --
  // The owner opens a claim for a staff member, walks to that staff member's
  // cart and taps the card on the reader. The card is then enrolled on that
  // account, at that cart.
  const [cardStaff, setCardStaff] = useState(null);
  const [cardClaim, setCardClaim] = useState(null);
  const [cardSecondsLeft, setCardSecondsLeft] = useState(0);
  const [cardReaderOnline, setCardReaderOnline] = useState(false);
  const [cardError, setCardError] = useState("");
  const [cardDone, setCardDone] = useState("");
  const cardPollRef = useRef(null);
  const cardTickRef = useRef(null);

  // Never leave a poll running after the page goes away.
  useEffect(() => () => {
    if (cardPollRef.current) clearInterval(cardPollRef.current);
    if (cardTickRef.current) clearInterval(cardTickRef.current);
  }, []);

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

  // -- ADMIN STATES --
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminClosing, setAdminClosing] = useState(false);
  const [isAdminAdding, setIsAdminAdding] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminEditing, setAdminEditing] = useState(null);
  const [adminEditClosing, setAdminEditClosing] = useState(false);
  const [isAdminEditing, setIsAdminEditing] = useState(false);
  const [adminEditError, setAdminEditError] = useState("");
  const [showNewAdminPw, setShowNewAdminPw] = useState(false);
  const [newAdmin, setNewAdmin] = useState({
    name: "",
    username: "",
    password: "",
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
  function closeAdminAdd() {
    setAdminClosing(true);
    setTimeout(() => { setAdminOpen(false); setAdminClosing(false); }, 150);
  }
  function closeAdminEditModal() {
    setAdminEditClosing(true);
    setTimeout(() => { setAdminEditing(null); setAdminEditClosing(false); }, 150);
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
    adminOpen || adminClosing ||
    adminEditing || adminEditClosing ||
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

  useEffect(() => {
    if (emailCodeCooldown <= 0) return undefined;
    const timer = setTimeout(
      () => setEmailCodeCooldown((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [emailCodeCooldown]);

  function reloadStaff() {
    // A card is registered from the POS app at the cart, so this list goes
    // stale while the owner is sitting on this page. Refetch only the staff
    // list on a live event instead of reloading every owner table.
    invalidateLiveList("staff");
  }

  function reloadDevices() {
    invalidateLiveList("devices");
  }

  function reloadCarts() {
    invalidateLiveList("carts");
  }

  // Mounted here (not only in the shell) so a registration lands straight in
  // the card column of the table below.
  useRfidEvents({ onChange: reloadStaff });

  // The clock windows are set by the owner - here, on another tab or on
  // another browser. The form has to show the current windows, not the ones
  // it loaded with.
  useLiveEvent("settings:timeclock", () => {
    loadTimeClock();
  });

  function loadOwnerData(initial = false) {
    if (!isOwner) return;
    if (initial) setIsLoadingOwner(true);
    // The three owner lists (readers, staff accounts, carts) live in the
    // shared live store: they fetch themselves, are shared with every other
    // screen and refetch the moment the owner changes something.
    Promise.all([
      invalidateLiveList("devices"),
      invalidateLiveList("staff"),
      invalidateLiveList("carts"),
    ]).finally(() => {
      if (initial) setIsLoadingOwner(false);
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
    // A shift must start before it can end: the Time out window may not be
    // earlier than the Time in window.
    const scheduleError = timeClockScheduleError({
      inOpen,
      inClose,
      outOpen,
      outClose,
    });
    if (scheduleError) {
      setClockError(scheduleError);
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

  const missingDayNames = TIMECLOCK_ALL_DAYS.filter(
    (d) => !timeClock.days.includes(d),
  ).map((d) => DAY_FULL_NAMES[d] ?? String(d));
  const daysCaption =
    missingDayNames.length === 0
      ? "every day"
      : missingDayNames.length === 1
        ? `every day except ${missingDayNames[0]}`
        : `every day except ${missingDayNames.join(", ")}`;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional init: profile + catalog defaults on mount/role change
    loadProfile();
    loadTimeClock();
    loadOwnerData(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);

  // A list that could not be loaded is reported the same way as before.
  const ownerError = [
    devicesError ? "devices" : null,
    staffListError ? "staff" : null,
    cartsError ? "carts" : null,
  ].filter(Boolean);

  const isPlaceholderEmail = (value) =>
    !value || String(value).toLowerCase().endsWith("@cartiq.local");
  const hasRealEmail = Boolean(profile?.email && !isPlaceholderEmail(profile.email));
  // The recovery email the account has right now. Used to tell "you did not
  // change anything" apart from "you are changing it".
  const currentRecoveryEmail = String(profile?.email ?? "").trim().toLowerCase();
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
      code: "",
    });
    setEmailError("");
    setEmailCodeSent(false);
    setShowEmailPw(false);
    setEmailEditing(true);
  }

  async function sendEmailCode() {
    const cleanEmail = String(emailForm.email ?? "").trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes("@") || cleanEmail.endsWith("@cartiq.local")) {
      setEmailError("Enter a real email address first (not a placeholder).");
      return;
    }
    if (isSendingEmailCode || emailCodeCooldown > 0) return;
    // The address that is already the recovery email is not worth a code: the
    // server refuses to send one, and asking for it would only look broken.
    if (cleanEmail === currentRecoveryEmail) {
      setEmailCodeSent(false);
      setEmailError(
        "That is already your current recovery email. Type the new address first.",
      );
      return;
    }
    setEmailError("");
    setIsSendingEmailCode(true);
    try {
      const { data } = await api.post("/auth/me/email-otp", { email: cleanEmail });
      setEmailCodeSent(true);
      // The server allows one code per minute. Count it down so the button
      // cannot be spammed and the person knows when they can ask again.
      const seconds = data?.cooldown
        ? Math.ceil((data.retryAfterMs ?? 60000) / 1000)
        : 60;
      setEmailCodeCooldown(Math.max(0, seconds));
      toast(data?.message || "A code was sent to that email.", "success");
    } catch (err) {
      setEmailError(getFriendlyError(err, "Could not send the verification code."));
    } finally {
      setIsSendingEmailCode(false);
    }
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
    // The code proves you own the NEW inbox. When the address does not change
    // there is nothing to prove (the server agrees and returns the account
    // unchanged), so it is not asked for.
    if (
      cleanEmail !== currentRecoveryEmail &&
      !/^\d{6}$/.test(String(emailForm.code || "").trim())
    ) {
      setEmailError("Enter the 6-digit code sent to that email.");
      return;
    }
    setEmailError("");
    setIsSavingEmail(true);
    try {
      const { data } = await api.patch("/auth/me", {
        email: cleanEmail,
        currentPassword: emailForm.currentPassword,
        code: String(emailForm.code).trim(),
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
    if (!meetsPasswordStrength(pw.next, "good")) {
      setPwError(
        "New password must be at least 'Good' strength (8+ chars, upper/lower, number, special)."
      );
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
    const nameCheck = validatePersonName(newStaff.name);
    if (!nameCheck.ok) {
      setStaffError(nameCheck.error);
      return;
    }
    const usernameCheck = validateUsername(newStaff.username);
    if (!usernameCheck.ok) {
      setStaffError(usernameCheck.error);
      return;
    }
    if (!meetsPasswordStrength(newStaff.password, "fair")) {
      setStaffError(
        "Password must be at least 'Fair' strength (8+ chars and one more: upper/lower, number or special)."
      );
      return;
    }
    const emailCheck = validateEmail(newStaff.email);
    if (!emailCheck.ok) {
      setStaffError(emailCheck.error);
      return;
    }
    const rfidCheck = validateRfidUid(newStaff.rfidUid);
    if (!rfidCheck.ok) {
      setStaffError(rfidCheck.error);
      return;
    }
    setStaffError("");
    if (isStaffAdding) return;

    setIsStaffAdding(true);
    try {
      await api.post("/auth/staff", {
        name: nameCheck.value,
        username: usernameCheck.value,
        password: newStaff.password,
        locationCode: newStaff.locationCode,
        rfidUid: rfidCheck.value || null,
        email: emailCheck.value || null,
      });
      toast(`Staff account "${newStaff.username}" created`, "success");
      closeAddModal();
      setNewStaff({ name: "", username: "", password: "", locationCode: staffCartOptions[0]?.code || "", rfidUid: "", email: "" });
      setShowNewStaffPw(false);
      reloadStaff();
    } catch (err) {
      setStaffError(getFriendlyError(err, "Create failed - is the username or RFID already taken?"));
    } finally {
      setIsStaffAdding(false);
    }
  }

  // --- ADMIN ACTIONS ---
  async function createAdmin(e) {
    e.preventDefault();
    const nameCheck = validatePersonName(newAdmin.name);
    if (!nameCheck.ok) {
      setAdminError(nameCheck.error);
      return;
    }
    const usernameCheck = validateUsername(newAdmin.username);
    if (!usernameCheck.ok) {
      setAdminError(usernameCheck.error);
      return;
    }
    if (!meetsPasswordStrength(newAdmin.password, "fair")) {
      setAdminError(
        "Password must be at least 'Fair' strength (8+ chars and one more: upper/lower, number or special)."
      );
      return;
    }
    const emailCheck = validateEmail(newAdmin.email);
    if (!emailCheck.ok) {
      setAdminError(emailCheck.error);
      return;
    }
    setAdminError("");
    if (isAdminAdding) return;

    setIsAdminAdding(true);
    try {
      await api.post("/auth/staff", {
        name: nameCheck.value,
        username: usernameCheck.value,
        password: newAdmin.password,
        email: emailCheck.value || null,
        role: "OWNER",
      });
      toast(`Admin account "${newAdmin.username}" created`, "success");
      closeAdminAdd();
      setNewAdmin({ name: "", username: "", password: "", email: "" });
      setShowNewAdminPw(false);
      reloadStaff();
    } catch (err) {
      setAdminError(getFriendlyError(err, "Create failed - is the username already taken?"));
    } finally {
      setIsAdminAdding(false);
    }
  }

  function openEditAdmin(admin) {
    setAdminEditing({
      ...admin,
      email: isPlaceholderEmail(admin?.email) ? "" : admin?.email || "",
    });
    setAdminEditError("");
  }

  async function handleEditAdmin(e) {
    e.preventDefault();
    if (!adminEditing) return;
    const nameCheck = validatePersonName(adminEditing.name);
    if (!nameCheck.ok) {
      setAdminEditError(nameCheck.error);
      return;
    }
    const usernameCheck = validateUsername(adminEditing.username);
    if (!usernameCheck.ok) {
      setAdminEditError(usernameCheck.error);
      return;
    }
    const emailCheck = validateEmail(adminEditing.email);
    if (!emailCheck.ok) {
      setAdminEditError(emailCheck.error);
      return;
    }
    const cleanName = nameCheck.value;
    const cleanUsername = usernameCheck.value;
    setAdminEditError("");

    const original = staff.find((s) => s.id === adminEditing.id);
    const originalEmail = isPlaceholderEmail(original?.email) ? "" : original?.email || "";
    if (
      original &&
      cleanName === original.name &&
      cleanUsername === original.username &&
      emailCheck.value === originalEmail
    ) {
      toast("No changes - admin details are already up to date.", "info");
      closeAdminEditModal();
      return;
    }

    if (isAdminEditing) return;
    setIsAdminEditing(true);
    try {
      await api.patch(`/auth/staff/${adminEditing.id}`, {
        name: cleanName,
        username: cleanUsername,
        email: emailCheck.value || null,
      });
      toast(`Admin account "${cleanUsername}" updated`, "success");
      closeAdminEditModal();
      reloadStaff();
    } catch (err) {
      setAdminEditError(getFriendlyError(err, "Update failed - is the username or email already taken?"));
    } finally {
      setIsAdminEditing(false);
    }
  }

  // -- REGISTER A STAFF CARD AT THE READER --
  // The owner opens a claim FOR a staff member, walks to that staff member's
  // cart and taps the card on the reader. The cart is never picked here: a
  // card belongs to the cart where it is used, so it is the staff member's.
  function stopCardTimers() {
    if (cardPollRef.current) {
      clearInterval(cardPollRef.current);
      cardPollRef.current = null;
    }
    if (cardTickRef.current) {
      clearInterval(cardTickRef.current);
      cardTickRef.current = null;
    }
  }

  function closeCardModal() {
    stopCardTimers();
    setCardStaff(null);
    setCardClaim(null);
    setCardError("");
    setCardDone("");
    setCardSecondsLeft(0);
  }

  async function openRegisterCard(s) {
    setCardStaff(s);
    setCardError("");
    setCardDone("");
    setCardClaim(null);
    setCardSecondsLeft(0);
    if (!s.location?.code) {
      setCardError(
        `${s.name} has no cart yet - assign one first. A card belongs to the cart where it is used.`,
      );
      return;
    }
    try {
      const { data } = await api.post("/auth/my-rfid/claim", { targetUserId: s.id });
      const claim = data?.claim;
      setCardClaim(claim);
      setCardReaderOnline(claim?.deviceOnline !== false);
      setCardSecondsLeft(readerSecondsLeft(claim?.expiresAt));
      cardTickRef.current = setInterval(() => {
        setCardSecondsLeft((s2) => (s2 > 0 ? s2 - 1 : 0));
      }, 1000);
      cardPollRef.current = setInterval(() => pollCardClaim(claim.claimId), 1000);
    } catch (err) {
      setCardError(getFriendlyError(err, "Could not open the reader - try again."));
    }
  }

  async function pollCardClaim(claimId) {
    try {
      const { data } = await api.get(`/auth/my-rfid/claim/${encodeURIComponent(claimId)}`);
      const claim = data?.claim;
      if (!claim) return;
      setCardReaderOnline(claim.deviceOnline !== false);
      if (claim.status === "pending") return;
      stopCardTimers();
      if (claim.status === "bound") {
        setCardDone(`Card ${claim.rfidUid} registered to ${cardStaff?.name}.`);
        toast(`Card ${claim.rfidUid} registered to ${cardStaff?.name}`, "success");
        reloadStaff();
        return;
      }
      if (claim.status === "already_registered") {
        setCardError("This card is already registered.");
        return;
      }
      if (claim.status === "conflict") {
        setCardError(
          claim.holderName
            ? `That card already belongs to ${claim.holderName}.`
            : "That card already belongs to somebody else.",
        );
        return;
      }
      if (claim.status === "wrong_cart") {
        setCardError(
          claim.cardLocationCode
            ? `That card is registered at ${claim.cardLocationCode}.`
            : "That card belongs to another cart.",
        );
        return;
      }
      if (claim.status === "expired") {
        setCardError("No card tapped in time.");
        return;
      }
      setCardError("That tap was not registered.");
    } catch {
      // A flaky poll must not kill the flow: the next tick tries again.
    }
  }

  async function handleEditStaff(e) {
    e.preventDefault();
    setStaffError("");
    const nameCheck = validatePersonName(staffEditing?.name);
    if (!nameCheck.ok) {
      setStaffError(nameCheck.error);
      return;
    }
    const original = staff.find((s) => s.id === staffEditing.id);
    const emailCheck = validateEmail(staffEditing.email);
    if (!emailCheck.ok) {
      setStaffError(emailCheck.error);
      return;
    }
    const rfidCheck = validateRfidUid(staffEditing.rfidUid);
    if (!rfidCheck.ok) {
      setStaffError(rfidCheck.error);
      return;
    }
    if (
      original &&
      nameCheck.value === original.name &&
      (staffEditing.location?.code || null) === (original.location?.code || null) &&
      (rfidCheck.value || null) === (original.rfidUid || null) &&
      emailCheck.value === (original.email || "")
    ) {
      toast("No changes - staff details are already up to date.", "info");
      closeStaffEditModal();
      return;
    }

    setIsStaffEditing(true);
    try {
      await api.patch(`/auth/staff/${staffEditing.id}`, {
        name: nameCheck.value,
        locationCode: staffEditing.location?.code || null,
        rfidUid: rfidCheck.value || null,
        email: emailCheck.value || null
      });
      
      toast(`Staff account "${staffEditing.username}" updated`, "success");
      closeStaffEditModal();
      reloadStaff();
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
      reloadStaff();
    } catch (err) {
      toast(getFriendlyError(err, "Update failed"), "error");
    } finally {
      setIsDisabling(false);
    }
    setDisabling(null);
  }

  async function doResetPassword() {
    if (!resetting || isResetting) return;
    if (!meetsPasswordStrength(resetPw, "fair")) {
      setResetError(
        "New password must be at least 'Fair' strength (8+ chars and one more: upper/lower, number or special)."
      );
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
    const deviceCheck = validateDeviceId(newDevice.deviceId);
    if (!deviceCheck.ok) {
      setDeviceError(deviceCheck.error);
      return;
    }
    setIsDeviceAdding(true);
    try {
      const res = await api.post("/devices", {
        deviceId: deviceCheck.value,
        cart: newDevice.locationCode
      });
      closeDeviceAddModal();
      setNewDevice({ deviceId: "", locationCode: deviceCartOptions[0]?.code || "" });
      
      setDeviceToken({ deviceId: newDevice.deviceId, token: res.data?.deviceToken });
      setDeviceTokenCopied(false);

      toast(`Device ${newDevice.deviceId} registered`, "success");
      reloadDevices();
    } catch (err) {
      setDeviceError(getFriendlyError(err, "Registration failed. Device ID may already exist."));
    } finally {
      setIsDeviceAdding(false);
    }
  }

  const safeDevices = Array.isArray(devices) ? devices : [];
  const safeStaff = Array.isArray(staff) ? staff : [];
  const safeAdmins = safeStaff.filter((s) => s.role === "OWNER");
  const currentUserId = profile?.id ?? user?.id ?? null;
  // A deactivated cart cannot be assigned to a reader or a staff member any
  // more, so it disappears from the dropdowns. The cart that is currently
  // chosen stays, so an open form never loses its value.
  const staffCartOptions = activeCarts(carts, newStaff.locationCode);
  const deviceCartOptions = activeCarts(carts, newDevice.locationCode);
  const editingCartOptions = activeCarts(carts, staffEditing?.locationCode);
  // The reader being edited may sit on a cart that was deactivated after the
  // assignment: that cart stays in its dropdown, so the form shows what is
  // really assigned and saving does not silently move it.
  const editingDeviceCartOptions = activeCarts(carts, deviceEditing?.cart);
  const locationOptions = staffCartOptions.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }));
  const deviceLocationOptions = deviceCartOptions.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }));
  const editingLocationOptions = editingCartOptions.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }));
  const editingDeviceLocationOptions = editingDeviceCartOptions.map((l) => ({ value: l.code, label: `${l.code} - ${l.name}` }));

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
      reloadDevices();
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
      reloadDevices();
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
      reloadCarts();
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
      reloadCarts();
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
      reloadCarts();
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
            <section className="panel timeclock-panel">
              <div className="timeclock-head">
                <div className="timeclock-head-copy">
                  <div className="timeclock-title-row">
                    <h3 className="timeclock-title">Time clock</h3>
                    <span className={`timeclock-state ${timeClock.enabled ? "is-on" : "is-off"}`}>
                      <span className="timeclock-state-dot" aria-hidden="true" />
                      {timeClock.enabled ? "On" : "Off"}
                    </span>
                  </div>
                  <p className="timeclock-subtitle">
                    Set when the Time in and Time out buttons can be tapped. Manila time.
                  </p>
                </div>
              </div>

              <form onSubmit={saveTimeClock} className="timeclock-form">
                <button
                  type="button"
                  role="switch"
                  aria-checked={timeClock.enabled}
                  aria-labelledby="timeclock-master-title"
                  aria-describedby="timeclock-master-hint"
                  id="timeclock-enabled-switch"
                  className={`timeclock-master ${timeClock.enabled ? "is-on" : "is-off"}`}
                  onClick={() => setTimeClock({ ...timeClock, enabled: !timeClock.enabled })}
                >
                  <span className="timeclock-master-icon" aria-hidden="true">
                    <Power size={19} />
                  </span>
                  <span className="timeclock-master-copy">
                    <strong className="timeclock-master-title" id="timeclock-master-title">
                      Schedule is {timeClock.enabled ? "ON" : "OFF"}
                    </strong>
                    <span className="timeclock-master-hint" id="timeclock-master-hint">
                      {timeClock.enabled
                        ? "Time in and Time out only work inside the selling days and windows below."
                        : "Both buttons always work. Turn the schedule ON to limit them to the days and times below."}
                    </span>
                  </span>
                  <span className="timeclock-toggle" aria-hidden="true">
                    <span className="timeclock-toggle-label">
                      {timeClock.enabled ? "ON" : "OFF"}
                    </span>
                    <span className="timeclock-toggle-knob" />
                  </span>
                </button>

                <div className="timeclock-windows">
                  {[
                    {
                      key: "in",
                      label: "Time in",
                      icon: <LogIn size={17} aria-hidden="true" />,
                      open: timeClock.inOpen,
                      close: timeClock.inClose,
                      onOpen: (v) => setTimeClock({ ...timeClock, inOpen: v }),
                      onClose: (v) => setTimeClock({ ...timeClock, inClose: v }),
                      prefixOpen: "timeclock-in-open",
                      prefixClose: "timeclock-in-close",
                      labelOpen: "Time in opens",
                      labelClose: "Time in closes",
                    },
                    {
                      key: "out",
                      label: "Time out",
                      icon: <LogOut size={17} aria-hidden="true" />,
                      open: timeClock.outOpen,
                      close: timeClock.outClose,
                      onOpen: (v) => setTimeClock({ ...timeClock, outOpen: v }),
                      onClose: (v) => setTimeClock({ ...timeClock, outClose: v }),
                      prefixOpen: "timeclock-out-open",
                      prefixClose: "timeclock-out-close",
                      labelOpen: "Time out opens",
                      labelClose: "Time out closes",
                    },
                  ].map((row) => {
                    const openMinutes = hmToMinutes(row.open);
                    const closeMinutes = hmToMinutes(row.close);
                    const duration =
                      Number.isFinite(openMinutes) &&
                      Number.isFinite(closeMinutes) &&
                      closeMinutes > openMinutes
                        ? formatDuration(closeMinutes - openMinutes)
                        : null;
                    return (
                      <div
                        key={row.key}
                        className={`timeclock-window ${timeClock.enabled ? "" : "is-disabled"}`}
                      >
                        <div className="timeclock-window-head">
                          <span className="timeclock-window-icon">{row.icon}</span>
                          <span className="timeclock-window-title">{row.label}</span>
                          {duration && (
                            <span className="timeclock-window-duration">{duration} window</span>
                          )}
                        </div>
                        <div className="timeclock-window-times">
                          <TimeField12h
                            prefix={row.prefixOpen}
                            label={row.labelOpen}
                            caption="Opens"
                            value={row.open}
                            onChange={row.onOpen}
                            disabled={!timeClock.enabled}
                          />
                          <span className="timeclock-arrow" aria-hidden="true">
                            <ArrowRight size={15} />
                          </span>
                          <TimeField12h
                            prefix={row.prefixClose}
                            label={row.labelClose}
                            caption="Closes"
                            value={row.close}
                            onChange={row.onClose}
                            disabled={!timeClock.enabled}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="timeclock-days">
                  <div className="timeclock-days-head">
                    <span className="timeclock-days-title">
                      <CalendarDays size={15} aria-hidden="true" />
                      Selling days
                    </span>
                    <span className="timeclock-days-count">
                      {timeClock.days.length} of 7 days
                    </span>
                  </div>
                  <p className="timeclock-days-hint">
                    Unchecked days keep both buttons closed the whole day.
                  </p>
                  <div className="timeclock-day-row">
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
                          className={`timeclock-day ${active ? "is-active" : ""}`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {clockError && (
                  <p className="error-box timeclock-error" role="alert">{clockError}</p>
                )}

                <div className="timeclock-footer">
                  <div className="timeclock-summary">
                    <span className="timeclock-summary-icon" aria-hidden="true">
                      <Clock size={15} />
                    </span>
                    <div className="timeclock-summary-copy">
                      <span className="timeclock-summary-label">Current schedule</span>
                      <p className="timeclock-summary-text">
                        {timeClock.enabled ? (
                          <>
                            Buttons open <strong>{daysCaption}</strong>: Time in{" "}
                            <strong>{format12h(timeClock.inOpen)}–{format12h(timeClock.inClose)}</strong>{" "}
                            · Time out{" "}
                            <strong>{format12h(timeClock.outOpen)}–{format12h(timeClock.outClose)}</strong>.
                          </>
                        ) : (
                          "Schedule is OFF — both buttons always work (current behavior)."
                        )}
                      </p>
                    </div>
                  </div>
                  <button type="submit" className="timeclock-save" disabled={clockSaving || clockLoading}>
                    <Save size={14} aria-hidden="true" /> {clockSaving ? "Saving..." : "Save"}
                  </button>
                </div>
              </form>
            </section>

            {/* IOT DEVICE REGISTRY */}
            <section className="panel" style={{ padding: "var(--space-5)" }}>
              <div className="settings-table-heading">
                <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>IoT device registry</h3>
                <div className="flex items-center gap-2">
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
                                {d.active ? (d.online ? "ONLINE" : "INACTIVE") : "DISABLED"}
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

            {/* ADMINISTRATORS */}
            <section className="panel" style={{ padding: "var(--space-5)" }}>
              <div className="settings-table-heading">
                <div>
                  <h3 className="section-title m-0 p-0" style={{ borderBottom: "none" }}>Administrators</h3>
                  <p className="muted small" style={{ margin: "var(--space-1) 0 0" }}>
                    Owner-level accounts. They have full access to Settings, staff, and the POS.
                  </p>
                </div>
                <button onClick={() => { setAdminError(""); setAdminOpen(true); setShowNewAdminPw(false); }}>
                  <Plus size={15} /> Add admin
                </button>
              </div>

              {isLoadingOwner ? (
                <TableSkeleton
                  className="settings-table-wrap"
                  tableClassName="settings-table settings-table-admins"
                  rows={2}
                  columns={[
                    { key: "name", label: "Name" },
                    { key: "username", label: "Username", className: "settings-hide-narrow" },
                    { key: "email", label: "Recovery email" },
                    { key: "status", label: "Status", className: "settings-indicator-heading", skeletonType: "badge" },
                    { key: "actions", label: "Actions", align: "center" },
                  ]}
                />
              ) : safeAdmins.length === 0 ? (
                <EmptyState
                  icon={ShieldCheck}
                  title="No other administrators"
                  subtitle="Add an owner-level account to share administration with someone else."
                  compact
                />
              ) : (
                <div className="table-wrap settings-table-wrap">
                  <table className="data table-fixed settings-table settings-table-admins">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th className="settings-hide-narrow">Username</th>
                        <th>Recovery email</th>
                        <th className="settings-indicator-heading">Status</th>
                        <th className="t-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {safeAdmins.map((a) => {
                        const isSelf = currentUserId != null && a.id === currentUserId;
                        return (
                          <tr key={a.id} className={!a.active ? "row-disabled" : undefined}>
                            <td>
                              <strong>{a.name}</strong>
                              {isSelf && <Badge variant="info" style={{ marginLeft: 6 }}>You</Badge>}
                            </td>
                            <td className="settings-hide-narrow">{a.username}</td>
                            <td className="muted small">
                              <span className="settings-email-cell">
                                <span>
                                  {a.email && !String(a.email).toLowerCase().endsWith("@cartiq.local")
                                    ? a.email
                                    : `${a.username}@cartiq.local`}
                                </span>
                                {(!a.email || String(a.email).toLowerCase().endsWith("@cartiq.local")) && (
                                  <Badge variant="warn">Placeholder</Badge>
                                )}
                              </span>
                            </td>
                            <td className="settings-indicator-cell">
                              <span className="settings-indicator">
                                <Badge variant={a.active ? "ok" : "danger"}>
                                  {a.active ? "ACTIVE" : "DISABLED"}
                                </Badge>
                              </span>
                            </td>
                            <td className="t-center settings-actions-cell">
                              {isSelf ? (
                                <span className="muted small" title="Use Settings > Change password for your own account">
                                  —
                                </span>
                              ) : (
                                <div className="settings-table-actions">
                                  <button
                                    className="ghost small-btn"
                                    onClick={() => openEditAdmin(a)}
                                    disabled={!a.active}
                                    title={a.active ? "Edit admin" : "Enable the account before editing"}
                                  >
                                    <Edit2 size={13} />
                                  </button>
                                  <button
                                    className="ghost small-btn"
                                    onClick={() => {
                                      setResetting(a);
                                      setResetPw("");
                                      setResetError("");
                                      setShowResetPw(false);
                                    }}
                                    disabled={!a.active}
                                    title={a.active ? "Reset Password" : "Enable the account before resetting password"}
                                  >
                                    <KeyRound size={13} />
                                  </button>
                                  <button
                                    className={`small-btn ${a.active ? "danger-ghost" : "ghost"}`}
                                    onClick={() => setDisabling(a)}
                                    title={a.active ? "Disable" : "Enable"}
                                  >
                                    {a.active ? "Disable" : "Enable"}
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
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
                          <td className="muted small settings-hide-narrow">
                            {s.rfidUid ? (
                              <>
                                {s.rfidUid}
                                {s.rfidLocationCode ? ` · ${s.rfidLocationCode}` : ""}
                              </>
                            ) : (
                              "-"
                            )}
                          </td>
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
                                disabled={!s.active}
                                title={s.active ? "Edit Staff Details" : "Enable the account before editing"}
                              >
                                <Edit2 size={13} />
                              </button>
                              <button
                                className="ghost small-btn"
                                onClick={() => openRegisterCard(s)}
                                disabled={!s.active}
                                title={
                                  s.active
                                    ? "Register a card for this staff member at their cart"
                                    : "Enable the account first"
                                }
                              >
                                <Nfc size={13} />
                              </button>
                              <button
                                className="ghost small-btn"
                                onClick={() => {
                                  setResetting(s);
                                  setResetPw("");
                                  setResetError("");
                                  setShowResetPw(false);
                                }}
                                disabled={!s.active}
                                title={s.active ? "Reset Password" : "Enable the account before resetting password"}
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
                                  {c.device.online ? "ONLINE" : "INACTIVE"}
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
                                disabled={c.status === "INACTIVE"}
                                title={c.status === "INACTIVE" ? "Activate the cart before renaming" : "Rename cart"}
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
                    onChange={(e) => {
                      setEmailForm({ ...emailForm, email: e.target.value });
                      setEmailCodeSent(false);
                    }}
                    style={{ height: "36px" }}
                  />
                </label>
                <label className="field">
                  Verification code
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <input
                      required
                      value={emailForm.code}
                      onChange={(e) => setEmailForm({ ...emailForm, code: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit code"
                      maxLength={6}
                      style={{ height: "36px", flex: 1 }}
                    />
                    <button
                      type="button"
                      className="ghost small-btn"
                      onClick={sendEmailCode}
                      disabled={isSendingEmailCode || isSavingEmail || emailCodeCooldown > 0}
                      style={{ height: "36px" }}
                    >
                      {isSendingEmailCode
                        ? "Sending..."
                        : emailCodeCooldown > 0
                          ? `Resend in ${emailCodeCooldown}s`
                          : emailCodeSent
                            ? "Resend code"
                            : "Send code"}
                    </button>
                  </div>
                  <span className="muted small">
                    {emailCodeCooldown > 0
                      ? `A code was sent to ${emailForm.email}. You can ask for another one in ${emailCodeCooldown}s. It expires in 10 minutes and can only be used once.`
                      : emailCodeSent
                        ? "Code sent. It expires in 10 minutes and can only be used once."
                        : "Click Send code to get a code for this new email."}
                  </span>
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
                </label>                <label className="field">
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

        {/* ADD ADMIN MODAL */}
        {(adminOpen || adminClosing) && (
          <div className={`modal-backdrop ${adminClosing ? "is-closing" : ""}`}>
            <div className={`modal ${adminClosing ? "is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
              <h3><ShieldCheck size={22} className="muted" /> Add admin account</h3>
              <p className="muted" style={{ marginBottom: "20px", lineHeight: "1.4" }}>
                Full owner-level access: Settings, staff, devices, products, and carts. Share the sign-in privately.
              </p>
              <form onSubmit={createAdmin} className="flex flex-col gap-3">
                <label className="field">
                  Full name *
                  <input
                    required
                    value={newAdmin.name}
                    onChange={(e) => setNewAdmin({ ...newAdmin, name: e.target.value })}
                    style={{ height: "36px" }}
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  Username *
                  <input
                    required
                    value={newAdmin.username}
                    onChange={(e) => setNewAdmin({ ...newAdmin, username: e.target.value })}
                    style={{ height: "36px" }}
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  Password * (min 8)
                  <div style={{ position: "relative" }}>
                    <input
                      required
                      minLength={8}
                      type={showNewAdminPw ? "text" : "password"}
                      value={newAdmin.password}
                      onChange={(e) => setNewAdmin({ ...newAdmin, password: e.target.value })}
                      autoComplete="new-password"
                      style={{ height: "36px", width: "100%", paddingRight: "36px" }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewAdminPw(!showNewAdminPw)}
                      style={toggleBtnStyle}
                      aria-label={showNewAdminPw ? "Hide password" : "Show password"}
                    >
                      {showNewAdminPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <PasswordStrengthMeter value={newAdmin.password} minLevel="fair" />
                </label>
                <label className="field">
                  Recovery email (optional — lets them reset their own password)
                  <input
                    type="email"
                    placeholder="owner@example.com"
                    value={newAdmin.email}
                    onChange={(e) => setNewAdmin({ ...newAdmin, email: e.target.value })}
                    autoComplete="email"
                    style={{ height: "36px" }}
                  />
                </label>

                <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
                  <button type="button" className="ghost" onClick={closeAdminAdd} disabled={adminClosing}>
                    Cancel
                  </button>
                  <button type="submit" disabled={adminClosing || isAdminAdding}>
                    {isAdminAdding ? "Creating..." : "Create account"}
                  </button>
                </div>
                {adminError && <p className="error-box" role="alert">{adminError}</p>}
              </form>
            </div>
          </div>
        )}

        {/* EDIT ADMIN MODAL */}
        {(adminEditing || adminEditClosing) && (
          <div className={`modal-backdrop ${adminEditClosing ? "is-closing" : ""}`}>
            <div className={`modal ${adminEditClosing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-label="Edit admin account" onClick={(e) => e.stopPropagation()}>
              <h3><Edit2 size={22} className="muted" /> Edit admin account</h3>
              <form onSubmit={handleEditAdmin} className="flex flex-col gap-3" style={{ marginTop: "var(--space-3)" }}>
                <label className="field">
                  Full name *
                  <input
                    required
                    value={adminEditing?.name || ""}
                    onChange={(e) => setAdminEditing({ ...adminEditing, name: e.target.value })}
                    style={{ height: "36px" }}
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  Username *
                  <input
                    required
                    value={adminEditing?.username || ""}
                    onChange={(e) => setAdminEditing({ ...adminEditing, username: e.target.value })}
                    style={{ height: "36px" }}
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  Recovery email (optional — lets them reset their own password)
                  <input
                    type="email"
                    placeholder={`${adminEditing?.username || "admin"}@cartiq.local`}
                    value={adminEditing?.email || ""}
                    onChange={(e) => setAdminEditing({ ...adminEditing, email: e.target.value })}
                    autoComplete="email"
                    style={{ height: "36px" }}
                  />
                </label>

                <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
                  <button type="button" className="ghost" onClick={closeAdminEditModal} disabled={isAdminEditing || adminEditClosing}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isAdminEditing || adminEditClosing}>
                    {isAdminEditing ? "Saving..." : "Save Changes"}
                  </button>
                </div>
                {adminEditError && <p className="error-box" role="alert">{adminEditError}</p>}
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
                    options={editingLocationOptions}
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
                  <span className="muted small">
                    The owner sets or changes a staff card here - the staff member cannot do it
                    in the app. A card only works at the cart it is registered on
                    {staffEditing?.rfidLocationCode ? ` (${staffEditing.rfidLocationCode})` : ""}.
                    You can also register it at the reader with the contactless button in the
                    staff list.
                  </span>
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

        {/* REGISTER A STAFF CARD AT THE READER */}
        {cardStaff && (
          <div className="modal-backdrop">
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Register a card for {cardStaff.name}</h3>

              <p className="muted" style={{ marginTop: "var(--space-2)" }}>
                Walk to <strong>{cardStaff.location?.code ?? "their cart"}</strong> and tap the
                staff card on the reader. The card is registered on this account and only
                works at that cart.
              </p>

              {!cardDone && cardClaim && (
                <div
                  className="info-box"
                  style={{ marginTop: "var(--space-3)", display: "flex", alignItems: "center", gap: "10px" }}
                >
                  <Nfc size={18} />
                  <span>
                    {cardReaderOnline
                      ? "Reader online - waiting for the card..."
                      : "Connecting to the reader..."}
                  </span>
                  <strong style={{ marginLeft: "auto" }}>{cardSecondsLeft}s</strong>
                </div>
              )}

              {cardDone && (
                <div className="success-box" style={{ marginTop: "var(--space-3)" }} role="status">
                  {cardDone}
                </div>
              )}
              {cardError && (
                <p className="error-box" role="alert" style={{ marginTop: "var(--space-3)" }}>
                  {cardError}
                </p>
              )}

              <div className="modal-actions" style={{ marginTop: "var(--space-3)" }}>
                <button type="button" className="ghost" onClick={closeCardModal}>
                  Close
                </button>
                {!cardDone && (
                  <button
                    type="button"
                    onClick={() => {
                      closeCardModal();
                      openRegisterCard(cardStaff);
                    }}
                  >
                    Try again
                  </button>
                )}
              </div>
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
              ? `"${disabling?.username}" will no longer be able to log in. Their data is kept.`
              : `"${disabling?.username}" will regain access immediately.`
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
                    options={deviceLocationOptions}
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
                    options={editingDeviceLocationOptions}
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