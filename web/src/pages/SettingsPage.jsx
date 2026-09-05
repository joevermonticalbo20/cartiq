import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { KeyRound, Plus, RefreshCw } from "lucide-react";
import api from "../api.js";
import Badge from "../components/Badge.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import Skeleton from "../components/Skeleton.jsx";
import PageErrorBoundary from "../components/PageErrorBoundary.jsx";
import PasswordStrengthMeter from "../components/PasswordStrengthMeter.jsx";
import { useToast } from "../components/Toast.jsx";

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
      toast("New passwords do not match", "error");
      return;
    }
    if (pw.next.length < 8) {
      toast("New password must be at least 8 characters", "error");
      return;
    }
    try {
      await api.post("/auth/change-password", {
        currentPassword: pw.current,
        newPassword: pw.next,
      });
      toast("Password updated successfully", "success");
      setPw({ current: "", next: "", confirm: "" });
    } catch (err) {
      toast(err.response?.data?.error || "Change failed", "error");
    }
  }

  async function createStaff(e) {
    e.preventDefault();
    if (newStaff.password.length < 8) {
      toast("Password must be at least 8 characters", "error");
      return;
    }
    try {
      await api.post("/auth/staff", {
        ...newStaff,
        rfidUid: newStaff.rfidUid || null,
      });
      toast(`Staff account "${newStaff.username}" created`, "success");
      setAddOpen(false);
      setNewStaff({ name: "", username: "", password: "", locationCode: "CART-01", rfidUid: "" });
      loadOwnerData();
    } catch (err) {
      toast(err.response?.data?.error || "Create failed", "error");
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
      toast("New password must be at least 8 characters", "error");
      return;
    }
    try {
      await api.patch(`/auth/staff/${resetting.id}`, { password: resetPw });
      toast(`Password reset for ${resetting.username}`, "success");
      setResetting(null);
      setResetPw("");
    } catch (err) {
      toast(err.response?.data?.error || "Reset failed", "error");
    }
  }

  return (
    <PageErrorBoundary>
    <div className="page-container">
      <div className="settings-grid">
        <section className="panel">
          <h3 className="section-title">Profile</h3>
          {!profile ? (
            <Skeleton rows={3} />
          ) : (
            <>
              <table className="data">
                <tbody>
                  <tr><td className="muted">Name</td><td><strong>{profile.name}</strong></td></tr>
                  <tr><td className="muted">Username</td><td>{profile.username}</td></tr>
                  <tr>
                    <td className="muted">Role</td>
                      <td><Badge variant="brand">{profile.role}</Badge></td>
                  </tr>
                  <tr>
                    <td className="muted">Cart assignment</td>
                    <td>{profile.location ? `${profile.location.code} - ${profile.location.name}` : "All carts"}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </section>

        <section className="panel">
          <h3 className="section-title">Change password</h3>
          <form onSubmit={changePassword} className="flex flex-col gap-3" style={{ marginTop: "var(--space-2)" }}>
            <label className="field">
              Current password
              <input
                type="password"
                value={pw.current}
                onChange={(e) => setPw({ ...pw, current: e.target.value })}
                required
              />
            </label>
            <label className="field">
              New password (min 8 chars)
              <input
                type="password"
                value={pw.next}
                onChange={(e) => setPw({ ...pw, next: e.target.value })}
                required
                minLength={8}
              />
              <PasswordStrengthMeter value={pw.next} minLevel="good" />
            </label>
            <label className="field">
              Confirm new password
              <input
                type="password"
                value={pw.confirm}
                onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
                required
              />
            </label>
            <button type="submit" className="self-start">
              <KeyRound size={15} /> Update password
            </button>
          </form>
        </section>
      </div>

      {!isOwner && (
        <p className="muted small">
          Staff management and device registry are visible to OWNER accounts only.
        </p>
      )}

      {isOwner && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h3 className="section-title">IoT device registry</h3>
              <button className="ghost small-btn" onClick={loadOwnerData}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Cart</th>
                    <th>Status</th>
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
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: "var(--space-2)" }}>
              ONLINE = heard from the node in the last 5 minutes. Run
              iot/simulator.mjs to bring nodes online.
            </p>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3 className="section-title">Staff accounts</h3>
              <button onClick={() => setAddOpen(true)}>
                <Plus size={15} /> Add staff
              </button>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Cart</th>
                    <th>RFID UID</th>
                    <th>Status</th>
                    <th className="t-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((s) => (
                    <tr key={s.id} className={!s.active ? "row-disabled" : undefined}>
                      <td><strong>{s.name}</strong></td>
                      <td>{s.username}</td>
                      <td><Badge variant={s.role === "OWNER" ? "brand" : "neutral"}>{s.role}</Badge></td>
                      <td>{s.location ? s.location.code : "-"}</td>
                      <td className="muted small">{s.rfidUid ?? "-"}</td>
                      <td>
                        <Badge variant={s.active ? "ok" : "danger"}>
                          {s.active ? "ACTIVE" : "DISABLED"}
                        </Badge>
                      </td>
                      <td className="t-right nowrap">
                        {s.role !== "OWNER" && (
                          <>
                            <button
                              className="ghost small-btn"
                              onClick={() => {
                                setResetting(s);
                                setResetPw("");
                              }}
                            >
                              Reset password
                            </button>{" "}
                            <button
                              className={`small-btn ${s.active ? "danger-ghost" : "ghost"}`}
                              onClick={() => setDisabling(s)}
                            >
                              {s.active ? "Disable" : "Enable"}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* Add staff modal */}
      {addOpen && (
        <div className="modal-backdrop" onClick={() => setAddOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add staff account</h3>
            <form onSubmit={createStaff} className="flex flex-col gap-3" style={{ marginTop: "var(--space-2)" }}>
              <label className="field">
                Full name *
                <input
                  required
                  value={newStaff.name}
                  onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
                />
              </label>
              <label className="field">
                Username *
                <input
                  required
                  value={newStaff.username}
                  onChange={(e) => setNewStaff({ ...newStaff, username: e.target.value })}
                />
              </label>
              <label className="field">
                Password * (min 8)
                <input
                  required
                  minLength={8}
                  type="password"
                  value={newStaff.password}
                  onChange={(e) => setNewStaff({ ...newStaff, password: e.target.value })}
                />
                <PasswordStrengthMeter value={newStaff.password} minLevel="fair" />
              </label>
              <label className="field">
                Cart assignment
                <select
                  value={newStaff.locationCode}
                  onChange={(e) => setNewStaff({ ...newStaff, locationCode: e.target.value })}
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.code}>{l.code} - {l.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                RFID UID (optional)
                <input
                  placeholder="e.g. 04A2B3C4"
                  value={newStaff.rfidUid}
                  onChange={(e) => setNewStaff({ ...newStaff, rfidUid: e.target.value })}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={() => setAddOpen(false)}>
                  Cancel
                </button>
                <button type="submit">Create account</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset password modal */}
      {resetting && (
        <div className="modal-backdrop" onClick={() => setResetting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset password - {resetting.username}</h3>
            <label className="field" style={{ marginTop: "var(--space-2)" }}>
              New temporary password
              <input
                autoFocus
                type="text"
                value={resetPw}
                onChange={(e) => setResetPw(e.target.value)}
                placeholder="min 8 characters"
              />
              <PasswordStrengthMeter value={resetPw} minLevel="fair" />
            </label>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setResetting(null)}>Cancel</button>
              <button onClick={doResetPassword}>Save new password</button>
            </div>
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
